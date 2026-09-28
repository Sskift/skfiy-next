import AppKit
import ApplicationServices
import Foundation

public struct ToolResult {
    public var text: String
    public var image: Data?
    public var imageMimeType: String
    public var isError: Bool

    public init(text: String, image: Data? = nil, imageMimeType: String = "image/jpeg", isError: Bool = false) {
        self.text = text
        self.image = image
        self.imageMimeType = imageMimeType
        self.isError = isError
    }
}

/// What the last get_app_state showed for one app: the elements behind the
/// printed indices and the pixel↔point mapping of the latest screenshot.
struct AppSession {
    var elements: [AXUIElement]
    var geometry: CaptureGeometry?
    /// The window get_app_state showed, when it was not the focused one.
    var window: AXUIElement?

    func element(_ index: Int) throws -> AXUIElement {
        guard elements.indices.contains(index) else {
            throw ToolError("Unknown element_index \(index) (the last tree had \(elements.count) elements). Call get_app_state to refresh.")
        }
        return elements[index]
    }
}

/// The macOS computer-use tool surface: app-scoped state (screenshot +
/// accessibility tree) and actions addressed by element index or pixel.
@MainActor
public final class ComputerUse {
    private let directory = AppDirectory()
    private var sessions: [pid_t: AppSession] = [:]
    private var accessibilityEnabled: Set<pid_t> = []
    private let settleDelay: Double

    public init() {
        settleDelay = Double(ProcessInfo.processInfo.environment["SKFIY_SETTLE_SECONDS"] ?? "") ?? 0.4
    }

    nonisolated public static let toolNames = [
        "list_apps", "get_app_state", "click", "perform_secondary_action", "set_value",
        "select_text", "scroll", "drag", "press_key", "type_text", "open_file"
    ] + BrowserTools.toolNames

    private let browser = BrowserTools()

    public func call(_ name: String, _ raw: [String: Any]) async -> ToolResult {
        let args = Arguments(raw)
        do {
            if Self.inputTools.contains(name) {
                try refuseProtectedTarget(args)
            }
            switch name {
            case "list_apps": return listApps()
            case "get_app_state": return try await keepingFront(args) { try await self.getAppState(args) }
            case "click": return try await keepingFront(args) { try await self.click(args) }
            case "perform_secondary_action": return try await keepingFront(args) { try await self.performSecondaryAction(args) }
            case "set_value": return try await keepingFront(args) { try await self.setValue(args) }
            case "select_text": return try await keepingFront(args) { try await self.selectText(args) }
            case "scroll": return try await keepingFront(args) { try await self.scroll(args) }
            case "drag": return try await keepingFront(args) { try await self.drag(args) }
            case "press_key": return try await keepingFront(args) { try await self.pressKey(args) }
            case "type_text": return try await keepingFront(args) { try await self.typeText(args) }
            case "open_file": return try await keepingFront(args) { try await self.openFile(args) }
            case let browserTool where browserTool.hasPrefix("browser_"): return try await browser.call(browserTool, args)
            default: return ToolResult(text: "Unknown tool \(name).", isError: true)
            }
        } catch let error as ToolError {
            return ToolResult(text: error.description, isError: true)
        } catch let error as KeyParseError {
            return ToolResult(text: error.description, isError: true)
        } catch {
            return ToolResult(text: "\(error)", isError: true)
        }
    }

    /// Apps sometimes come forward in response to an action: Finder activates
    /// itself for Go to Folder…, Open With activates the app it opens, a new
    /// window can land on top of the user's, and some keys open floating panels
    /// (space is Quick Look in Finder). While a tool runs the front goes straight
    /// back to the user's app; afterwards the user's top window is put back on
    /// top and menus that popped up are closed. Nothing is undone when the user
    /// clicked or pressed a modifier meanwhile, since that may have been them.
    private func keepingFront(_ args: Arguments, _ body: () async throws -> ToolResult) async throws -> ToolResult {
        guard let before = frontmostProcessID() else {
            return try await body()
        }
        let started = Date()
        var target: NSRunningApplication?
        if let query = args.string("app"), case .running(let app)? = try? directory.resolve(query) {
            target = app
        }
        let userTop = topWindow().flatMap { $0.pid == before ? $0.id : nil }
        let overlaysBefore = Set(target.map { overlayWindows(of: $0.processIdentifier) } ?? [])
        let guardian = FrontGuard(userApp: before)
        var result: ToolResult
        do {
            result = try await body()
            await Input.pause(0.15)
        } catch {
            guardian.stop()
            throw error
        }
        let taker = guardian.stop()
        let user = NSRunningApplication(processIdentifier: before)?.localizedName ?? "your app"
        var notes: [String] = []
        if let taker {
            let name = NSRunningApplication(processIdentifier: taker)?.localizedName ?? "Another app"
            notes.append("\(name) came to the front during this action; skfiy handed the front straight back to \(user).")
        }
        let intruders = Set([target?.processIdentifier, taker].compactMap { $0 }).subtracting([before])
        if !userMayHaveSwitched(since: started) {
            if let userTop, let top = topWindow(), top.id != userTop, intruders.contains(top.pid),
               let window = AXUIElementCreateApplication(before).elements(kAXWindowsAttribute).first(where: { windowID(of: $0) == userTop }) {
                _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                let name = NSRunningApplication(processIdentifier: top.pid)?.localizedName ?? "The app"
                notes.append("\(name) put a window over the user's; skfiy put \(user)'s window back on top.")
            }
            if let target, target.processIdentifier != before {
                let popped = overlayWindows(of: target.processIdentifier).filter { !overlaysBefore.contains($0) }
                if !popped.isEmpty {
                    let appElement = AXUIElementCreateApplication(target.processIdentifier)
                    for menu in appElement.elements(kAXChildrenAttribute) where menu.string(kAXRoleAttribute) == kAXMenuRole {
                        _ = AXUIElementPerformAction(menu, kAXCancelAction as CFString)
                    }
                    let still = overlayWindows(of: target.processIdentifier).filter { !overlaysBefore.contains($0) }
                    notes.append(still.isEmpty
                        ? "A menu of \(target.localizedName ?? "the app") opened over the user's screen; skfiy closed it."
                        : "A panel or menu of \(target.localizedName ?? "the app") is now floating over the user's screen (for example Quick Look, opened by space in Finder). Close it (Escape usually works) and avoid actions that open panels.")
                }
            }
        }
        if !notes.isEmpty {
            result.text += "\n" + notes.joined(separator: " ") + " Prefer another way to do this if there is one."
        }
        return result
    }

    /// Tools that send input; get_app_state and scroll only look and move the view.
    static let inputTools: Set<String> = [
        "click", "perform_secondary_action", "set_value", "select_text", "drag", "press_key", "type_text", "open_file"
    ]

    private lazy var hostProcesses = ancestorProcessIDs()

    /// Typing into a terminal runs shell commands, sidestepping the MCP
    /// client's permission checks, and the app hosting the agent must never
    /// receive input from it.
    private func refuseProtectedTarget(_ args: Arguments) throws {
        guard let query = args.string("app"), case .running(let app)? = try? directory.resolve(query) else { return }
        let name = app.localizedName ?? query
        if hostProcesses.contains(app.processIdentifier) {
            throw ToolError("\(name) is hosting this agent, so skfiy never sends it input. Reading it with get_app_state still works.")
        }
        if isTerminal(bundleID: app.bundleIdentifier), ProcessInfo.processInfo.environment["SKFIY_ALLOW_TERMINALS"] != "1" {
            throw ToolError("\(name) is a terminal: whatever is typed there runs as shell commands, outside your client's permission checks, so skfiy does not send it input (get_app_state and scroll still work). Use your own shell tool if you have one; the user can allow terminals with SKFIY_ALLOW_TERMINALS=1.")
        }
    }

    // MARK: - open_file

    /// Opens a document or folder the way a double-click would, but without
    /// activating anything, so no Open panel is needed.
    func openFile(_ args: Arguments) async throws -> ToolResult {
        let path = (try args.requiredString("path").trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
        guard path.hasPrefix("/") else {
            throw ToolError("\"path\" must be an absolute path.")
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            throw ToolError("Nothing exists at \(path).")
        }
        let url = URL(fileURLWithPath: path)
        if url.pathExtension.lowercased() == "app" {
            throw ToolError("\(url.lastPathComponent) is an app; launch it with get_app_state instead.")
        }
        let appURL: URL
        if let query = args.string("app"), !query.trimmingCharacters(in: .whitespaces).isEmpty {
            switch try directory.resolve(query) {
            case .running(let app):
                guard let bundle = app.bundleURL else { throw ToolError("\(query) has no app bundle to open files with.") }
                appURL = bundle
            case .installed(let bundle, _):
                appURL = bundle
            }
        } else {
            // A double-click on an executable runs it; only open those in a named app.
            if !isDirectory.boolValue, FileManager.default.isExecutableFile(atPath: path) {
                throw ToolError("\(url.lastPathComponent) is executable, so it is not opened with its default app. Name an app (such as TextEdit) to open it for viewing.")
            }
            guard let handler = NSWorkspace.shared.urlForApplication(toOpen: url) else {
                throw ToolError("No app on this Mac opens \(url.lastPathComponent).")
            }
            appURL = handler
        }
        let bundleID = Bundle(url: appURL)?.bundleIdentifier
        if isTerminal(bundleID: bundleID)
            || NSRunningApplication.runningApplications(withBundleIdentifier: bundleID ?? "").contains(where: { hostProcesses.contains($0.processIdentifier) }) {
            throw ToolError("\(appURL.deletingPathExtension().lastPathComponent) is a terminal or hosts this agent; skfiy does not open files in it.")
        }
        if isDirectory.boolValue, bundleID == "com.apple.finder" {
            return try await openFolderInNewFinderWindow(path)
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        let app: NSRunningApplication
        do {
            app = try await NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: configuration)
        } catch {
            throw ToolError("Could not open \(url.lastPathComponent): \(error.localizedDescription)")
        }
        await Input.pause(max(settleDelay, 0.8))
        let name = app.localizedName ?? appURL.deletingPathExtension().lastPathComponent
        return ToolResult(text: "Opened \(path) in \(name) in the background. Call get_app_state with app \"\(app.bundleIdentifier ?? name)\" to see it.")
    }

    /// Finder shows a folder opened through Launch Services in one of the
    /// user's existing windows; a window of its own leaves theirs alone.
    private func openFolderInNewFinderWindow(_ path: String) async throws -> ToolResult {
        guard mayAutomate("com.apple.finder") else {
            throw ToolError("Opening a folder this way would take over one of the user's Finder windows, and skfiy is not allowed to script Finder without a permission prompt. In Finder, use New Finder Window (cmd+n) and then Go to Folder… (cmd+shift+g) instead.")
        }
        let escaped = path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        var error: NSDictionary?
        _ = NSAppleScript(source: "tell application \"Finder\" to make new Finder window to (POSIX file \"\(escaped)\" as alias)")?
            .executeAndReturnError(&error)
        if let error {
            throw ToolError("Finder could not open \(path): \(error[NSAppleScript.errorMessage] as? String ?? "unknown error").")
        }
        await Input.pause(settleDelay)
        return ToolResult(text: "Opened \(path) in a new Finder window in the background. Call get_app_state with app \"Finder\" to see it.")
    }

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

        // Hidden or minimized windows are left alone: unhiding would restack
        // the user's windows. The tree still works; only pixels are missing.
        let windowQuery = args.string("window")?.trimmingCharacters(in: .whitespaces)
        var snapshot = try buildSnapshot(app: app, appElement: appElement, windowQuery: windowQuery?.isEmpty == false ? windowQuery : nil)
        var screenshot: Screenshot?
        var captureNote: String?
        let shownWindow = snapshot.chosenWindow ?? appElement.element(kAXFocusedWindowAttribute)
        let minimized = shownWindow?.bool(kAXMinimizedAttribute) == true
        if app.isHidden || minimized {
            captureNote = "No screenshot: the app is \(app.isHidden ? "hidden" : "minimized"), and skfiy does not bring windows forward. Accessibility actions by element_index still work."
        } else if let region = appRegion(pid: pid, focusedWindow: snapshot.focusedWindowFrame) {
            do {
                screenshot = try await captureApp(pid: pid, rect: region)
            } catch let error as ToolError {
                captureNote = error.description
            }
        } else {
            captureNote = "No screenshot: the app has no visible window. Use the menu bar or a shortcut such as cmd+n to open one."
        }
        snapshot.header.append(screenshot.map { screenshotLine($0.geometry) } ?? captureNote ?? "")
        sessions[pid] = AppSession(elements: snapshot.elements, geometry: screenshot?.geometry, window: snapshot.chosenWindow)
        return ToolResult(
            text: snapshot.text,
            image: screenshot?.data,
            imageMimeType: screenshot?.mimeType ?? "image/jpeg"
        )
    }

    struct Snapshot {
        var header: [String]
        var body: [String]
        var elements: [AXUIElement]
        var focusedWindowFrame: CGRect?
        var chosenWindow: AXUIElement?
        var text: String { (header.filter { !$0.isEmpty } + [""] + body).joined(separator: "\n") }
    }

    private func buildSnapshot(app: NSRunningApplication, appElement: AXUIElement, windowQuery: String?) throws -> Snapshot {
        let pid = app.processIdentifier
        let builder = AXTreeBuilder()
        let values = appElement.multipleValues([
            kAXWindowsAttribute, kAXFocusedWindowAttribute, kAXMainWindowAttribute,
            kAXMenuBarAttribute, kAXChildrenAttribute, kAXFocusedUIElementAttribute
        ])
        let windows = (values[kAXWindowsAttribute] as? [AXUIElement]) ?? []
        var focusedWindow = asElement(values[kAXFocusedWindowAttribute])
            ?? asElement(values[kAXMainWindowAttribute])
            ?? windows.first
        var chosenWindow: AXUIElement?
        if let windowQuery {
            // Inspect another window without raising it: the user's window order stays.
            let needle = normalizeAppName(windowQuery)
            let titled = windows.filter { $0.string(kAXRoleAttribute) == kAXWindowRole }
                .map { ($0, normalizeAppName($0.string(kAXTitleAttribute) ?? "")) }
            guard let match = titled.first(where: { $0.1 == needle }) ?? titled.first(where: { $0.1.contains(needle) }) else {
                let names = titled.map { quote($0.0.string(kAXTitleAttribute) ?? "", limit: 60) }
                throw ToolError("No window of \(app.localizedName ?? "the app") matches \(quote(windowQuery, limit: 60)). Windows: \(names.joined(separator: ", ")).")
            }
            focusedWindow = match.0
            chosenWindow = match.0
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

        var header = ["App: \(app.localizedName ?? "?") — \(app.bundleIdentifier ?? "no bundle id") (pid \(pid))"
            + (frontmostProcessID() == pid ? ", frontmost" : ", in background")]

        // Focused window first: it is what the task is about and survives truncation.
        var opaqueWindow = false
        let focusedElement = asElement(values[kAXFocusedUIElementAttribute])
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
        if let menuBar = asElement(values[kAXMenuBarAttribute]) {
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

        // Other windows, so the model can switch with AXRaise.
        // AXWindows can include non-windows, e.g. Finder's desktop scroll area.
        let otherWindows = windows.filter { window in
            window.string(kAXRoleAttribute) == kAXWindowRole
                && (focusedWindow.map { !CFEqual($0, window) } ?? true)
        }
        if !otherWindows.isEmpty {
            renderer.appendLine("Other windows (pass window=\"<title>\" to get_app_state to inspect one):")
            for window in otherWindows.prefix(20) {
                let (info, _) = builder.info(window)
                let index = renderer.register(builder.add(window))
                var line = "  [\(index)] Window \(quote(info.title ?? "", limit: 80))"
                if window.bool(kAXMinimizedAttribute) == true { line += " minimized" }
                renderer.appendLine(line)
            }
        }

        if builder.truncated || renderer.truncated {
            renderer.appendLine("(Tree truncated. Elements deeper or further down are omitted; scroll or use the screenshot and x/y coordinates.)")
        }

        let elements = renderer.indexToRef.map { builder.elements[$0] }
        if let window = focusedWindow {
            header.append("Window: \(quote(window.string(kAXTitleAttribute) ?? "", limit: 120))"
                + (chosenWindow != nil ? " (inspected by title; keyboard input still goes to the app's focused window)" : ""))
        }
        if let focusedElement, let index = elements.firstIndex(where: { CFEqual($0, focusedElement) }) {
            header.append("Keyboard focus: [\(index)]")
        }
        if opaqueWindow {
            header.append("This window publishes no accessibility elements (custom-drawn UI or an embedded web view). Work from the screenshot with x/y clicks, the menu bar, and keyboard shortcuts.")
        }
        return Snapshot(header: header, body: renderer.lines, elements: elements, focusedWindowFrame: focusedFrame, chosenWindow: chosenWindow)
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
    private func listMenu(_ menu: AXUIElement, pid: pid_t, depth: Int, lines: inout [String]) {
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

    private func isOpenMenu(_ menu: AXUIElement) -> Bool {
        guard let frame = menu.frame else { return false }
        return frame.width > 1 && frame.height > 1
    }

    private func screenshotLine(_ geometry: CaptureGeometry) -> String {
        let rect = geometry.rect
        let ratio = geometry.scale
        let scaleNote = abs(ratio - 1) < 0.01 ? "1 px = 1 pt" : String(format: "1 px = %.3f pt", 1 / ratio)
        return "Screenshot: \(geometry.pixelWidth)×\(geometry.pixelHeight) px showing screen region x=\(Int(rect.minX)) y=\(Int(rect.minY)) w=\(Int(rect.width)) h=\(Int(rect.height)) pt (\(scaleNote)). x/y arguments are pixels in the latest screenshot of this app."
    }

    static let settableRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider",
        "AXIncrementor", "AXDateField", "AXTimeField", "AXColorWell", "AXStepper"
    ]

    // MARK: - Actions
    //
    // Nothing here activates the target, raises a window, moves the user's
    // cursor, or touches the clipboard. Accessibility is tried first; pointer
    // and keyboard events are posted to the target process only.

    static let pressRoles: Set<String> = [
        "AXButton", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle", "AXLink", "AXDockItem",
        "AXTab", "AXSegment"
    ]
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    static let menuAlternatives = "Its commands are usually in the menu bar (click a menu bar item to list its items without opening it) or have keyboard shortcuts; to open a file, use open_file."
    static let backgroundMenuRefusal = "A context menu of a background app would be drawn over the user's screen, so skfiy does not open one. " + menuAlternatives

    func click(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        let buttonName = args.string("mouse_button") ?? "left"
        guard let button = MouseButton(rawValue: buttonName.lowercased()) else {
            throw ToolError("mouse_button must be left, right, or middle.")
        }
        let count = try args.int("click_count") ?? 1
        guard (1...3).contains(count) else {
            throw ToolError("click_count must be 1, 2, or 3.")
        }
        let modifiers = try parseModifierList(args.string("modifiers"))
        let pid = app.processIdentifier

        let element: AXUIElement?
        let point: CGPoint?
        let described: String
        if let index = try args.elementIndex() {
            let indexed = try session.element(index)
            element = indexed
            point = nil
            described = "[\(index)] \(describe(indexed))"
        } else {
            let screen = try screenPoint(args, "x", "y", session: session)
            element = hitTest(pid: pid, at: screen)
            point = screen
            described = "(\(formatNumber(try args.double("x") ?? 0)), \(formatNumber(try args.double("y") ?? 0)))"
                + (element.map { " on \(describe($0))" } ?? "")
        }

        // Opening a background app's menu would draw it over the user's screen;
        // list the items instead, ready to be pressed by index.
        if let element, button == .left, count == 1, frontmostProcessID() != pid,
           ["AXMenuBarItem", "AXMenuItem"].contains(element.string(kAXRoleAttribute) ?? ""),
           let menu = element.elements(kAXChildrenAttribute).first,
           menu.string(kAXRoleAttribute) == kAXMenuRole {
            var lines: [String] = []
            listMenu(menu, pid: pid, depth: 1, lines: &lines)
            let title = element.string(kAXTitleAttribute) ?? ""
            let intro = "Menu \(quote(title, limit: 60)) of \(app.localizedName ?? "the app") — listed, not opened, so nothing appeared on screen. Click an item's index to run it. Enabled/checked states are as of when the app was last in front; items marked disabled cannot run while it is in the background."
            return ToolResult(text: ([intro] + lines).joined(separator: "\n"))
        }

        if let element, button == .left, count == 1, frontmostProcessID() != pid,
           element.string(kAXRoleAttribute) == "AXPopUpButton" {
            let options = popupOptions(element)
            let current = element.string(kAXValueAttribute).map { " Current value: \(quote($0, limit: 60))." } ?? ""
            let listing = options.isEmpty ? "" : " Options: " + options.map { quote($0.title, limit: 40) }.joined(separator: ", ") + "."
            return ToolResult(text: "\(described) is a pop-up menu; opening it would draw over the user's screen, so it was not opened.\(current)\(listing) Choose an option with set_value(element_index, value: \"<option text>\").")
        }
        if frontmostProcessID() != pid {
            if button == .right || modifiers.contains(.control) && button == .left {
                throw ToolError(Self.backgroundMenuRefusal)
            }
            if let element, button == .left, element.string(kAXRoleAttribute) == "AXMenuButton" {
                throw ToolError("\(described) opens a menu, and opening it in a background app would draw the menu over the user's screen, so it was not pressed. \(Self.menuAlternatives)")
            }
        }
        if let element, element.string(kAXRoleAttribute) == "AXMenuItem", element.bool(kAXEnabledAttribute) == false {
            throw ToolError("That menu item is disabled. A background app keeps its menus as they were when it was last in front, so items that act on the current document or selection stay disabled; use the equivalent control in the window or a keyboard shortcut instead.")
        }
        if let element, let how = accessibilityClick(element, at: point, button: button, count: count, modifiers: modifiers, exact: point == nil) {
            return try await afterAction(app, "Clicked \(described): \(how).")
        }
        let target: CGPoint
        if let point {
            target = point
        } else if let element {
            target = try await visibleCenter(of: element, session: session)
        } else {
            throw ToolError("Nothing to click.")
        }
        let how = try await pointerClick(app, at: target, button: button, count: count, modifiers: modifiers)
        return try await afterAction(app, "Clicked \(described): \(how).")
    }

    /// Performs a click semantically. Returns what was done, or nil when only a
    /// pointer event can do it. `exact` means the element was chosen by index
    /// rather than hit-tested, so its ancestors are not candidates.
    private func accessibilityClick(
        _ element: AXUIElement,
        at point: CGPoint?,
        button: MouseButton,
        count: Int,
        modifiers: Modifiers,
        exact: Bool
    ) -> String? {
        guard modifiers.isEmpty else { return nil }
        let role = element.string(kAXRoleAttribute) ?? ""
        switch (button, count) {
        case (.left, 1):
            if Self.textRoles.contains(role) {
                _ = try? element.set(kAXFocusedAttribute, kCFBooleanTrue)
                // A click lands the caret under the pointer; by index, at the end.
                let length = (element.string(kAXValueAttribute) as NSString?)?.length ?? 0
                let location = point.flatMap { textIndex(in: element, at: $0) } ?? length
                setCaret(element, location)
                return "focused the field and placed the caret (accessibility)"
            }
            // In web content AXPress only dispatches a click event: plain text or a
            // canvas would not take focus the way a real click does, so those
            // get a real (background) mouse click instead.
            if let pressable = ancestor(of: element, levels: exact ? 0 : 3, where: {
                Self.pressRoles.contains($0.string(kAXRoleAttribute) ?? "") && $0.actionNames().contains(kAXPressAction)
            }) ?? (element.actionNames().contains(kAXPressAction) && !isInWebContent(element) ? element : nil) {
                let name = describe(pressable)
                let status = AXUIElementPerformAction(pressable, kAXPressAction as CFString)
                // Menus and pop-ups run a tracking loop, so AXPress often times out while one opens.
                if status == .success || status == .cannotComplete {
                    return "pressed \(name) (accessibility)"
                }
            }
            if let row = ancestor(of: element, levels: exact ? 0 : 3, where: {
                $0.string(kAXRoleAttribute) == "AXRow" && $0.isSettable(kAXSelectedAttribute)
            }), (try? row.set(kAXSelectedAttribute, kCFBooleanTrue)) != nil {
                return "selected the row (accessibility)"
            }
        case (.left, 2):
            if let openable = ancestor(of: element, levels: exact ? 1 : 3, where: { $0.actionNames().contains("AXOpen") }) {
                let name = describe(openable)
                if (try? openable.perform("AXOpen")) != nil {
                    return "opened \(name) (accessibility)"
                }
            }
        case (.right, 1):
            if let target = ancestor(of: element, levels: exact ? 0 : 2, where: { $0.actionNames().contains(kAXShowMenuAction) }) {
                let name = describe(target)
                let status = AXUIElementPerformAction(target, kAXShowMenuAction as CFString)
                if status == .success || status == .cannotComplete {
                    return "opened the context menu of \(name) (accessibility)"
                }
            }
        default:
            break
        }
        return nil
    }

    /// A real mouse click posted to the process (never through the user's cursor).
    private func pointerClick(
        _ app: NSRunningApplication,
        at point: CGPoint,
        button: MouseButton,
        count: Int,
        modifiers: Modifiers
    ) async throws -> String {
        try checkPointerTarget(app)
        let pid = app.processIdentifier
        guard let window = windowID(of: pid, at: point) ?? focusedWindowID(of: pid) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at that point.")
        }
        if briefFocusEnabled, frontmostProcessID() != pid, await waitForUserIdle() {
            let chromium = isChromium(app)
            let delivered = await Input.withBriefFocus(pid: pid, windowID: window) {
                await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers, chromium: chromium)
            }
            if delivered {
                return "sent a mouse click with a brief in-app focus (your front app kept its place)"
            }
        }
        await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers, chromium: isChromium(app))
        if isInWebContentAt(pid: pid, point: point) {
            return "sent a background mouse click, but browsers (Chromium, WebKit) ignore pointer input to web content in background windows — use an element_index, the browser_* tools, or set SKFIY_BRIEF_FOCUS=1"
        }
        return "sent a background mouse click; if the screenshot shows no change, this view ignores background clicks — use an element_index or the keyboard"
    }

    func performSecondaryAction(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\".")
        }
        let element = try session.element(index)
        let requested = try args.requiredString("action").trimmingCharacters(in: .whitespaces)
        let available = element.actionNames()
        let squash = { (text: String) in text.lowercased().filter { $0 != "_" && $0 != " " } }
        let wanted = squash(requested)
        guard let action = available.first(where: { name in
            name.lowercased() == requested.lowercased() || squash(name) == wanted || squash(name) == "ax" + wanted
                || squash(TreeRenderer.actionDisplayName(name)) == wanted
        }) else {
            let names = available.map(TreeRenderer.actionDisplayName)
            throw ToolError("Element [\(index)] does not support \"\(requested)\". Available: \(names.isEmpty ? "none" : names.joined(separator: ", ")).")
        }
        if action == kAXRaiseAction {
            throw ToolError("Raising a window would put it over the user's windows, so skfiy does not. Inspect another window with get_app_state(app, window: \"<title>\") instead; element actions work on it without raising it.")
        }
        if action == kAXShowMenuAction, frontmostProcessID() != app.processIdentifier {
            throw ToolError(Self.backgroundMenuRefusal)
        }
        let status = AXUIElementPerformAction(element, action as CFString)
        if status != .success, status != .cannotComplete {
            try check(status, "\(action) on element \(index)")
        }
        return try await afterAction(app, "Performed \(TreeRenderer.actionDisplayName(action)) on [\(index)] \(describe(element)).")
    }

    func setValue(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\".")
        }
        let element = try session.element(index)
        let text = try args.requiredText("value")
        let role = element.string(kAXRoleAttribute) ?? ""
        if role == "AXPopUpButton" || role == "AXComboBox" && !element.isSettable(kAXValueAttribute) {
            let how = try await chooseOption(element, text, app: app)
            return try await afterAction(app, "Chose \(quote(text, limit: 60)) in [\(index)] \(describe(element)) (\(how)).")
        }
        guard element.isSettable(kAXValueAttribute) else {
            throw ToolError("Element [\(index)] \(describe(element)) has no settable value. Click it and use type_text, or use its actions.")
        }
        let newValue: CFTypeRef
        switch element.value(kAXValueAttribute) {
        case let current? where CFGetTypeID(current) == CFBooleanGetTypeID():
            newValue = (["1", "true", "yes", "on"].contains(text.lowercased()) ? kCFBooleanTrue : kCFBooleanFalse)!
        case let current? where current is NSNumber:
            guard let number = Double(text.trimmingCharacters(in: .whitespaces)) else {
                throw ToolError("Element [\(index)] holds a number; \"\(text)\" is not one.")
            }
            newValue = NSNumber(value: number)
        default:
            newValue = text as CFString
        }
        let webText = Self.textRoles.contains(role) && isInWebContent(element)
        if webText {
            // WebKit applies AXValue to the selection of whatever field has
            // focus, so move focus to the target first and make sure it took.
            _ = try? element.set(kAXFocusedAttribute, kCFBooleanTrue)
            await Input.pause(0.05)
            guard element.bool(kAXFocusedAttribute) == true else {
                throw ToolError("Could not focus [\(index)] \(describe(element)) to set its value; nothing was changed. Click it and use type_text instead.")
            }
        }
        try element.set(kAXValueAttribute, newValue)
        if webText, let now = element.string(kAXValueAttribute), now != text {
            return try await afterAction(app, "Tried to set the value of [\(index)] \(describe(element)), but it now reads \(quote(now, limit: 60)); the page may have reformatted or rejected it.")
        }
        return try await afterAction(app, "Set the value of [\(index)] \(describe(element)).")
    }

    func selectText(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\".")
        }
        let element = try session.element(index)
        let target = try args.requiredText("text")
        guard !target.isEmpty else {
            throw ToolError("\"text\" must not be empty.")
        }
        let prefix = args.string("prefix") ?? ""
        let suffix = args.string("suffix") ?? ""
        let mode = args.string("selection") ?? "text"
        guard ["text", "cursor_before", "cursor_after"].contains(mode) else {
            throw ToolError("selection must be text, cursor_before, or cursor_after.")
        }
        guard let content = element.string(kAXValueAttribute) else {
            throw ToolError("Element [\(index)] \(describe(element)) has no text value to select in.")
        }
        let range = try locateText(target, in: content, prefix: prefix, suffix: suffix)
        let selection = switch mode {
        case "cursor_before": CFRange(location: range.location, length: 0)
        case "cursor_after": CFRange(location: range.location + range.length, length: 0)
        default: CFRange(location: range.location, length: range.length)
        }
        _ = try? element.set(kAXFocusedAttribute, kCFBooleanTrue)
        try setSelection(element, selection)
        let what = mode == "text" ? "Selected \(quote(target, limit: 60))" : "Placed the cursor \(mode == "cursor_before" ? "before" : "after") \(quote(target, limit: 60))"
        return try await afterAction(app, "\(what) in [\(index)].")
    }

    func scroll(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        let direction = try args.requiredString("direction").lowercased()
        guard ["up", "down", "left", "right"].contains(direction) else {
            throw ToolError("direction must be up, down, left, or right.")
        }
        let pages = try args.double("pages") ?? 1
        guard pages > 0, pages <= 50 else {
            throw ToolError("pages must be between 0 and 50.")
        }
        let pid = app.processIdentifier
        let vertical = direction == "up" || direction == "down"

        let element: AXUIElement?
        let point: CGPoint
        let described: String
        if let index = try args.elementIndex() {
            let indexed = try session.element(index)
            element = indexed
            point = try await visibleCenter(of: indexed, session: session)
            described = "[\(index)]"
        } else if args.values["x"] != nil || args.values["y"] != nil {
            point = try screenPoint(args, "x", "y", session: session)
            element = hitTest(pid: pid, at: point)
            described = "at (\(formatNumber(try args.double("x") ?? 0)), \(formatNumber(try args.double("y") ?? 0)))"
        } else {
            throw ToolError("Pass element_index (preferred) or x/y.")
        }

        // Whole pages on a native scroll area: its page actions work in the background.
        // No AXScroll*ByPage: TextEdit reports failure yet scrolls, the wrong way.
        try checkPointerTarget(app)
        let area = element?.frame.map { frame -> CGRect in
            let visible = frame.intersection(session.geometry?.rect ?? frame)
            return visible.isNull || visible.width < 1 ? frame : visible
        } ?? session.geometry?.rect ?? .zero
        let distance = max((vertical ? area.height : area.width) * 0.85, 40) * pages
        let delta: (Double, Double) = switch direction {
        case "up": (0, -distance)
        case "down": (0, distance)
        case "left": (-distance, 0)
        default: (distance, 0)
        }
        guard let window = windowID(of: pid, at: point) ?? focusedWindowID(of: pid) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at that point.")
        }
        await Input.scroll(at: point, dx: delta.0, dy: delta.1, pid: pid, windowID: window)
        return try await afterAction(app, "Scrolled \(described) \(direction) \(formatNumber(pages)) page(s) (wheel event sent to the app in the background).")
    }

    func drag(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        let start = try screenPoint(args, "from_x", "from_y", session: session)
        let end = try screenPoint(args, "to_x", "to_y", session: session)
        try checkPointerTarget(app)
        let pid = app.processIdentifier
        guard let window = windowID(of: pid, at: start) ?? focusedWindowID(of: pid) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at the start point.")
        }
        var how = "background mouse events"
        if briefFocusEnabled, frontmostProcessID() != pid, await waitForUserIdle(),
           await Input.withBriefFocus(pid: pid, windowID: window, { await Input.drag(from: start, to: end, pid: pid, windowID: window) }) {
            how = "mouse events with a brief in-app focus"
        } else {
            await Input.drag(from: start, to: end, pid: pid, windowID: window)
        }
        return try await afterAction(app, "Dragged from (\(formatNumber(try args.double("from_x") ?? 0)), \(formatNumber(try args.double("from_y") ?? 0))) to (\(formatNumber(try args.double("to_x") ?? 0)), \(formatNumber(try args.double("to_y") ?? 0))) (\(how)).")
    }

    func pressKey(_ args: Arguments) async throws -> ToolResult {
        let (app, _) = try target(args)
        let key = try args.requiredString("key")
        let chord = try parseKeyChord(key)
        let count = try args.int("repeat") ?? 1
        guard (1...100).contains(count) else {
            throw ToolError("repeat must be between 1 and 100.")
        }
        try checkInputTarget(app)
        let pid = app.processIdentifier

        // A background app ignores menu key equivalents, so run the menu item
        // itself. Items that depend on the focused document or text (Save,
        // Select All, Close) are disabled while the app is in the background;
        // the common ones are done through accessibility instead.
        var disabledItem: String?
        if !chord.modifiers.isDisjoint(with: [.command, .control]) {
            if let item = menuItem(for: chord, pid: pid) {
                if item.enabled {
                    var pressed = 0
                    for _ in 0..<count {
                        let status = AXUIElementPerformAction(item.element, kAXPressAction as CFString)
                        guard status == .success || status == .cannotComplete else { break }
                        pressed += 1
                    }
                    if pressed == count {
                        return try await afterAction(app, "Pressed \(key) by invoking the menu item \(quote(item.title, limit: 60)).")
                    }
                } else {
                    disabledItem = item.title
                }
            }
            if let how = try emulateShortcut(chord, pid: pid) {
                return try await afterAction(app, "Pressed \(key): \(how) (accessibility).")
            }
        }
        // Keys sent to the frontmost app pass through its input method (Pinyin
        // would turn "comma" into "，"); insert such characters directly.
        if let text = chord.typedText, frontmostProcessID() == pid, Input.inputMethodActive(),
           let focused = focusedElement(pid), focused.isSettable(kAXSelectedTextAttribute) {
            try focused.set(kAXSelectedTextAttribute, String(repeating: text, count: count) as CFString)
            return try await afterAction(app, "Entered \(quote(text, limit: 10)) (accessibility).")
        }
        await Input.press(chord, repeat: count, to: pid)
        var message = "Pressed \(key)" + (count > 1 ? " ×\(count)" : "") + " (sent to the app in the background)."
        if let disabledItem {
            message += " Its menu item \(quote(disabledItem, limit: 60)) is disabled while the app is in the background, so the shortcut did nothing. Commands that act on the current selection or document (formatting, Save, Undo…) only work in the frontmost app, and toolbar buttons for them are ignored in the background too. skfiy does not bring apps forward; if the task needs such a command, say so instead of retrying."
        }
        return try await afterAction(app, message)
    }

    func typeText(_ args: Arguments) async throws -> ToolResult {
        let (app, _) = try target(args)
        let text = try args.requiredText("text")
        guard !text.isEmpty else {
            throw ToolError("\"text\" must not be empty.")
        }
        try checkInputTarget(app)
        let pid = app.processIdentifier
        let focused = focusedElement(pid)
        var note = ""
        if let focused, !Self.textRoles.contains(focused.string(kAXRoleAttribute) ?? ""),
           focused.value(kAXSelectedTextRangeAttribute) == nil {
            note = " Keyboard focus is on \(describe(focused)), not a text field; click the field first if the text went missing."
        } else if focused == nil {
            note = " The app reports no focused element; click the field first if the text went missing."
        }

        // Insert directly when the frontmost app's input method would compose
        // keystrokes, or when the text is long enough that keystrokes are slow.
        let imeWouldCompose = frontmostProcessID() == pid && Input.inputMethodActive()
        if imeWouldCompose || text.count > 200, let focused, focused.isSettable(kAXSelectedTextAttribute) {
            let before = focused.string(kAXValueAttribute)
            if (try? focused.set(kAXSelectedTextAttribute, text as CFString)) != nil,
               before == nil || focused.string(kAXValueAttribute) != before {
                return try await afterAction(app, "Entered \(text.count) character(s) (accessibility).\(note)")
            }
        }
        let before = focused?.string(kAXValueAttribute)
        await Input.type(text, to: pid)
        await Input.pause(0.15)
        if let focused, let before, focused.string(kAXValueAttribute) == before,
           focused.isSettable(kAXSelectedTextAttribute),
           (try? focused.set(kAXSelectedTextAttribute, text as CFString)) != nil {
            return try await afterAction(app, "Entered \(text.count) character(s) (the app ignored background keystrokes, so they were inserted through accessibility).\(note)")
        }
        return try await afterAction(app, "Typed \(text.count) character(s) (sent to the app in the background).\(note)")
    }

    // MARK: - Helpers

    private var briefFocusEnabled: Bool {
        ProcessInfo.processInfo.environment["SKFIY_BRIEF_FOCUS"] == "1"
    }

    /// Waits (up to 3 s) until the user has not typed or moved the mouse for
    /// 0.8 s, so a brief focus never lands in the middle of their typing.
    private func waitForUserIdle() async -> Bool {
        for _ in 0..<15 {
            if Input.userIdleSeconds() >= 0.8 {
                return true
            }
            await Input.pause(0.2)
        }
        return false
    }

    /// The items of a pop-up button's (closed) menu.
    private func popupOptions(_ popup: AXUIElement) -> [(element: AXUIElement, title: String)] {
        guard let menu = popup.elements(kAXChildrenAttribute).first(where: { $0.string(kAXRoleAttribute) == kAXMenuRole }) else {
            return []
        }
        return menu.elements(kAXChildrenAttribute).compactMap { item in
            let values = item.multipleValues([kAXTitleAttribute, kAXValueAttribute])
            guard let title = nonEmpty(values[kAXTitleAttribute].flatMap(axString) ?? values[kAXValueAttribute].flatMap(axDisplayValue)) else {
                return nil
            }
            return (item, title)
        }
    }

    /// Selects a pop-up option without opening the pop-up: press the menu item
    /// (native pop-ups), set the value, or focus it and type the option's name
    /// (HTML selects), verifying each step.
    private func chooseOption(_ popup: AXUIElement, _ option: String, app: NSRunningApplication) async throws -> String {
        let wanted = option.trimmingCharacters(in: .whitespaces).lowercased()
        let selected = { (popup.string(kAXValueAttribute) ?? "").trimmingCharacters(in: .whitespaces).lowercased() == wanted }
        let options = popupOptions(popup)
        if let item = options.first(where: { $0.title.lowercased() == wanted })
            ?? options.first(where: { $0.title.lowercased().contains(wanted) }),
           (try? item.element.perform(kAXPressAction)) != nil {
            await Input.pause(0.2)
            if selected() || popup.string(kAXValueAttribute) == nil {
                return "pressed the option through accessibility"
            }
        }
        if popup.isSettable(kAXValueAttribute), (try? popup.set(kAXValueAttribute, option as CFString)) != nil {
            await Input.pause(0.2)
            if selected() { return "set through accessibility" }
        }
        try checkInputTarget(app)
        _ = try? popup.set(kAXFocusedAttribute, kCFBooleanTrue)
        await Input.pause(0.1)
        await Input.type(option, to: app.processIdentifier)
        await Input.pause(0.3)
        if selected() { return "focused it and typed the option name" }
        let names = options.map { quote($0.title, limit: 40) }.joined(separator: ", ")
        throw ToolError("Could not choose \(quote(option, limit: 60)); the value is still \(quote(popup.string(kAXValueAttribute) ?? "?", limit: 60)).\(names.isEmpty ? "" : " Options: \(names).")")
    }

    private func isInWebContentAt(pid: pid_t, point: CGPoint) -> Bool {
        hitTest(pid: pid, at: point).map(isInWebContent) ?? false
    }

    private func isInWebContent(_ element: AXUIElement) -> Bool {
        var current: AXUIElement? = element
        for _ in 0..<40 {
            guard let candidate = current else { return false }
            switch candidate.string(kAXRoleAttribute) {
            case "AXWebArea": return true
            case "AXWindow", "AXApplication": return false
            default: current = candidate.element(kAXParentAttribute)
            }
        }
        return false
    }

    private func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw ToolError("Accessibility permission is not granted to the app hosting skfiy (e.g. your terminal). Run `skfiy doctor`, grant it in System Settings → Privacy & Security → Accessibility, then restart that app.")
        }
    }

    /// Resolves the `app` argument to a running app with a session.
    private func target(_ args: Arguments) throws -> (NSRunningApplication, AppSession) {
        try requireAccessibility()
        let query = try args.requiredString("app")
        guard case .running(let app) = try directory.resolve(query) else {
            throw ToolError("\(query) is not running. Call get_app_state first; it launches the app in the background.")
        }
        guard let session = sessions[app.processIdentifier] else {
            throw ToolError("No state for \(app.localizedName ?? query) yet. Call get_app_state first.")
        }
        return (app, session)
    }

    private func checkInputTarget(_ app: NSRunningApplication) throws {
        guard !isScreenLocked() else {
            throw ToolError("The screen is locked. No input was sent.")
        }
        guard !app.isTerminated else {
            throw ToolError("\(app.localizedName ?? "The app") has quit.")
        }
    }

    private func checkPointerTarget(_ app: NSRunningApplication) throws {
        try checkInputTarget(app)
        if app.isHidden {
            throw ToolError("\(app.localizedName ?? "The app") is hidden, and skfiy does not unhide windows. Use element_index actions or the keyboard.")
        }
    }

    private func runningApp(_ query: String, launch: Bool) async throws -> NSRunningApplication {
        switch try directory.resolve(query) {
        case .running(let app):
            return app
        case .installed(let url, _):
            guard launch else {
                throw ToolError("\(query) is not running.")
            }
            let previousFront = frontmostProcessID()
            let app = try await directory.launch(url)
            let appElement = AXUIElementCreateApplication(app.processIdentifier)
            for _ in 0..<50 {
                if app.isFinishedLaunching, !appElement.elements(kAXWindowsAttribute).isEmpty {
                    break
                }
                await Input.pause(0.2)
            }
            await Input.pause(0.3)
            // Some apps activate themselves while launching; hand the front back.
            if let previousFront, previousFront != app.processIdentifier,
               frontmostProcessID() == app.processIdentifier,
               let previous = NSRunningApplication(processIdentifier: previousFront) {
                _ = try? AXUIElementCreateApplication(previousFront).set(kAXFrontmostAttribute, kCFBooleanTrue)
                previous.activate(options: [])
            }
            return app
        }
    }

    /// Chromium and Electron build their accessibility tree only for
    /// assistive clients that ask for it.
    private func enableAccessibility(_ app: NSRunningApplication, _ appElement: AXUIElement) async {
        let pid = app.processIdentifier
        guard !accessibilityEnabled.contains(pid) else { return }
        accessibilityEnabled.insert(pid)
        var enabled = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        if isChromium(app) {
            enabled = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success || enabled
        }
        guard enabled else { return }
        // The web tree is built lazily after the first request; wait for it.
        for _ in 0..<12 {
            await Input.pause(0.25)
            if let window = appElement.element(kAXFocusedWindowAttribute), containsWebArea(window, budget: 400) {
                return
            }
        }
    }

    private func containsWebArea(_ root: AXUIElement, budget: Int) -> Bool {
        var queue = [root]
        var visited = 0
        while !queue.isEmpty, visited < budget {
            let element = queue.removeFirst()
            visited += 1
            if element.string(kAXRoleAttribute) == "AXWebArea" { return true }
            queue.append(contentsOf: element.elements(kAXChildrenAttribute))
        }
        return false
    }

    /// Settles, then returns a fresh screenshot and remaps coordinates to it.
    /// Element indices stay those of the last get_app_state.
    private func afterAction(_ app: NSRunningApplication, _ message: String) async throws -> ToolResult {
        await Input.pause(settleDelay)
        let pid = app.processIdentifier
        guard !app.isTerminated else {
            sessions[pid] = nil
            return ToolResult(text: message + "\nThe app quit.")
        }
        let window = sessions[pid]?.window ?? AXUIElementCreateApplication(pid).element(kAXFocusedWindowAttribute)
        guard !app.isHidden, let region = appRegion(pid: pid, focusedWindow: window?.frame) else {
            return ToolResult(text: message + "\nNo screenshot: the app has no visible window now. Call get_app_state to see its state.")
        }
        do {
            let screenshot = try await captureApp(pid: pid, rect: region)
            sessions[pid]?.geometry = screenshot.geometry
            return ToolResult(
                text: message + "\n" + screenshotLine(screenshot.geometry) + " Element indices are unchanged; call get_app_state for a fresh tree.",
                image: screenshot.data,
                imageMimeType: screenshot.mimeType
            )
        } catch let error as ToolError {
            return ToolResult(text: message + "\n(No screenshot: \(error.description))")
        }
    }

    private func focusedElement(_ pid: pid_t) -> AXUIElement? {
        AXUIElementCreateApplication(pid).element(kAXFocusedUIElementAttribute)
    }

    /// The app's own element under a screen point; works for covered windows.
    private func hitTest(pid: pid_t, at point: CGPoint) -> AXUIElement? {
        var element: AXUIElement?
        let status = AXUIElementCopyElementAtPosition(
            AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &element
        )
        return status == .success ? element : nil
    }

    private func ancestor(of element: AXUIElement, levels: Int, where matches: (AXUIElement) -> Bool) -> AXUIElement? {
        var current: AXUIElement? = element
        for _ in 0...levels {
            guard let candidate = current else { return nil }
            if matches(candidate) {
                return candidate
            }
            let role = candidate.string(kAXRoleAttribute) ?? ""
            if role == "AXWindow" || role == "AXApplication" || role == "AXWebArea" {
                return nil
            }
            current = candidate.element(kAXParentAttribute)
        }
        return nil
    }

    /// The caret index a click at `point` would produce.
    private func textIndex(in element: AXUIElement, at point: CGPoint) -> Int? {
        let length = (element.string(kAXValueAttribute) as NSString?)?.length ?? 0
        // Below the last line a click lands at the end; AXRangeForPosition says 0.
        if length > 0, let last = textBounds(in: element, range: CFRange(location: length - 1, length: 1)),
           point.y > last.maxY {
            return length
        }
        var position = point
        guard let value = AXValueCreate(.cgPoint, &position) else { return nil }
        var result: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, "AXRangeForPosition" as CFString, value, &result) == .success,
              let result, CFGetTypeID(result) == AXValueGetTypeID() else {
            return nil
        }
        var range = CFRange()
        return AXValueGetValue(result as! AXValue, .cfRange, &range) ? range.location : nil
    }

    private func textBounds(in element: AXUIElement, range: CFRange) -> CGRect? {
        var range = range
        guard let value = AXValueCreate(.cfRange, &range) else { return nil }
        var result: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, "AXBoundsForRange" as CFString, value, &result) == .success,
              let result, CFGetTypeID(result) == AXValueGetTypeID() else {
            return nil
        }
        var rect = CGRect.zero
        return AXValueGetValue(result as! AXValue, .cgRect, &rect) && rect.height > 0 ? rect : nil
    }

    private func setCaret(_ element: AXUIElement, _ location: Int) {
        try? setSelection(element, CFRange(location: location, length: 0))
    }

    private func setSelection(_ element: AXUIElement, _ range: CFRange) throws {
        var selection = range
        guard let value = AXValueCreate(.cfRange, &selection) else {
            throw ToolError("Could not build the selection range.")
        }
        try element.set(kAXSelectedTextRangeAttribute, value)
    }

    /// Standard shortcuts that need the app to be active, done through
    /// accessibility on the focused element or window.
    private func emulateShortcut(_ chord: KeyChord, pid: pid_t) throws -> String? {
        guard chord.modifiers == .command, let character = chord.baseCharacter else { return nil }
        let appElement = AXUIElementCreateApplication(pid)
        let focused = appElement.element(kAXFocusedUIElementAttribute)
        let text = focused.flatMap { element -> AXUIElement? in
            Self.textRoles.contains(element.string(kAXRoleAttribute) ?? "")
                || element.value(kAXSelectedTextRangeAttribute) != nil ? element : nil
        }
        let window = appElement.element(kAXFocusedWindowAttribute)
        switch character {
        case "a":
            guard let text else { return nil }
            let length = (text.string(kAXValueAttribute) as NSString?)?.length ?? 0
            try setSelection(text, CFRange(location: 0, length: length))
            return "selected all text in the focused field"
        case "c", "x":
            guard let text, let selected = text.string(kAXSelectedTextAttribute), !selected.isEmpty else { return nil }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(selected, forType: .string)
            if character == "x" {
                try text.set(kAXSelectedTextAttribute, "" as CFString)
                return "cut the selected text to the clipboard"
            }
            return "copied the selected text to the clipboard"
        case "v":
            guard let text, let clipboard = NSPasteboard.general.string(forType: .string) else { return nil }
            try text.set(kAXSelectedTextAttribute, clipboard as CFString)
            return "pasted the clipboard text into the focused field"
        case "w":
            guard let close = window?.element(kAXCloseButtonAttribute) else { return nil }
            try close.perform(kAXPressAction)
            return "pressed the window's close button"
        case "m":
            guard let window else { return nil }
            try window.set(kAXMinimizedAttribute, kCFBooleanTrue)
            return "minimized the window"
        default:
            return nil
        }
    }

    /// Finds the menu item whose shortcut is `chord`, preferring enabled ones.
    private func menuItem(for chord: KeyChord, pid: pid_t) -> (element: AXUIElement, title: String, enabled: Bool)? {
        guard case .code(let code) = chord.key,
              let menuBar = AXUIElementCreateApplication(pid).element(kAXMenuBarAttribute) else {
            return nil
        }
        let character = chord.baseCharacter
        var wantedModifiers = 0
        if chord.modifiers.contains(.shift) { wantedModifiers |= 1 }
        if chord.modifiers.contains(.option) { wantedModifiers |= 2 }
        if chord.modifiers.contains(.control) { wantedModifiers |= 4 }
        if !chord.modifiers.contains(.command) { wantedModifiers |= 8 }

        var disabled: (AXUIElement, String, Bool)?
        func search(_ menu: AXUIElement, depth: Int) -> (AXUIElement, String, Bool)? {
            for item in menu.elements(kAXChildrenAttribute) {
                let values = item.multipleValues([
                    kAXTitleAttribute, kAXEnabledAttribute, kAXMenuItemCmdCharAttribute,
                    kAXMenuItemCmdModifiersAttribute, kAXMenuItemCmdVirtualKeyAttribute, kAXChildrenAttribute
                ])
                let modifiers = (values[kAXMenuItemCmdModifiersAttribute] as? NSNumber)?.intValue ?? 0
                let itemChar = values[kAXMenuItemCmdCharAttribute].flatMap(axString)?.lowercased()
                let itemKey = (values[kAXMenuItemCmdVirtualKeyAttribute] as? NSNumber)?.intValue
                let keyMatches = (itemChar != nil && !itemChar!.isEmpty && itemChar == character)
                    || (itemChar == nil || itemChar!.isEmpty) && itemKey == Int(code)
                if keyMatches, modifiers == wantedModifiers {
                    let enabled = (values[kAXEnabledAttribute] as? NSNumber)?.boolValue != false
                    let title = values[kAXTitleAttribute].flatMap(axString) ?? ""
                    if enabled {
                        return (item, title, true)
                    }
                    disabled = disabled ?? (item, title, false)
                }
                if depth < 3, let submenu = ((values[kAXChildrenAttribute] as? [AXUIElement]) ?? []).first,
                   let found = search(submenu, depth: depth + 1) {
                    return found
                }
            }
            return nil
        }
        for barItem in menuBar.elements(kAXChildrenAttribute) {
            if let menu = barItem.elements(kAXChildrenAttribute).first, let found = search(menu, depth: 0) {
                return found
            }
        }
        return disabled
    }

    private func screenPoint(_ args: Arguments, _ xKey: String, _ yKey: String, session: AppSession) throws -> CGPoint {
        guard let x = try args.double(xKey), let y = try args.double(yKey) else {
            throw ToolError("Pass both \(xKey) and \(yKey) (or an element_index).")
        }
        guard let geometry = session.geometry else {
            throw ToolError("There is no screenshot to map coordinates from. Call get_app_state first.")
        }
        guard geometry.containsPixel(x: x, y: y) else {
            throw ToolError("(\(formatNumber(x)), \(formatNumber(y))) is outside the latest \(geometry.pixelWidth)×\(geometry.pixelHeight) screenshot.")
        }
        return geometry.toScreen(x: x, y: y)
    }

    private func visibleCenter(of element: AXUIElement, session: AppSession) async throws -> CGPoint {
        guard var frame = element.frame, frame.width >= 1, frame.height >= 1 else {
            throw ToolError("That element has no on-screen frame. Use x/y from the screenshot instead.")
        }
        let viewport = session.geometry?.rect ?? displayBounds(containing: CGPoint(x: frame.midX, y: frame.midY))
        if !frame.intersects(viewport), element.actionNames().contains("AXScrollToVisible") {
            _ = try? element.perform("AXScrollToVisible")
            await Input.pause(0.3)
            frame = element.frame ?? frame
        }
        let visible = frame.intersection(viewport)
        let area = visible.isNull || visible.width < 1 || visible.height < 1 ? frame : visible
        return CGPoint(x: area.midX, y: area.midY)
    }

    private func describe(_ element: AXUIElement) -> String {
        let values = element.multipleValues([kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
        let role = values[kAXRoleAttribute].flatMap(axString).map { $0.hasPrefix("AX") ? String($0.dropFirst(2)) : $0 } ?? "element"
        let label = nonEmpty(values[kAXTitleAttribute].flatMap(axString)) ?? nonEmpty(values[kAXDescriptionAttribute].flatMap(axString))
        return label.map { "\(role) \(quote($0, limit: 60))" } ?? role
    }
}

private func asElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func parseModifierList(_ raw: String?) throws -> Modifiers {
    guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
    // Reuse the chord parser: "cmd+shift" parses as a modifier tap plus modifiers.
    let chord = try parseKeyChord(raw)
    var modifiers = chord.modifiers
    if case .code(let code) = chord.key,
       let modifier = Modifiers.physical.first(where: { $0.1 == code })?.0 {
        modifiers.insert(modifier)
    } else {
        throw KeyParseError(description: "modifiers must only name modifier keys, e.g. \"cmd\" or \"shift+alt\".")
    }
    return modifiers
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

/// Finds `text` in `content` (UTF-16 offsets, as AX expects), disambiguated by
/// the text immediately before and after it.
func locateText(_ text: String, in content: String, prefix: String, suffix: String) throws -> NSRange {
    let haystack = content as NSString
    var matches: [NSRange] = []
    var searchRange = NSRange(location: 0, length: haystack.length)
    while searchRange.length > 0 {
        let found = haystack.range(of: text, options: [], range: searchRange)
        guard found.location != NSNotFound else { break }
        let before = haystack.substring(to: found.location)
        let after = haystack.substring(from: found.location + found.length)
        if before.hasSuffix(prefix), after.hasPrefix(suffix) {
            matches.append(found)
        }
        let next = found.location + max(found.length, 1)
        searchRange = NSRange(location: next, length: haystack.length - next)
    }
    switch matches.count {
    case 0:
        throw ToolError("Text \(quote(text, limit: 80)) was not found in the element\(prefix.isEmpty && suffix.isEmpty ? "" : " with that prefix/suffix").")
    case 1:
        return matches[0]
    default:
        throw ToolError("Text \(quote(text, limit: 80)) occurs \(matches.count) times; pass prefix and/or suffix to pick one.")
    }
}

func formatNumber(_ value: Double) -> String {
    value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
}

/// Chromium-based browsers (Chrome, Chrome for Testing, Edge, Brave, Arc...).
func isChromium(_ app: NSRunningApplication) -> Bool {
    let bundleID = (app.bundleIdentifier ?? "").lowercased()
    let prefixes = ["com.google.chrome", "org.chromium.", "com.microsoft.edgemac", "com.brave.browser",
                    "com.vivaldi.vivaldi", "company.thebrowser.", "com.operasoftware.", "ai.perplexity.comet"]
    return prefixes.contains { bundleID.hasPrefix($0) }
        || FileManager.default.fileExists(atPath: (app.bundleURL?.path ?? "") + "/Contents/Frameworks/Chromium Framework.framework")
}
