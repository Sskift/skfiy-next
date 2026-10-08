import AppKit
import ApplicationServices
import Foundation

/// Finding a control by what it is instead of where it was: a `target`
/// (name, kind, area, container, neighbors) is resolved against the UI as it
/// is at that moment — accessibility while unlocked, recognized text and its
/// layout while locked — so a button that moved is still found. When several
/// things fit equally, they are listed and nothing is chosen.
extension ComputerUse {
    /// Tools that accept `target` instead of element_index or x/y.
    nonisolated static let targetTools: Set<String> = ["click", "scroll", "set_value", "perform_secondary_action", "select_text"]

    /// One thing on screen a locator may mean, and how to act on it.
    struct Located {
        var candidate: LocatorCandidate
        var element: AXUIElement?
        /// Where it is in the latest screenshot, when that still maps.
        var pixel: CGPoint?
    }

    /// What locating saw: the window, every candidate, and the matches.
    struct LocateView {
        var window: String
        var bounds: CGRect
        var items: [Located]
        var geometry: CaptureGeometry?
        /// Text recognized from pixels, not read from accessibility.
        var recognized: Bool
        var screenshot: ToolResult?
    }

    // MARK: - Reading the UI now

    /// The window's elements with a frame and something to call them by,
    /// with the labels of the groups they sit in.
    static func axCandidates(in window: AXUIElement, budget: Int = 4000) -> [(LocatorCandidate, AXUIElement)] {
        let containerRoles: Set<String> = ["AXGroup", "AXSheet", "AXTabGroup", "AXSplitGroup", "AXScrollArea", "AXRadioGroup", "AXList",
                                           "AXTable", "AXOutline", "AXToolbar", "AXWebArea", "AXLayoutArea", "AXDrawer", "AXPopover", "AXForm",
                                           "AXLandmarkMain", "AXDialog"]
        let textRoles: Set<String> = ["AXStaticText", "AXHeading"]
        var out: [(LocatorCandidate, AXUIElement)] = []
        var stack: [(AXUIElement, [String])] = [(window, [])]
        var visited = 0
        while let (element, containers) = stack.popLast(), visited < budget {
            visited += 1
            let values = element.multipleValues([kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                                                 kAXPlaceholderValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
                                                 kAXTitleUIElementAttribute])
            let role = values[kAXRoleAttribute].flatMap(axString) ?? ""
            let titleElement = axElement(values[kAXTitleUIElementAttribute])
            let label = nonEmpty(values[kAXTitleAttribute].flatMap(axString))
                ?? nonEmpty(values[kAXDescriptionAttribute].flatMap(axString))
                ?? (textRoles.contains(role) ? nonEmpty(values[kAXValueAttribute].flatMap(axString)) : nil)
                ?? nonEmpty(titleElement.flatMap { $0.string(kAXValueAttribute) ?? $0.string(kAXTitleAttribute) })
                ?? nonEmpty(values[kAXPlaceholderValueAttribute].flatMap(axString))
            if !CFEqual(element, window), let frame = axFrame(position: values[kAXPositionAttribute], size: values[kAXSizeAttribute]),
               frame.width >= 1, frame.height >= 1, label != nil || Locator.roleAliases["text field"]!.contains(role) {
                out.append((LocatorCandidate(label: label ?? "", role: role, frame: frame, containers: containers), element))
            }
            let inner = containerRoles.contains(role) && label != nil ? [label!] + containers : containers
            let children = (values[kAXChildrenAttribute] as? [AXUIElement]) ?? []
            stack.append(contentsOf: children.reversed().map { ($0, inner) })
        }
        return out
    }

    /// The window the latest get_app_state showed (or the focused one), read
    /// again now. Recognized text joins in when `withText` or when the window
    /// publishes nothing to accessibility.
    func locateView(app: NSRunningApplication, withText: Bool) async throws -> LocateView {
        try requireAccessibility()
        guard !isScreenLocked() else {
            throw ToolError("The screen is locked, so app windows cannot be read. Try again after it is unlocked.")
        }
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 2)
        let session = sessions[pid]
        let windows = appElement.elements(kAXWindowsAttribute).filter { $0.string(kAXRoleAttribute) == kAXWindowRole }
        let window: AXUIElement
        if let id = session?.windowID {
            guard let shown = windows.first(where: { windowID(of: $0) == id }) else {
                throw ToolError("The window of the latest get_app_state (id \(id)) closed. Call get_app_state again; nothing was done.")
            }
            window = shown
        } else if let shown = session?.window {
            window = shown
        } else if let focused = appElement.element(kAXFocusedWindowAttribute) ?? appElement.element(kAXMainWindowAttribute) ?? windows.first {
            window = focused
        } else {
            throw ToolError("\(app.localizedName ?? "The app") has no window to look in.")
        }
        guard let bounds = window.frame else { throw ToolError("The window has no frame on screen.") }
        let title = window.string(kAXTitleAttribute) ?? ""
        let unmoved = session?.windowFrame.map { abs($0.minX - bounds.minX) < 1 && abs($0.minY - bounds.minY) < 1 && abs($0.width - bounds.width) < 1 && abs($0.height - bounds.height) < 1 } ?? true
        let geometry = unmoved ? session?.geometry : nil
        let pixel = { (frame: CGRect) -> CGPoint? in
            guard let geometry else { return nil }
            let point = geometry.toPixels(CGPoint(x: frame.midX, y: frame.midY))
            return geometry.containsPixel(x: point.x, y: point.y) ? point : nil
        }
        var items = Self.axCandidates(in: window).map { Located(candidate: $0.0, element: $0.1, pixel: pixel($0.0.frame)) }
        let chrome: Set<String> = ["AXButton", "AXStaticText"]
        let content = items.filter { !($0.candidate.frame.minY < bounds.minY + 30 && chrome.contains($0.candidate.role) && $0.candidate.label.count < 3) }
        var recognized = false
        if withText || content.count < 2, let region = appRegion(pid: pid, focusedWindow: bounds),
           let lines = try? await recognizeText(pid: pid, region: region.intersection(bounds)) {
            let ax = items.map(\.candidate)
            for line in lines {
                let center = CGPoint(x: line.frame.midX, y: line.frame.midY)
                // Text an element already names is that element.
                if ax.contains(where: { $0.frame.contains(center) && (Locator.textScore($0.label, line.text) != nil || Locator.textScore(line.text, $0.label) != nil) }) { continue }
                items.append(Located(candidate: LocatorCandidate(label: line.text, role: "text", frame: line.frame, roleKnown: false), element: nil, pixel: pixel(line.frame)))
                recognized = true
            }
        }
        return LocateView(window: "\(quote(title, limit: 80))" + (windowID(of: window).map { " (id \($0))" } ?? ""), bounds: bounds,
                          items: Self.joiningText(items, pixel: pixel), geometry: geometry, recognized: recognized)
    }

    /// Recognized text, plus neighbouring pieces on a row joined.
    static func joiningText(_ items: [Located], pixel: (CGRect) -> CGPoint?) -> [Located] {
        let joined = Locator.joiningRows(items.filter { !$0.candidate.roleKnown }.map(\.candidate)).filter { candidate in
            !items.contains { $0.candidate == candidate }
        }
        return items + joined.map { Located(candidate: $0, element: nil, pixel: pixel($0.frame)) }
    }

    // MARK: - Matching

    struct LocateOutcome {
        var view: LocateView
        var matches: [(LocatorMatch, Located)]
        var chosen: (LocatorMatch, Located)?
        /// Name/kind matches elsewhere, when the narrowing parts excluded all.
        var elsewhere: [(LocatorMatch, Located)]
    }

    static func match(_ locator: Locator, in view: LocateView) -> LocateOutcome {
        let candidates = view.items.map(\.candidate)
        let pixelArea = view.geometry.map { geometry in
            { (rect: CGRect) -> CGRect in
                let a = geometry.toScreen(x: rect.minX, y: rect.minY), b = geometry.toScreen(x: rect.maxX, y: rect.maxY)
                return CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
            }
        }
        // Equal candidates have equal labels, kinds and frames: one item each.
        let pair = { (matches: [LocatorMatch]) in
            matches.compactMap { match in view.items.first { $0.candidate == match.candidate }.map { (match, $0) } }
        }
        let matches = pair(locator.matches(candidates, bounds: view.bounds, pixelArea: pixelArea))
        let chosen = locator.unique(matches.map(\.0)).flatMap { best in matches.first { $0.0 == best } }
        var elsewhere: [(LocatorMatch, Located)] = []
        if matches.isEmpty, let loose = locator.loosened {
            elsewhere = pair(loose.matches(candidates, bounds: view.bounds))
        }
        return LocateOutcome(view: view, matches: matches, chosen: chosen, elsewhere: elsewhere)
    }

    /// One line per candidate: how to act on it, what it is, where.
    func line(_ match: LocatorMatch, _ item: Located, index: Int?) -> String {
        var parts: [String] = []
        if let index { parts.append("[\(index)]") }
        let role = item.candidate.roleKnown ? withoutAXPrefix(item.candidate.role) : "text"
        parts.append(role + (item.candidate.label.isEmpty ? "" : " \(quote(item.candidate.label, limit: 60))"))
        parts.append(match.area)
        if let pixel = item.pixel { parts.append("x=\(Int(pixel.x.rounded())) y=\(Int(pixel.y.rounded()))") }
        if let container = item.candidate.containers.first { parts.append("in \(quote(container, limit: 40))") }
        if let distance = match.distance { parts.append("\(Int(distance.rounded())) pt from the near text") }
        return parts.joined(separator: " ")
    }

    /// An index for a located element in the app's session: its index in the
    /// latest tree when it is there, else a new one after them.
    func sessionIndex(for element: AXUIElement, pid: pid_t) -> Int {
        var session = sessions[pid] ?? AppSession(elements: [], geometry: nil, window: nil)
        if let index = session.elements.firstIndex(where: { CFEqual($0, element) }) { return index }
        session.elements.append(element)
        sessions[pid] = session
        return session.elements.count - 1
    }

    func describeOutcome(_ outcome: LocateOutcome, locator: Locator, pid: pid_t, acting: Bool) -> String {
        let index = { (item: Located) in item.element.map { self.sessionIndex(for: $0, pid: pid) } }
        let source = !outcome.view.items.contains { $0.element != nil } ? "text recognized in a screenshot taken just now"
            : outcome.view.recognized ? "accessibility and text recognized in the screenshot" : "accessibility"
        if outcome.matches.isEmpty {
            var text = "Nothing in window \(outcome.view.window) matches \(locator.summary) (looked just now, in \(source))" + (acting ? "; nothing was done." : ".")
            if !outcome.elsewhere.isEmpty {
                text += " Matching the name/kind alone, elsewhere:\n" + outcome.elsewhere.prefix(10).map { "  " + line($0.0, $0.1, index: index($0.1)) }.joined(separator: "\n")
            }
            return text
        }
        let listed = outcome.matches.prefix(15).enumerated().map { "  \($0.offset + 1). " + line($0.element.0, $0.element.1, index: index($0.element.1)) }
        if outcome.chosen == nil {
            return "\(outcome.matches.count) candidates match \(locator.summary) in window \(outcome.view.window); skfiy does not choose between them"
                + (acting ? ", so nothing was done" : "") + ". Narrow the target with region, within, near, below or right_of, or act on one by its element_index or x/y:\n"
                + listed.joined(separator: "\n")
        }
        return "\(outcome.matches.count == 1 ? "1 match" : "\(outcome.matches.count) matches, one clearly meant") for \(locator.summary) in window \(outcome.view.window):\n" + listed.joined(separator: "\n")
    }

    // MARK: - Tools

    /// The locate tool: what a target means right now, without acting.
    func locate(_ args: Arguments) async throws -> ToolResult {
        guard let locator = try Locator.parse(args.values["target"]) else { throw ToolError("Missing required argument \"target\".") }
        if DirectLockedUse.isActive {
            let (view, pid) = try await directLockedUse.locateView(args)
            let outcome = Self.match(locator, in: view)
            return ToolResult(text: describeOutcome(outcome, locator: locator, pid: pid, acting: false) + "\nThe screenshot below was taken just now; x/y are its pixels.",
                              image: view.screenshot?.image, imageMimeType: view.screenshot?.imageMimeType ?? "image/jpeg", isError: outcome.matches.isEmpty)
        }
        let query = try args.requiredString("app")
        guard case .running(let app) = try directory.resolve(query) else {
            throw ToolError("\(query) is not running. Call get_app_state first; it launches the app in the background.")
        }
        var view = try await locateView(app: app, withText: args.bool("ocr") ?? false)
        var outcome = Self.match(locator, in: view)
        if outcome.matches.isEmpty, !view.recognized, args.bool("ocr") != false {
            // Not in the tree: maybe drawn (canvas, image, custom view).
            view = try await locateView(app: app, withText: true)
            outcome = Self.match(locator, in: view)
        }
        let text = describeOutcome(outcome, locator: locator, pid: app.processIdentifier, acting: false)
        return ToolResult(text: text, isError: outcome.matches.isEmpty)
    }

    /// Replaces `target` with the element_index or x/y it resolves to now, or
    /// explains why it does not resolve to exactly one thing.
    func resolveTarget(_ name: String, _ raw: [String: Any]) async throws -> (raw: [String: Any], note: String)? {
        guard let locator = try Locator.parse(raw["target"]) else { return nil }
        guard Self.targetTools.contains(name) else {
            throw ToolError("\(name) does not take a target; it acts on the focused element or a key.")
        }
        if ["element_index", "x", "y", "zoom_id"].contains(where: { raw[$0] != nil && !(raw[$0] is NSNull) }) {
            throw ToolError("Pass either target or element_index / x,y — not both.")
        }
        var resolved = raw
        resolved.removeValue(forKey: "target")
        let args = Arguments(raw)
        if DirectLockedUse.isActive {
            guard ["click", "scroll"].contains(name) else {
                throw ToolError("While macOS is locked, target works with click and scroll (by recognized text); \(name) needs accessibility. Nothing was sent.")
            }
            let (view, pid) = try await directLockedUse.locateView(args)
            let outcome = Self.match(locator, in: view)
            guard let (match, item) = outcome.chosen, let pixel = item.pixel else {
                throw ToolError(describeOutcome(outcome, locator: locator, pid: pid, acting: true))
            }
            resolved["x"] = Double(pixel.x.rounded())
            resolved["y"] = Double(pixel.y.rounded())
            return (resolved, "Target \(locator.summary) → " + line(match, item, index: nil) + " (found just now by recognized text).")
        }
        let (app, _) = try target(args)
        var view = try await locateView(app: app, withText: false)
        var outcome = Self.match(locator, in: view)
        if outcome.matches.isEmpty, !view.recognized {
            view = try await locateView(app: app, withText: true)
            outcome = Self.match(locator, in: view)
        }
        let pid = app.processIdentifier
        guard let (match, item) = outcome.chosen else {
            throw ToolError(describeOutcome(outcome, locator: locator, pid: pid, acting: true))
        }
        if let element = item.element {
            let index = sessionIndex(for: element, pid: pid)
            resolved["element_index"] = String(index)
            return (resolved, "Target \(locator.summary) → " + line(match, item, index: index) + " (found just now).")
        }
        guard let pixel = item.pixel else {
            throw ToolError("\(locator.summary) is recognized text, which needs a current screenshot to click by position. Call get_app_state, then try again; nothing was done.")
        }
        resolved["x"] = Double(pixel.x.rounded())
        resolved["y"] = Double(pixel.y.rounded())
        return (resolved, "Target \(locator.summary) → " + line(match, item, index: nil) + " (recognized text, found just now).")
    }
}
