import AppKit
import ApplicationServices
import Foundation

/// Looking at apps: list_apps, get_app_state (the screenshot, the numbered
/// accessibility tree and what changed since an earlier look), and the menus
/// shown in the tree.
extension ComputerUse {
    // MARK: - list_apps

    func listApps() -> ToolResult {
        let running = directory.runningApps()
        let regularPIDs = Set(NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map(\.processIdentifier))
        let visible = running
            .filter { $0.pid.map(regularPIDs.contains) ?? false }
            .sorted { ($0.isFrontmost ? 0 : 1, $0.name) < ($1.isFrontmost ? 0 : 1, $1.name) }

        var lines = ["Running apps:"]
        for app in visible {
            var line = "- \(app.name)"
            if let bundleID = app.bundleID { line += " — \(bundleID)" }
            if let pid = app.pid { line += " (pid \(pid))" }
            if app.isFrontmost { line += " [frontmost]" }
            if app.isHidden { line += " [hidden]" }
            lines.append(line)
        }
        let background = running.count - visible.count
        if background > 0 {
            lines.append("(+\(background) menu-bar/background apps; they can still be targeted by name or bundle id)")
        }

        let runningBundles = Set(running.compactMap(\.bundleID))
        let cutoff = Date().addingTimeInterval(-14 * 24 * 3600)
        let recent = directory.installedApps()
            .filter { app in
                guard let lastUsed = app.lastUsed, lastUsed >= cutoff else { return false }
                return app.bundleID.map { !runningBundles.contains($0) } ?? true
            }
            .sorted { ($0.lastUsed ?? .distantPast) > ($1.lastUsed ?? .distantPast) }
        if !recent.isEmpty {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            lines.append("")
            lines.append("Used in the last 14 days (not running):")
            for app in recent {
                var line = "- \(app.name)"
                if let english = app.aliases.first(where: { normalizeAppName($0) != normalizeAppName(app.name) }) {
                    line += " (\(english))"
                }
                if let bundleID = app.bundleID { line += " — \(bundleID)" }
                if let lastUsed = app.lastUsed { line += " — last used \(formatter.string(from: lastUsed))" }
                if let count = app.useCount, count > 0 { line += ", \(count) uses" }
                lines.append(line)
            }
        }
        return ToolResult(text: lines.joined(separator: "\n"))
    }

    // MARK: - get_app_state

    func getAppState(_ args: Arguments) async throws -> ToolResult {
        try requireAccessibility()
        // While locked, accessibility answers for the lock screen, not the app.
        guard !isScreenLocked() else {
            throw ToolError("The screen is locked, so app windows cannot be read. Try again after it is unlocked.")
        }
        let app = try await runningApp(try args.requiredString("app"), launch: true)
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 2)
        await enableAccessibility(app, appElement)

        let since = nonEmpty(args.string("since")?.trimmingCharacters(in: .whitespaces))
        if since != nil, args.string("find")?.trimmingCharacters(in: .whitespaces).isEmpty == false {
            throw ToolError("since and find cannot be combined: since lists what changed in the whole window.")
        }
        // A comparison keeps the numbering of the look it compares with, so
        // elements that stayed keep their indices.
        let base = since.flatMap { version in stateHistory[pid]?.last { $0.version == version } }
        let keeping = base.flatMap { base in sessions[pid].flatMap { $0.epoch == base.epoch ? $0 : nil } }

        // Hidden or minimized windows are left alone: unhiding would restack
        // the user's windows. The tree still works; only pixels are missing.
        let windowQuery = args.string("window")?.trimmingCharacters(in: .whitespaces)
        var snapshot = try buildSnapshot(app: app, appElement: appElement, windowQuery: windowQuery?.isEmpty == false ? windowQuery : nil,
                                         keeping: keeping?.elements)
        var screenshot: Screenshot?
        var captureNote: String?
        let shownWindow = snapshot.shownWindow
        let minimized = shownWindow?.bool(kAXMinimizedAttribute) == true
        // A window inspected by name may lie under another window of the same
        // app: it is captured on its own, as while locked, not as a region.
        let inspected = snapshot.chosenWindow.flatMap { independentWindow($0, pid: pid) }
        let hidden = appIsHidden(app)
        let inspectedPresence = inspected.map { presence(of: $0.id, app: app) }
        if hidden || minimized {
            captureNote = "No screenshot: " + (hidden ? "the app is hidden" : "the window is minimized") + ", and skfiy does not bring windows forward (that would put them over the user's screen). Accessibility actions by element_index still work" + (hidden ? ", and so does the keyboard." : ".")
        } else if inspectedPresence == .otherDesktop {
            captureNote = "No screenshot: the window is on another desktop (Space) or in a full-screen space, and skfiy does not switch desktops. Accessibility actions by element_index still work."
        } else if let inspected {
            do {
                screenshot = try await captureDirectLockedWindow(inspected, maxScale: 1, children: true)
            } catch let error as ToolError {
                captureNote = error.description
            }
        } else if let region = appRegion(pid: pid, focusedWindow: snapshot.focusedWindowFrame) {
            do {
                screenshot = try await captureApp(pid: pid, rect: region)
            } catch let error as ToolError {
                captureNote = error.description
            }
        } else {
            captureNote = "No screenshot: the app has no visible window. Use the menu bar or a shortcut such as cmd+n to open one."
        }
        let windowKey = shownWindow.flatMap(windowID(of:)).map(String.init) ?? shownWindow?.string(kAXTitleAttribute) ?? ""
        let comparable = base.map { $0.window == windowKey } ?? false
        let fingerprint = screenshot.flatMap { TextRecognition.decode($0.data) }.flatMap { PixelFingerprint($0, region: nil) }
        let pixelsSame: Bool = {
            guard comparable, let then = base?.fingerprint, let now = fingerprint else { return false }
            return !now.changed(from: then)
        }()
        let shotLine = screenshot.map { screenshotLine($0.geometry) } ?? captureNote ?? ""
        // Text only in the pixels: the whole window when it publishes no
        // accessibility, or on request (canvas, images). Unchanged pixels
        // read the same: the last recognition is reused.
        var recognizedLines: [String] = []
        if let screenshot, args.bool("ocr") ?? snapshot.opaque {
            if pixelsSame, let reused = base?.textLines, !reused.isEmpty {
                recognizedLines = reused
            } else {
                do {
                    let lines: [RecognizedText]
                    if let inspected {
                        let (hires, _) = try await captureDirectLockedImage(inspected, maxScale: backingScale(for: inspected.frame), children: true)
                        lines = TextRecognition.sorted(try await TextRecognition.recognizeBoth(hires, showing: screenshot.geometry.rect))
                    } else {
                        lines = try await recognizeText(pid: pid, region: screenshot.geometry.rect)
                    }
                    recognizedLines = textLines(lines, geometry: screenshot.geometry)
                } catch {
                    recognizedLines = ["(Text recognition failed: \(error.localizedDescription))"]
                }
            }
            snapshot.body.append(contentsOf: recognizedLines)
        }
        if let query = args.string("find")?.trimmingCharacters(in: .whitespaces), !query.isEmpty {
            let total = snapshot.body.count
            let found = filterTree(snapshot.body, matching: query)
            snapshot.header.append(found.matches == 0
                ? "Nothing in the tree matches \(quote(query, limit: 60)) (\(total) lines in all); call get_app_state without find to see everything."
                : "Showing the \(found.matches) line(s) matching \(quote(query, limit: 60)) with their containers, out of \(total); indices are those of the full tree.")
            snapshot.body = found.lines
        }
        let previousZoom = sessions[pid]?.zoom
        sessions[pid] = AppSession(elements: snapshot.elements, geometry: screenshot?.geometry, window: snapshot.chosenWindow, epoch: keeping?.epoch)
        // An older zoom_id is then refused as belonging to an older screenshot.
        sessions[pid]?.zoom = previousZoom
        sessions[pid]?.windowID = shownWindow.flatMap(windowID(of:))
        sessions[pid]?.windowFrame = shownWindow?.frame
        sessions[pid]?.shownFingerprint = fingerprint
        sessions[pid]?.independent = inspected != nil && screenshot != nil
        sessions[pid]?.knownWindows = appWindowIDs(pid)
        if screenshot != nil, chromiumWindowFrozen(app, window: sessions[pid]?.windowID) {
            snapshot.header.append(frozenNote(app))
        }
        let version = StateVersions.next()
        if args.string("find") == nil {
            stateHistory[pid] = StateRecord.appending(StateRecord(version: version, epoch: sessions[pid]!.epoch, window: windowKey, lines: snapshot.body,
                                                                  textLines: recognizedLines, windows: snapshot.windows, fingerprint: fingerprint), to: stateHistory[pid])
        }
        snapshot.header.append("State: \(version)" + (since == nil ? "" : " (compared with \(since!))") + ". Pass since: \"\(version)\" next time to get only what changed.")

        let full = { (note: String?) -> ToolResult in
            var snapshot = snapshot
            snapshot.header.append(shotLine)
            if let note { snapshot.header.append(note) }
            return ToolResult(text: snapshot.text, image: screenshot?.data, imageMimeType: screenshot?.mimeType ?? "image/jpeg")
        }
        guard let since else { return full(nil) }
        guard let base else {
            return full("\(since) is not known for this app (only its last \(StateRecord.kept) looks are kept, and a lock change forgets them); the full state follows.")
        }
        guard comparable, keeping != nil else {
            return full("Cannot compare with \(since): " + (comparable ? "a full get_app_state renumbered the elements since" : "it showed another window")
                        + "; the full state follows.")
        }
        let diff = StateDiff.compare(old: base.lines, new: snapshot.body, oldWindows: base.windows, newWindows: snapshot.windows)
        if diff.isEmpty, pixelsSame {
            var header = snapshot.header
            header.append("Unchanged since \(since): the tree, the windows and the pixels are the same, so no screenshot is attached. Element indices of \(since) still hold.")
            return ToolResult(text: header.filter { !$0.isEmpty }.joined(separator: "\n"))
        }
        if diff.isLarge(comparedTo: snapshot.body.count) {
            return full("Most of the window changed since \(since) (\(diff.summary)); the full state follows. Elements that stayed kept their indices.")
        }
        var header = snapshot.header
        header.append(pixelsSame ? "The pixels are the same as in \(since); no screenshot is attached." : shotLine)
        header.append("Changes since \(since): \(diff.summary). Lines not listed are unchanged, with the same indices; new elements got new indices.")
        let text = (header.filter { !$0.isEmpty } + [""] + diff.render()).joined(separator: "\n")
        return ToolResult(text: text, image: pixelsSame ? nil : screenshot?.data, imageMimeType: screenshot?.mimeType ?? "image/jpeg")
    }

    /// A window as the window server knows it, for capturing it on its own.
    func independentWindow(_ window: AXUIElement, pid: pid_t) -> DirectLockedWindow? {
        guard let id = windowID(of: window), let frame = window.frame else { return nil }
        return DirectLockedWindow(id: id, pid: pid, title: window.string(kAXTitleAttribute) ?? "", frame: frame)
    }

    /// Recognizes the text shown in `region` of an app, from a capture at the
    /// full resolution of the display it is on (small text reads better).
    /// Not more: a 2× capture of a window on a 1× display gave every
    /// recognized position shrunk by the same factor (positions off by
    /// 200 pt on the right of the window).
    func recognizeText(pid: pid_t, region: CGRect) async throws -> [RecognizedText] {
        let shot = try await captureApp(pid: pid, rect: region, maxScale: backingScale(for: region))
        guard let image = TextRecognition.decode(shot.data) else { return [] }
        return TextRecognition.sorted(try await TextRecognition.recognizeBoth(image, showing: shot.geometry.rect))
    }

    /// Recognized text as tree lines, with the middle of each line in pixels
    /// of the screenshot, ready for click x/y.
    private func textLines(_ lines: [RecognizedText], geometry: CaptureGeometry) -> [String] {
        guard !lines.isEmpty else {
            return ["Text recognized in the screenshot: none."]
        }
        var out = ["Text recognized in the screenshot (not in the accessibility tree; click it with x/y):"]
        for line in lines.prefix(200) {
            let middle = geometry.toPixels(CGPoint(x: line.frame.midX, y: line.frame.midY))
            out.append("  \(quote(line.text, limit: 80)) x=\(Int(middle.x.rounded())) y=\(Int(middle.y.rounded()))")
        }
        if lines.count > 200 {
            out.append("  (\(lines.count - 200) more lines; zoom in or scroll)")
        }
        return out
    }

    struct Snapshot {
        var header: [String]
        var body: [String]
        var elements: [AXUIElement]
        var focusedWindowFrame: CGRect?
        var chosenWindow: AXUIElement?
        /// All of the app's windows: window id (or "title:" and the title,
        /// for a window without one) -> title.
        var windows: [String: String] = [:]
        /// The window publishes no accessibility elements.
        var opaque = false
        /// The window shown: the chosen one, else the focused (or main, or first) one.
        var shownWindow: AXUIElement?
        var text: String { (header.filter { !$0.isEmpty } + [""] + body).joined(separator: "\n") }
    }

    func buildSnapshot(app: NSRunningApplication, appElement: AXUIElement, windowQuery: String?, keeping: [AXUIElement]? = nil) throws -> Snapshot {
        let pid = app.processIdentifier
        let builder = AXTreeBuilder()
        let values = appElement.multipleValues([
            kAXWindowsAttribute, kAXFocusedWindowAttribute, kAXMainWindowAttribute,
            kAXMenuBarAttribute, kAXChildrenAttribute, kAXFocusedUIElementAttribute
        ])
        let windows = (values[kAXWindowsAttribute] as? [AXUIElement]) ?? []
        var focusedWindow = axElement(values[kAXFocusedWindowAttribute])
            ?? axElement(values[kAXMainWindowAttribute])
            ?? windows.first
        var chosenWindow: AXUIElement?
        if let windowQuery {
            // Inspect another window without raising it: the user's window order stays.
            let titled = windows.filter { $0.string(kAXRoleAttribute) == kAXWindowRole }
            focusedWindow = try Self.chooseWindow(titled, query: windowQuery, app: app.localizedName ?? "the app")
            chosenWindow = focusedWindow
        }
        let focusedFrame = focusedWindow?.frame
        let clip = appRegion(pid: pid, focusedWindow: focusedFrame) ?? focusedFrame

        var renderer = TreeRenderer { ref, info in
            let element = builder.elements[ref]
            let settable = Self.settableRoles.contains(info.role) && element.isSettable(kAXValueAttribute)
            var scroll: Double?
            if info.role == "AXScrollArea", let bar = element.element(kAXVerticalScrollBarAttribute) {
                scroll = (bar.value(kAXValueAttribute) as? NSNumber)?.doubleValue
            }
            return NodeDetails(actions: element.actionNames(), settable: settable, verticalScroll: scroll)
        }
        // Keeping an earlier numbering: elements seen then keep their index,
        // new ones are numbered after all of them.
        if let keeping {
            var known: [ElementKey: Int] = [:]
            for (index, element) in keeping.enumerated() where known[ElementKey(element)] == nil {
                known[ElementKey(element)] = index
            }
            var next = keeping.count
            renderer.allocate = { ref in
                let key = ElementKey(builder.elements[ref])
                if let index = known[key] { return index }
                known[key] = next
                next += 1
                return next - 1
            }
        }

        var header = ["App: \(app.localizedName ?? "?") — \(app.bundleIdentifier ?? "no bundle id") (pid \(pid))"
            + (frontmostProcessID() == pid ? ", frontmost" : ", in background")]

        // Focused window first: it is what the task is about and survives truncation.
        var opaqueWindow = false
        let focusedElement = axElement(values[kAXFocusedUIElementAttribute])
        if let focusedWindow, var node = builder.build(focusedWindow, clip: clip) {
            let focusedRef = focusedElement.flatMap { focused in
                builder.elements.firstIndex { CFEqual($0, focused) }
            }
            markFocus(&node, focusedRef: focusedRef)
            renderer.render(node, clip: clip)
            if contentElementCount(node) == 0 {
                opaqueWindow = true
            }
        } else if windows.isEmpty {
            renderer.appendLine("(no windows)")
        }

        // Context menus hang off the application element.
        let appChildren = (values[kAXChildrenAttribute] as? [AXUIElement]) ?? []
        for menu in appChildren where menu.string(kAXRoleAttribute) == kAXMenuRole && isOpenMenu(menu) {
            renderer.appendLine("Open menu:")
            renderMenu(menu, builder: builder, renderer: &renderer, depth: 1)
        }

        // Menu bar: one compact line, plus the contents of an open menu.
        if let menuBar = axElement(values[kAXMenuBarAttribute]) {
            var entries: [String] = []
            var openMenus: [(String, AXUIElement)] = []
            for item in menuBar.elements(kAXChildrenAttribute) {
                let title = item.string(kAXTitleAttribute) ?? ""
                let index = renderer.register(builder.add(item))
                entries.append("[\(index)] \(quote(title, limit: 40))")
                if let menu = item.elements(kAXChildrenAttribute).first, isOpenMenu(menu) {
                    openMenus.append((title, menu))
                }
            }
            if !entries.isEmpty {
                renderer.appendLine("Menu bar: " + entries.joined(separator: " "))
            }
            for (title, menu) in openMenus {
                renderer.appendLine("Open menu \(quote(title, limit: 40)):")
                renderMenu(menu, builder: builder, renderer: &renderer, depth: 1)
            }
        }
        // The app's own icons on the right of the menu bar.
        if let extras = appElement.element("AXExtrasMenuBar") {
            let items = extras.elements(kAXChildrenAttribute).prefix(10).map { item -> String in
                let label = nonEmpty(item.string(kAXTitleAttribute)) ?? nonEmpty(item.string(kAXDescriptionAttribute)) ?? app.localizedName ?? "status item"
                return "[\(renderer.register(builder.add(item)))] \(quote(label, limit: 40))"
            }
            if !items.isEmpty {
                renderer.appendLine("Status items: " + items.joined(separator: " "))
            }
        }

        // Other windows, so the model can inspect one with get_app_state(window:).
        // AXWindows can include non-windows, e.g. Finder's desktop scroll area.
        let otherWindows = windows.filter { window in
            window.string(kAXRoleAttribute) == kAXWindowRole
                && (focusedWindow.map { !CFEqual($0, window) } ?? true)
        }
        if !otherWindows.isEmpty {
            renderer.appendLine("Other windows (pass window=\"<title or id>\" to get_app_state to inspect one):")
            for window in otherWindows.prefix(20) {
                let (info, _) = builder.info(window)
                let index = renderer.register(builder.add(window))
                var line = "  [\(index)] Window \(quote(info.title ?? "", limit: 80))" + (windowID(of: window).map { " id \($0)" } ?? "")
                if window.bool(kAXMinimizedAttribute) == true { line += " minimized" }
                renderer.appendLine(line)
            }
        }

        if builder.truncated || renderer.truncated {
            renderer.appendLine("(Tree truncated. Elements deeper or further down are omitted; scroll or use the screenshot and x/y coordinates.)")
        }

        var elements = renderer.indexToRef.map { builder.elements[$0] }
        if let keeping {
            elements = keeping
            for (index, ref) in renderer.printed {
                if index < elements.count { elements[index] = builder.elements[ref] } else { elements.append(builder.elements[ref]) }
            }
        }
        var windowTitles: [String: String] = [:]
        for window in windows where window.string(kAXRoleAttribute) == kAXWindowRole {
            let title = window.string(kAXTitleAttribute) ?? ""
            windowTitles[windowID(of: window).map(String.init) ?? "title:" + title] = title
        }
        if let window = focusedWindow {
            var keyboard = ""
            if chosenWindow != nil {
                let key = axElement(values[kAXFocusedWindowAttribute])
                if let key, CFEqual(key, window) {
                    keyboard = " — inspected without raising it; it is the app's key window, so keyboard input goes here"
                } else {
                    let keyTitle = key.map { quote($0.string(kAXTitleAttribute) ?? "", limit: 60) + (windowID(of: $0).map { " (id \($0))" } ?? "") }
                    keyboard = " — inspected without raising it; keyboard input goes to the app's key window \(keyTitle ?? "(none)") until you click a text field here (by element_index; skfiy then makes this the key window without raising it)"
                }
            }
            header.append("Window: \(quote(window.string(kAXTitleAttribute) ?? "", limit: 120))"
                + (windowID(of: window).map { " (id \($0))" } ?? "") + keyboard)
            if RemoteSurface.isRemoteSession(bundleID: app.bundleIdentifier, title: window.string(kAXTitleAttribute) ?? "") {
                header.append("This window is a RustDesk remote session: it shows another computer, and input to it goes there. Screenshots and text recognition work; skfiy sends it no background clicks or keys (use run_in_front, which asks the user). The app's own controls are in its main window (get_app_state with window: \"RustDesk\").")
            }
        }
        if let focusedElement, let index = elements.firstIndex(where: { CFEqual($0, focusedElement) }) {
            header.append("Keyboard focus: [\(index)]")
        }
        if opaqueWindow {
            header.append("This window publishes no accessibility elements (custom-drawn UI or an embedded web view). Its text is recognized from the screenshot below, with positions for x/y clicks; also use the menu bar and keyboard shortcuts.")
        }
        return Snapshot(header: header, body: renderer.lines, elements: elements, focusedWindowFrame: focusedFrame, chosenWindow: chosenWindow,
                        windows: windowTitles, opaque: opaqueWindow, shownWindow: focusedWindow)
    }

    /// A window by id, by exact title, or by part of its title. Windows that
    /// share a title must be told apart by id: picking one would be a guess.
    static func chooseWindow(_ windows: [AXUIElement], query: String, app: String) throws -> AXUIElement {
        let listing = { windows.map { "\(quote($0.string(kAXTitleAttribute) ?? "", limit: 50)) id \(windowID(of: $0).map(String.init) ?? "?")" }.joined(separator: "; ") }
        if let id = CGWindowID(query.trimmingCharacters(in: .whitespaces)), let match = windows.first(where: { windowID(of: $0) == id }) {
            return match
        }
        let needle = normalizeAppName(query)
        let titles = windows.map { normalizeAppName($0.string(kAXTitleAttribute) ?? "") }
        var matches = zip(windows, titles).filter { $0.1 == needle }.map(\.0)
        if matches.isEmpty { matches = zip(windows, titles).filter { $0.1.contains(needle) }.map(\.0) }
        guard !matches.isEmpty else {
            throw ToolError("No window of \(app) matches \(quote(query, limit: 60)). Windows: \(listing()).")
        }
        guard matches.count == 1 else {
            throw ToolError("\(matches.count) windows of \(app) match \(quote(query, limit: 60)); pass the window id instead. Windows: \(listing()).")
        }
        return matches[0]
    }

    private static let menuItemAttributes = [
        kAXTitleAttribute, kAXEnabledAttribute, kAXMenuItemCmdCharAttribute,
        kAXMenuItemCmdModifiersAttribute, kAXMenuItemMarkCharAttribute, kAXChildrenAttribute
    ]

    /// "[12] MenuItem "Save" shortcut=cmd+s disabled", or nil for a separator.
    private func menuItemLine(_ values: [String: CFTypeRef], index: Int, depth: Int) -> String? {
        let title = values[kAXTitleAttribute].flatMap(axString) ?? ""
        guard !title.isEmpty else { return nil }
        var line = String(repeating: "  ", count: depth) + "[\(index)] MenuItem \(quote(title, limit: 80))"
        if let char = values[kAXMenuItemCmdCharAttribute].flatMap(axString), !char.isEmpty {
            let modifiers = (values[kAXMenuItemCmdModifiersAttribute] as? NSNumber)?.intValue ?? 0
            line += " shortcut=" + menuShortcut(char: char, modifiers: modifiers)
        }
        if let mark = values[kAXMenuItemMarkCharAttribute].flatMap(axString), !mark.isEmpty {
            line += " checked"
        }
        if (values[kAXEnabledAttribute] as? NSNumber)?.boolValue == false {
            line += " disabled"
        }
        return line
    }

    private func renderMenu(_ menu: AXUIElement, builder: AXTreeBuilder, renderer: inout TreeRenderer, depth: Int) {
        for item in menu.elements(kAXChildrenAttribute) {
            let values = item.multipleValues(Self.menuItemAttributes)
            guard nonEmpty(values[kAXTitleAttribute].flatMap(axString)) != nil else { continue }
            let index = renderer.register(builder.add(item))
            guard var line = menuItemLine(values, index: index, depth: depth) else { continue }
            if let submenu = ((values[kAXChildrenAttribute] as? [AXUIElement]) ?? []).first {
                if isOpenMenu(submenu) {
                    renderer.appendLine(line + " submenu:")
                    renderMenu(submenu, builder: builder, renderer: &renderer, depth: depth + 1)
                    continue
                }
                line += " ▸"
            }
            renderer.appendLine(line)
        }
    }

    /// Lists a closed menu's items (two submenu levels deep) and appends them
    /// to the session, so they can be pressed without the menu ever opening.
    func listMenu(_ menu: AXUIElement, pid: pid_t, depth: Int, lines: inout [String]) {
        for item in menu.elements(kAXChildrenAttribute) {
            let values = item.multipleValues(Self.menuItemAttributes)
            guard nonEmpty(values[kAXTitleAttribute].flatMap(axString)) != nil else { continue }
            let index = sessions[pid]?.elements.count ?? 0
            sessions[pid]?.elements.append(item)
            guard let line = menuItemLine(values, index: index, depth: depth) else { continue }
            lines.append(line)
            if let submenu = ((values[kAXChildrenAttribute] as? [AXUIElement]) ?? []).first {
                if depth < 2 {
                    listMenu(submenu, pid: pid, depth: depth + 1, lines: &lines)
                } else {
                    lines[lines.count - 1] += " ▸"
                }
            }
        }
    }

    func isOpenMenu(_ menu: AXUIElement) -> Bool {
        guard let frame = menu.frame else { return false }
        return frame.width > 1 && frame.height > 1
    }

    func screenshotLine(_ geometry: CaptureGeometry) -> String {
        let rect = geometry.rect
        let ratio = geometry.scale
        let scaleNote = abs(ratio - 1) < 0.01 ? "1 px = 1 pt" : String(format: "1 px = %.3f pt", 1 / ratio)
        return "Screenshot: \(geometry.pixelWidth)×\(geometry.pixelHeight) px showing screen region x=\(Int(rect.minX)) y=\(Int(rect.minY)) w=\(Int(rect.width)) h=\(Int(rect.height)) pt (\(scaleNote)). x/y arguments are pixels in the latest screenshot of this app."
    }

    static let settableRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider",
        "AXIncrementor", "AXDateField", "AXTimeField", "AXColorWell", "AXStepper"
    ]
}

/// Renders an AX menu shortcut in xdotool syntax, ready for press_key.
func menuShortcut(char: String, modifiers: Int) -> String {
    var parts: [String] = []
    if modifiers & 4 != 0 { parts.append("ctrl") }
    if modifiers & 2 != 0 { parts.append("alt") }
    if modifiers & 1 != 0 { parts.append("shift") }
    if modifiers & 8 == 0 { parts.append("cmd") }
    parts.append(char == "+" ? "plus" : char.lowercased())
    return parts.joined(separator: "+")
}
