import AppKit
import ApplicationServices
import Foundation

// Input aimed at a window that is not on top: covered by other apps, under
// another window of its own app, not the app's key window, minimized, in a
// hidden app, or on another desktop. Pointer events, hit tests and keys go to
// the window the model looked at, or are refused with the reason; they never
// land in a sibling window it did not see.

/// Whether a window can be aimed at with pixels right now.
enum WindowPresence: Equatable {
    case onScreen
    case minimized
    case appHidden
    /// Listed by the app, but neither on screen, minimized nor hidden:
    /// another desktop (Space) or another app's full-screen space.
    case otherDesktop
    case closed

    static func classify(onScreen: Bool, listedByApp: Bool, minimized: Bool, appHidden: Bool) -> WindowPresence {
        if onScreen { return .onScreen }
        // A closed AppKit window can live on off screen; the app no longer lists it.
        guard listedByApp else { return .closed }
        if minimized { return .minimized }
        if appHidden { return .appHidden }
        return .otherDesktop
    }

    /// Why pixels of that window cannot be used, for a refusal.
    func refusal(window title: String, id: CGWindowID?, app: String) -> String? {
        let name = (title.isEmpty ? "the window" : "the window \(quote(title, limit: 60))") + (id.map { " (id \($0))" } ?? "")
        switch self {
        case .onScreen: return nil
        case .minimized:
            return "\(name.prefix(1).uppercased() + name.dropFirst()) is minimized, and skfiy does not restore windows (that would put it over the user's screen), so there is nothing to aim at with x/y or the wheel. Element actions by element_index still work. Nothing was sent."
        case .appHidden:
            return "\(app) is hidden, and skfiy does not unhide apps (that would put their windows over the user's screen), so there is nothing to aim at with x/y or the wheel. Element actions by element_index and the keyboard still work. Nothing was sent."
        case .otherDesktop:
            return "\(name.prefix(1).uppercased() + name.dropFirst()) is on another desktop (Space) or in a full-screen space, not on this screen, so there is nothing to aim at with x/y or the wheel. Element actions by element_index still work. Nothing was sent."
        case .closed:
            return "\(name.prefix(1).uppercased() + name.dropFirst()) closed; if the app opened a new one, it has another id. Call get_app_state again; nothing was done."
        }
    }
}

/// Which window pointer input at a point is stamped with. The latest
/// screenshot showed `shown` on its own (it was inspected by name or id), so
/// another normal window of the same app lying above it there must not get
/// what was meant for it; a menu, pop-up or sheet above it still does, as
/// the user would see it. Otherwise the app's topmost window at the point.
func routePointerWindow(shown: CGWindowID?, shownBounds: CGRect?, independent: Bool,
                        top: CGWindowID?, topIsSiblingWindow: Bool, point: CGPoint) -> CGWindowID? {
    guard independent, let shown, let shownBounds, shownBounds.contains(point) else { return top }
    guard let top, top != shown else { return shown }
    return topIsSiblingWindow ? shown : top
}

/// Whether a window opened since skfiy last looked at the app has taken
/// the keyboard: a new document after cmd+n, a dialog, a window an action
/// opened. Keys then belong to it; they are never pulled back from it to the
/// window inspected before (text would land in the other document). A window
/// that was already open and became key again (the app or the user
/// switched back to it) is not new: the inspected window is made key again.
/// `now` is the key window, `inspected` the window the model works in,
/// `known` the app's windows at the last look (none known: nothing assumed).
func keyWindowMoved(now: CGWindowID?, inspected: CGWindowID?, known: Set<CGWindowID>) -> Bool {
    guard let now, !known.isEmpty else { return false }
    return now != inspected && !known.contains(now)
}

/// The parts of `rect` not under any of `covers` (rectangle subtraction).
func uncoveredParts(of rect: CGRect, under covers: [CGRect]) -> [CGRect] {
    var parts = [rect]
    for cover in covers where cover.width > 0 && cover.height > 0 {
        var next: [CGRect] = []
        for part in parts {
            let overlap = part.intersection(cover)
            guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else {
                next.append(part)
                continue
            }
            // Above, below, left and right of the overlap.
            let pieces = [
                CGRect(x: part.minX, y: part.minY, width: part.width, height: overlap.minY - part.minY),
                CGRect(x: part.minX, y: overlap.maxY, width: part.width, height: part.maxY - overlap.maxY),
                CGRect(x: part.minX, y: overlap.minY, width: overlap.minX - part.minX, height: overlap.height),
                CGRect(x: overlap.maxX, y: overlap.minY, width: part.maxX - overlap.maxX, height: overlap.height)
            ]
            next.append(contentsOf: pieces.filter { $0.width > 0 && $0.height > 0 })
        }
        parts = next
        if parts.isEmpty { break }
    }
    return parts
}

/// Whether no point of window `id` shows on any display: every part of it
/// lies under windows in front of it. `rows` are the window server's on-screen
/// windows, front to back. Transparent full-display overlays (the Dock's
/// canvas, Control Center's) and windows of `ignoredOwners` (skfiy's own
/// cursor) hide nothing, and the rounded corners of normal windows let what
/// is under them show. Nil when the window is not on screen at all.
func isFullyCovered(_ id: CGWindowID, rows: [[String: Any]], displays: [CGRect], ignoredOwners: Set<pid_t> = [], cornerRadius: CGFloat = 24) -> Bool? {
    func bounds(_ row: [String: Any]) -> CGRect? {
        guard let dictionary = row[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: dictionary)
    }
    guard let index = rows.firstIndex(where: { ($0[kCGWindowNumber as String] as? Int).map(CGWindowID.init) == id }),
          let frame = bounds(rows[index]) else { return nil }
    var covers: [CGRect] = []
    for row in rows[..<index] {
        guard let rect = bounds(row), rect.width >= 1, rect.height >= 1,
              ((row[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01 else { continue }
        if let owner = (row[kCGWindowOwnerPID as String] as? Int).map(pid_t.init), ignoredOwners.contains(owner) { continue }
        let layer = row[kCGWindowLayer as String] as? Int ?? 0
        if layer != 0, displays.contains(where: { display in
            let shared = display.intersection(rect)
            return !shared.isNull && shared.width * shared.height >= display.width * display.height * 0.9
        }) { continue }
        // A normal window's rounded corners let what is under them show:
        // without its corner squares it is two overlapping rectangles.
        let radius = layer == 0 ? cornerRadius : 0
        if radius > 0, rect.width > 2 * radius, rect.height > 2 * radius {
            covers.append(rect.insetBy(dx: radius, dy: 0))
            covers.append(rect.insetBy(dx: 0, dy: radius))
        } else {
            covers.append(rect)
        }
    }
    let visible = displays.map { $0.intersection(frame) }.filter { !$0.isNull && $0.width >= 1 && $0.height >= 1 }
    let left = visible.flatMap { uncoveredParts(of: $0, under: covers) }
    return !left.contains { $0.width >= 1 && $0.height >= 1 }
}

/// Windows that show another computer and send it whatever they receive:
/// RustDesk's remote-session windows ("<peer> - Remote Desktop - RustDesk",
/// "<peer> - View Camera - RustDesk"). Its main window, file transfer and
/// port forwarding windows are local UI.
enum RemoteSurface {
    static let inputLimitation = "This RustDesk remote session has no verified background input path in skfiy. Its remote desktop is an image, not a tree of remote accessibility controls."
    static let foregroundCaveat = "run_in_front raises the local RustDesk window and changes keyboard focus; do not use it when the user requires no focus or window-order changes. For configured Windows computers, use remote_desktop over SSH (action: list shows bindings, state gives remote coordinates). Never reuse RustDesk screenshot coordinates for that tool."

    static func isRemoteSession(bundleID: String?, title: String) -> Bool {
        guard (bundleID ?? "").lowercased() == "com.carriez.rustdesk" else { return false }
        return title.contains("Remote Desktop - ") || title.contains("View Camera - ")
    }

    static func refusal(_ title: String, what: String) -> String {
        "\(quote(title, limit: 80)) is a RustDesk remote session: \(what) there would go to the remote computer. \(inputLimitation) A click can make RustDesk capture the user's own keyboard. Nothing was sent. Screenshots and text recognition still work. \(foregroundCaveat)"
    }
}

/// What a keyboard tool will reach: the app sends key events to its key
/// window, whatever window the model looked at.
struct KeyboardTarget {
    /// The window the model named (get_app_state window, or window_id).
    var intended: CGWindowID?
    var intendedWindow: AXUIElement?
    var intendedTitle = ""
    /// The app's key window, where key events go.
    var keyWindow: CGWindowID?
    var keyTitle = ""
    /// A text element in the intended window (the field a click focused there).
    var text: AXUIElement?
    /// Why the intended window could not be made the key window.
    var why = ""
    /// A click on one of its text fields could make it the key window
    /// (not while the app is hidden or the window minimized).
    var clickCanMakeKey = true
    var note = ""

    /// Also when the app reports no key window at all (a background Electron app):
    /// where keys go is then unknown, and typing keeps its own fallbacks.
    var reachesIntended: Bool { intended == nil || keyWindow == nil || intended == keyWindow }

    func refusal(app: String) -> String {
        "Keyboard input would go to \(app)'s key window \(quote(keyTitle, limit: 60))" + (keyWindow.map { " (id \($0))" } ?? "")
            + ", not to \(quote(intendedTitle, limit: 60))" + (intended.map { " (id \($0))" } ?? "") + ", the window you are working in\(why)."
            + " Nothing was sent. "
            + (clickCanMakeKey
                ? "Click a text field of that window first (element_index: skfiy then makes it the app's key window, without raising it), or use element actions (set_value, click by element_index), which work in any window."
                : "Use element actions (set_value, click by element_index), which work in any window; keys there need the window shown (ask the user, or run_in_front, which asks them).")
    }

    /// The app made another window key after the latest screenshot.
    func movedRefusal(app: String) -> String {
        "A window \(app) opened after the latest screenshot, \(quote(keyTitle, limit: 60))" + (keyWindow.map { " (id \($0))" } ?? "")
            + ", is now its key window, where keys go, not \(quote(intendedTitle, limit: 60))" + (intended.map { " (id \($0))" } ?? "") + ", the window you are working in. skfiy does not take the keyboard back from a new window with a click: the keys may be meant for it, and text would land in the other window. Nothing was sent."
            + " Call get_app_state" + (keyWindow.map { " with window: \"\($0)\"" } ?? "") + " to see it" + (intended.map { ", or with window: \"\($0)\" to keep working in that window (skfiy then makes it the key window)" } ?? "") + "."
    }
}

extension ComputerUse {
    // MARK: Windows

    /// The window an element belongs to.
    func containingWindow(of element: AXUIElement) -> AXUIElement? {
        if element.string(kAXRoleAttribute) == kAXWindowRole { return element }
        if let window = element.element(kAXWindowAttribute) { return window }
        var current = element.element(kAXParentAttribute)
        for _ in 0..<60 {
            guard let candidate = current else { return nil }
            if candidate.string(kAXRoleAttribute) == kAXWindowRole { return candidate }
            current = candidate.element(kAXParentAttribute)
        }
        return nil
    }

    /// The app's window with this id, as accessibility lists it.
    func axWindow(_ id: CGWindowID, pid: pid_t) -> AXUIElement? {
        AXUIElementCreateApplication(pid).elements(kAXWindowsAttribute).first { windowID(of: $0) == id }
    }

    /// Hidden, also for an accessory app that hid itself: NSRunningApplication
    /// keeps saying it is not.
    func appIsHidden(_ app: NSRunningApplication) -> Bool {
        app.isHidden || AXUIElementCreateApplication(app.processIdentifier).bool(kAXHiddenAttribute) == true
    }

    /// Where window `id` of `app` is now.
    func presence(of id: CGWindowID, app: NSRunningApplication) -> WindowPresence {
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let onScreen = rows.contains { ($0[kCGWindowNumber as String] as? Int).map(CGWindowID.init) == id }
        if onScreen { return .onScreen }
        let window = axWindow(id, pid: app.processIdentifier)
        return WindowPresence.classify(onScreen: false, listedByApp: window != nil,
                                       minimized: window?.bool(kAXMinimizedAttribute) == true, appHidden: appIsHidden(app))
    }

    /// Refuses pointer and wheel input that cannot reach the window it is
    /// meant for: hidden app, minimized window, another desktop, or a remote
    /// session (allowed with `allowRemote`: run_in_front; `what` names the
    /// input in the refusal).
    /// `receiver` (the window the events will be stamped with) and `point`
    /// are checked too: an element's window can differ from the window that
    /// receives the events, and a remote session must get none either way.
    func checkPointerTarget(_ app: NSRunningApplication, window: AXUIElement? = nil, allowRemote: Bool = false,
                            what: String = "a click or drag", receiver: CGWindowID? = nil, point: CGPoint? = nil, aimed: Bool = false) throws {
        try checkInputTarget(app)
        let name = app.localizedName ?? "The app"
        if appIsHidden(app) {
            throw ToolError(WindowPresence.appHidden.refusal(window: "", id: nil, app: name)!)
        }
        let pid = app.processIdentifier
        if !allowRemote, let remote = remoteSessionTitle(app, receiver: receiver, point: point, aimed: aimed) {
            throw ToolError(RemoteSurface.refusal(remote, what: what))
        }
        guard let window = window ?? sessions[pid]?.windowID.flatMap({ axWindow($0, pid: pid) }) else { return }
        let title = window.string(kAXTitleAttribute) ?? ""
        let id = windowID(of: window)
        if window.bool(kAXMinimizedAttribute) == true {
            throw ToolError(WindowPresence.minimized.refusal(window: title, id: id, app: name)!)
        }
        if let id, let refusal = presence(of: id, app: app).refusal(window: title, id: id, app: name) {
            throw ToolError(refusal)
        }
        if !allowRemote, RemoteSurface.isRemoteSession(bundleID: app.bundleIdentifier, title: title) {
            throw ToolError(RemoteSurface.refusal(title, what: what))
        }
    }

    /// The title of a remote session that input at `point`, stamped with
    /// window `receiver`, would reach: the receiving window itself or, when
    /// the model aimed at the point (x/y) or no receiver is known, the window
    /// of the latest screenshot if the point lies in it (it aimed at what
    /// that screenshot showed, whatever element a hit test finds there).
    func remoteSessionTitle(_ app: NSRunningApplication, receiver: CGWindowID?, point: CGPoint?, aimed: Bool = false) -> String? {
        guard RemoteSurface.isRemoteSession(bundleID: app.bundleIdentifier, title: "Remote Desktop - ") else { return nil }
        let pid = app.processIdentifier
        var titles: [String] = []
        if let receiver {
            if let title = axWindow(receiver, pid: pid)?.string(kAXTitleAttribute) { titles.append(title) }
            let row = (CGWindowListCopyWindowInfo([.optionIncludingWindow], receiver) as? [[String: Any]])?.first
            if let title = row?[kCGWindowName as String] as? String { titles.append(title) }
        }
        if receiver == nil || aimed, let point, let shown = sessions[pid]?.windowID.flatMap({ axWindow($0, pid: pid) }), shown.frame?.contains(point) == true,
           let title = shown.string(kAXTitleAttribute) {
            titles.append(title)
        }
        return titles.first { RemoteSurface.isRemoteSession(bundleID: app.bundleIdentifier, title: $0) }
    }

    /// The window pointer input at `point` is stamped with: the element's own
    /// window for an element, the window of the latest screenshot when it was
    /// captured on its own (see routePointerWindow), else the app's topmost
    /// window there.
    func pointerWindow(pid: pid_t, at point: CGPoint, element: AXUIElement? = nil) -> CGWindowID? {
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        func bounds(_ id: CGWindowID) -> CGRect? {
            guard let row = rows.first(where: { ($0[kCGWindowNumber as String] as? Int).map(CGWindowID.init) == id }),
                  let dictionary = row[kCGWindowBounds as String] as? NSDictionary else { return nil }
            return CGRect(dictionaryRepresentation: dictionary)
        }
        let top = rows.first { row in
            guard (row[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
                  let dictionary = row[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: dictionary) else { return false }
            return rect.contains(point)
        }
        let topID = (top?[kCGWindowNumber as String] as? Int).map(CGWindowID.init)
        // An element's window, even under another window of the app.
        if let element, let window = containingWindow(of: element).flatMap(windowID(of:)),
           bounds(window)?.contains(point) == true {
            if let topID, topID != window, (top?[kCGWindowLayer as String] as? Int ?? 0) > 0 { return topID }
            return window
        }
        let session = sessions[pid]
        let shown = session?.windowID
        let sibling: Bool = {
            guard let topID, topID != shown, (top?[kCGWindowLayer as String] as? Int ?? 0) == 0 else { return false }
            // A sheet or panel of the shown window is not in the app's window list.
            return axWindow(topID, pid: pid)?.string(kAXRoleAttribute) == kAXWindowRole
        }()
        return routePointerWindow(shown: shown, shownBounds: shown.flatMap(bounds), independent: session?.independent == true,
                                  top: topID, topIsSiblingWindow: sibling, point: point) ?? focusedWindowID(of: pid)
    }

    /// The deepest element of `window` whose frame holds `point`, later
    /// (frontmost) siblings first. For a window under another window of its
    /// app, which accessibility's own hit test does not reach, and for
    /// Flutter, whose hit test answers with the window itself.
    func deepestElement(in window: AXUIElement, at point: CGPoint, budget: Int = 3000) -> AXUIElement? {
        var visited = 0
        var best: AXUIElement?
        var current = window
        while visited < budget {
            let children = current.elements(kAXChildrenAttribute)
            visited += children.count
            guard let next = children.reversed().first(where: { child in
                guard let frame = child.frame, frame.width >= 1, frame.height >= 1 else { return false }
                return frame.contains(point)
            }) else { break }
            best = next
            current = next
        }
        return best
    }

    /// Whether a window is fully covered by other windows, so a Chromium app
    /// stops drawing it and updating its accessibility (and drops wheel input).
    func chromiumWindowFrozen(_ app: NSRunningApplication, window: CGWindowID?) -> Bool {
        guard let window, isChromium(app) else { return false }
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let displays = displayInfos().map(\.frame)
        return isFullyCovered(window, rows: rows, displays: displays, ignoredOwners: ownProcesses()) == true
    }

    /// The note for a Chromium window that is fully covered.
    func frozenNote(_ app: NSRunningApplication) -> String {
        let browser = Self.isBrowserBundle(app.bundleIdentifier)
        return "This window is completely covered by other windows, and Chromium stops drawing a covered window and updating its accessibility tree (soon after it is covered): the screenshot and tree may be out of date, wheel input may be ignored, and the effect of an action cannot be seen until part of the window shows again. "
            + (browser ? "Use the browser_* tools for its pages (they work in covered and background tabs)." : "Ask the user to uncover any corner of the window, or use run_in_front (asks the user).")
    }

    /// A capture of `rect` as the model was shown it: with `window` (one
    /// inspected by name or id), that window on its own, cropped to `rect`,
    /// as get_app_state captured it; otherwise the app's windows as they
    /// overlap there. A region capture of an inspected window would show
    /// whatever window of the same app lies over it.
    func captureView(pid: pid_t, window: AXUIElement?, rect: CGRect, maxScale: Double = 1) async throws -> Screenshot {
        guard let window, let independent = independentWindow(window, pid: pid) else {
            return try await captureApp(pid: pid, rect: rect, maxScale: maxScale)
        }
        let (image, geometry) = try await captureDirectLockedImage(independent, maxScale: maxScale, modelLimits: maxScale <= 1, children: true)
        let visible = rect.intersection(geometry.rect)
        guard !visible.isNull, visible.width >= 1, visible.height >= 1 else {
            throw ToolError("That part of the window is outside it.")
        }
        let topLeft = geometry.toPixels(visible.origin)
        let bottomRight = geometry.toPixels(CGPoint(x: visible.maxX, y: visible.maxY))
        let crop = CGRect(x: topLeft.x.rounded(.down), y: topLeft.y.rounded(.down),
                          width: (bottomRight.x - topLeft.x).rounded(.up), height: (bottomRight.y - topLeft.y).rounded(.up))
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let cut = crop == CGRect(x: 0, y: 0, width: image.width, height: image.height) ? image : image.cropping(to: crop) else {
            throw ToolError("Could not cut that region from the window.")
        }
        return try encodeScreenshot(cut, geometry: CaptureGeometry(rect: visible, pixelWidth: cut.width, pixelHeight: cut.height))
    }

    /// The text shown in `rect` of `window` (or of the app's windows there),
    /// recognized at the display's full resolution.
    func recognizeView(pid: pid_t, window: AXUIElement?, rect: CGRect) async throws -> [RecognizedText] {
        guard window != nil else { return try await recognizeText(pid: pid, region: rect) }
        let shot = try await captureView(pid: pid, window: window, rect: rect, maxScale: backingScale(for: rect))
        guard let image = TextRecognition.decode(shot.data) else { return [] }
        return TextRecognition.sorted(try await TextRecognition.recognizeBoth(image, showing: shot.geometry.rect))
    }

    /// The window the latest screenshot of the app showed on its own, if it did.
    func inspectedWindow(_ pid: pid_t) -> AXUIElement? {
        guard let session = sessions[pid], session.independent else { return nil }
        return session.window ?? session.windowID.flatMap { axWindow($0, pid: pid) }
    }

    func isSelfOrDescendant(_ element: AXUIElement, of ancestor: AXUIElement) -> Bool {
        var current: AXUIElement? = element
        for _ in 0..<12 {
            guard let candidate = current else { return false }
            if CFEqual(candidate, ancestor) { return true }
            current = candidate.element(kAXParentAttribute)
        }
        return false
    }

    /// skfiy itself and its helpers (the cursor overlay).
    func ownProcesses() -> Set<pid_t> {
        let executable = Bundle.main.executableURL?.resolvingSymlinksInPath().path
        var pids: Set<pid_t> = [getpid()]
        for app in NSWorkspace.shared.runningApplications where app.executableURL?.resolvingSymlinksInPath().path == executable {
            pids.insert(app.processIdentifier)
        }
        return pids
    }

    // MARK: Keyboard

    /// Works out where key events would go and, when the model works in a
    /// window that is not the app's key window, makes it the key window the
    /// way a click in it would: a background click on its text field, which
    /// raises nothing and leaves the user's front app alone.
    func keyboardTarget(_ app: NSRunningApplication, _ args: Arguments) async throws -> KeyboardTarget {
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        let session = sessions[pid]
        let named = nonEmpty(args.string("window_id")?.trimmingCharacters(in: .whitespaces)) != nil
        var target = KeyboardTarget()
        let keyWindow = appElement.element(kAXFocusedWindowAttribute)
        target.keyWindow = keyWindow.flatMap(windowID(of:))
        target.keyTitle = keyWindow?.string(kAXTitleAttribute) ?? ""
        if session?.window != nil || named, let intended = session?.windowID {
            target.intended = intended
            target.intendedWindow = session?.window ?? axWindow(intended, pid: pid)
            target.intendedTitle = target.intendedWindow?.string(kAXTitleAttribute) ?? ""
            let inIntended = { (element: AXUIElement) in self.containingWindow(of: element).flatMap(windowID(of:)) == intended }
            if let typing = typingTargets[pid], typing.string(kAXRoleAttribute) != nil, inIntended(typing) {
                target.text = typing
            } else if let focused = focusedElement(pid), isTextLike(focused), inIntended(focused) {
                target.text = focused
            } else if let window = target.intendedWindow {
                // AppKit keeps a first responder per window; accessibility reports it focused.
                target.text = window.descendant(limit: 1500) { $0.bool(kAXFocusedAttribute) == true && self.isTextLike($0) }
            }
        }
        let bundle = app.bundleIdentifier
        if target.intended != nil, RemoteSurface.isRemoteSession(bundleID: bundle, title: target.intendedTitle) {
            throw ToolError(RemoteSurface.refusal(target.intendedTitle, what: "keyboard input"))
        }
        if target.reachesIntended {
            if RemoteSurface.isRemoteSession(bundleID: bundle, title: target.keyTitle) {
                throw ToolError(RemoteSurface.refusal(target.keyTitle, what: "keyboard input (it is the app's key window, where keys go)"))
            }
            if target.intended == nil, let shown = session?.windowID, let key = target.keyWindow, key != shown {
                target.note = " The keys went to the app's key window \(quote(target.keyTitle, limit: 60)) (id \(key)), not to the window of the latest screenshot (id \(shown)); call get_app_state to see it."
            }
            return target
        }
        if let intended = target.intended, target.intendedWindow?.string(kAXRoleAttribute) == nil,
           (CGWindowListCopyWindowInfo([.optionIncludingWindow], intended) as? [[String: Any]] ?? []).isEmpty {
            // Closed (cmd+w, a dialog that was answered): keys would reach whatever window has the keyboard now.
            throw ToolError("The window you were working in" + (target.intendedTitle.isEmpty ? "" : ", \(quote(target.intendedTitle, limit: 60)),")
                + " (id \(intended)) is closed. Keys would go to the app's key window \(quote(target.keyTitle, limit: 60))" + (target.keyWindow.map { " (id \($0))" } ?? "")
                + ". Nothing was sent. Call get_app_state" + (target.keyWindow.map { " with window: \"\($0)\"" } ?? "") + " to look at it before typing there.")
        }
        if keyWindowMoved(now: target.keyWindow, inspected: target.intended, known: session?.knownWindows ?? []) {
            throw ToolError(target.movedRefusal(app: app.localizedName ?? "The app"))
        }
        if frontmostProcessID() == pid {
            target.why = "; \(app.localizedName ?? "the app") is the front app, so its key window is the user's and skfiy does not change it"
        } else if appIsHidden(app) || target.intendedWindow?.bool(kAXMinimizedAttribute) == true {
            // A background click there would reach no window on screen.
            target.why = "; " + (appIsHidden(app) ? "the app is hidden" : "the window is minimized") + ", so skfiy cannot make it the key window"
            target.clickCanMakeKey = false
        } else if let text = target.text, let intended = target.intended {
            if await makeKeyWindow(pid: pid, window: intended, field: text) {
                target.keyWindow = intended
                target.keyTitle = target.intendedTitle
                target.note = " \(quote(target.intendedTitle, limit: 60)) became the app's key window for this (a background click on its field, as a real click would; nothing was raised)."
                return target
            }
            target.why = "; skfiy could not make it the key window"
        } else {
            target.why = "; it has no focused text field for skfiy to make it the key window with"
        }
        if RemoteSurface.isRemoteSession(bundleID: bundle, title: target.keyTitle) {
            target.why += " (and the key window is a RustDesk remote session: keys there go to the remote computer)"
        }
        return target
    }

    /// Whether the window the model inspected by name or id is gone (closed
    /// by an action or by the user).
    func inspectedWindowClosed(_ pid: pid_t) -> Bool {
        guard let session = sessions[pid], let window = session.window, window.string(kAXRoleAttribute) == nil else { return false }
        guard let id = session.windowID else { return true }
        return (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []).isEmpty
    }

    /// The app's windows, as accessibility lists them.
    func appWindowIDs(_ pid: pid_t) -> Set<CGWindowID> {
        Set(AXUIElementCreateApplication(pid).elements(kAXWindowsAttribute).compactMap(windowID(of:)))
    }

    /// After an action, when the model works in a window it inspected by
    /// name or id: if a window the app opened since the last look took the
    /// keyboard (a new document after cmd+n, a dialog), or the inspected
    /// window closed and another one has the keyboard, that window becomes
    /// the session's window, so the screenshot shows it and keys go to it,
    /// as the user would see and type. Returns the note for the reply
    /// (empty when nothing changed), and takes note of the app's windows.
    func followNewKeyWindow(_ pid: pid_t) -> String {
        guard let session = sessions[pid] else { return "" }
        let windows = appWindowIDs(pid)
        sessions[pid]?.knownWindows = windows
        let key = AXUIElementCreateApplication(pid).element(kAXFocusedWindowAttribute)
        let keyID = key.flatMap(windowID(of:))
        let old = session.windowID
        let closed = !windows.isEmpty && old.map { !windows.contains($0) } ?? false
        let oldTitle = session.window?.string(kAXTitleAttribute) ?? ""
        let was = (oldTitle.isEmpty ? "the window" : quote(oldTitle, limit: 60)) + (old.map { " (id \($0))" } ?? "")
        let opened = keyWindowMoved(now: keyID, inspected: old, known: session.knownWindows)
        guard session.window != nil, let key, let keyID, keyID != old, opened || closed,
              key.string(kAXRoleAttribute) == kAXWindowRole, key.bool(kAXMinimizedAttribute) != true else {
            return session.knownWindows.isEmpty ? "" : openedNote(pid, windows.subtracting(session.knownWindows))
        }
        let title = quote(key.string(kAXTitleAttribute) ?? "", limit: 60)
        if !opened {
            // The inspected window closed and a window that was already open
            // (maybe one of the user's documents) has the keyboard: keys are
            // not moved there unasked; keyboardTarget refuses until the model looks.
            return " \(was.prefix(1).uppercased() + was.dropFirst()) closed. The app's key window is now \(title) (id \(keyID)), which was already open; skfiy sends it no keys until you call get_app_state for it (window: \"\(keyID)\")."
        }
        sessions[pid]?.window = key
        sessions[pid]?.windowID = keyID
        sessions[pid]?.windowFrame = key.frame
        // The latest screenshot was of the other window: its pixels map nothing here.
        sessions[pid]?.geometry = nil
        sessions[pid]?.shownFingerprint = nil
        sessions[pid]?.zoom = nil
        if closed {
            return " \(was.prefix(1).uppercased() + was.dropFirst()) closed; the app's key window is now \(title) (id \(keyID)), so the screenshot shows it and keys go to it. Its element indices are not known yet: call get_app_state for its tree."
        }
        return " \(title) (id \(keyID)) opened and became the app's key window, so the screenshot shows it and keys go to it now."
            + " Element indices are still those of \(was), which is still open (get_app_state with window: \"\(old.map(String.init) ?? "")\" goes back to it); call get_app_state for this window's tree."
    }

    /// Windows that opened with the action without taking the keyboard (a
    /// window ordered behind, a panel): named, since the screenshot of the
    /// inspected window does not show them.
    func openedNote(_ pid: pid_t, _ opened: Set<CGWindowID>) -> String {
        guard !opened.isEmpty else { return "" }
        let titled = opened.sorted().map { id in
            "\(quote(axWindow(id, pid: pid)?.string(kAXTitleAttribute) ?? "", limit: 60)) (id \(id))"
        }
        return " The app opened " + (opened.count == 1 ? "a window" : "\(opened.count) windows") + ", " + titled.joined(separator: ", ")
            + " that did not take the keyboard; get_app_state with window: \"\(opened.sorted()[0])\" shows it."
    }

    /// A click on a text field in another window of the app than the one
    /// worked in (an element index from before the session followed a new
    /// window): that window is worked in again, so keys follow the field as
    /// after a real click, and the next screenshot shows it.
    func workInWindow(of field: AXUIElement) -> String {
        guard let pid = field.pid, let session = sessions[pid], session.window != nil,
              let window = containingWindow(of: field), let id = windowID(of: window), id != session.windowID else { return "" }
        sessions[pid]?.window = window
        sessions[pid]?.windowID = id
        sessions[pid]?.windowFrame = window.frame
        // The latest screenshot was of the other window: its pixels map nothing here.
        sessions[pid]?.geometry = nil
        sessions[pid]?.shownFingerprint = nil
        sessions[pid]?.zoom = nil
        let title = window.string(kAXTitleAttribute) ?? ""
        return ". skfiy works in " + (title.isEmpty ? "that window" : quote(title, limit: 60)) + " (id \(id)) again, the window of this field: the screenshot shows it, and type_text and press_key aim at it"
    }

    /// After a click focused a text field: a real click would also have made
    /// its window the app's key window, where typing goes. Does the same, and
    /// says what came of it (empty when the window already was the key window).
    func makeFieldWindowKey(_ field: AXUIElement) async -> String {
        guard let pid = field.pid, let app = NSRunningApplication(processIdentifier: pid),
              let window = containingWindow(of: field), let id = windowID(of: window) else { return "" }
        let keyWindow = AXUIElementCreateApplication(pid).element(kAXFocusedWindowAttribute)
        // No key window at all (a background Electron app): typing has its own fallbacks.
        guard let key = keyWindow.flatMap(windowID(of:)), key != id else { return "" }
        let keyTitle = keyWindow.map { quote($0.string(kAXTitleAttribute) ?? "", limit: 60) } ?? "(none)"
        let fallback = "type_text inserts into this field through accessibility instead"
        if RemoteSurface.isRemoteSession(bundleID: app.bundleIdentifier, title: window.string(kAXTitleAttribute) ?? "") {
            return "; keyboard input still goes to the app's key window \(keyTitle): skfiy sends no background keys to a remote session"
        }
        if frontmostProcessID() == pid {
            return "; keyboard input still goes to the app's key window \(keyTitle): the app is in front, and its key window is the user's; \(fallback)"
        }
        if window.bool(kAXMinimizedAttribute) == true || appIsHidden(app) {
            return "; its window is not on screen, so keyboard input still goes to the app's key window \(keyTitle); \(fallback)"
        }
        if await makeKeyWindow(pid: pid, window: id, field: field) {
            return "; its window is now the app's key window (a background click on the field, as a real click would make it; nothing was raised), so typing goes here"
        }
        return "; keyboard input still goes to the app's key window \(keyTitle); \(fallback)"
    }

    /// Makes `window` the app's key window with a background left click on
    /// `field`, a text field in it: AppKit makes a window key on a mouse-down
    /// without raising it, and the click (if not used up by that) only moves
    /// the caret, which is put back. True when the window is key afterwards.
    func makeKeyWindow(pid: pid_t, window: CGWindowID, field: AXUIElement) async -> Bool {
        guard let frame = field.frame, frame.width >= 2, frame.height >= 2,
              let bounds = (CGWindowListCopyWindowInfo([.optionIncludingWindow], window) as? [[String: Any]])?.first
                .flatMap({ ($0[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) } }) else { return false }
        // The part of the field that shows: inside its scroll view, below the title bar.
        var area = frame.intersection(bounds).intersection(CGRect(x: bounds.minX, y: bounds.minY + 32, width: bounds.width, height: bounds.height - 32))
        if let scroll = field.ancestor(role: "AXScrollArea"), let clip = scroll.frame {
            area = area.intersection(clip)
        }
        guard !area.isNull, area.width >= 2, area.height >= 2 else { return false }
        let point = CGPoint(x: area.midX, y: area.midY)
        // Only where the field itself is: never a button or link over it.
        guard let windowElement = containingWindow(of: field),
              let hit = deepestElement(in: windowElement, at: point), isSelfOrDescendant(hit, of: field) else { return false }
        let selection = selectedRange(field)
        guard await Input.click(at: point, pid: pid, windowID: window, button: .left, count: 1, modifiers: []) else { return false }
        var key = false
        for _ in 0..<12 {
            await Input.pause(0.05)
            if focusedWindowID(of: pid) == window { key = true; break }
        }
        _ = guardedAXSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if let selection { try? setSelection(field, selection) }
        return key
    }
}
