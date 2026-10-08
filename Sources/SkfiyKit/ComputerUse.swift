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
    var geometry: CaptureGeometry? {
        didSet { if geometry != nil { captured = Date() } else if oldValue != nil { captured = nil } }
    }
    /// The window get_app_state showed, when it was not the focused one.
    var window: AXUIElement?
    /// When the latest screenshot was taken, and the latest zoom of it.
    var captured: Date?
    var zoom: ZoomMapping?
    /// The window the screenshot was about, and where it was then: pixels
    /// map to the screen only while it stays there.
    var windowID: CGWindowID?
    var windowFrame: CGRect?
    /// The screenshot showed that window on its own (it was inspected by
    /// name or id), not the app's windows as they overlap in its region.
    var independent = false
    /// The app's windows when skfiy last looked at it (get_app_state, or
    /// the screenshot after an action): a window not among them that took
    /// the keyboard was opened since (see keyWindowMoved).
    var knownWindows: Set<CGWindowID> = []
    /// The pixels of the latest screenshot the model was given: an action
    /// that leaves them as they were sends no new one.
    var shownFingerprint: PixelFingerprint?
    /// Which numbering the indices belong to: a full get_app_state starts a
    /// new one; get_app_state with since keeps it.
    var epoch: Int

    private static var epochs = 0

    init(elements: [AXUIElement], geometry: CaptureGeometry?, window: AXUIElement?, epoch: Int? = nil) {
        self.elements = elements
        self.geometry = geometry
        self.window = window
        captured = geometry == nil ? nil : Date()
        if let epoch {
            self.epoch = epoch
        } else {
            Self.epochs += 1
            self.epoch = Self.epochs
        }
    }

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
    let directory = AppDirectory()
    var sessions: [pid_t: AppSession] = [:]
    var zoomCount = 0
    private var accessibilityEnabled: Set<pid_t> = []
    /// Flutter apps whose AXEnhancedUserInterface skfiy turned on: app-wide
    /// and costly for them, so it is turned off again when skfiy disconnects.
    private var enhancedInterfaceSet: Set<pid_t> = []
    /// Apps the user allowed brief focus for, this session.
    var focusApproved: Set<pid_t> = []
    /// What cmd+c / cmd+x copied (or read_clipboard took, with the user's
    /// approval). The system clipboard belongs to the user.
    var clipboard: ClipboardContents?
    /// Asks the user a yes/no question through the client; nil when it cannot.
    public var askUser: ((String) async -> Bool?)? {
        didSet { browser.askUser = askUser }
    }
    /// Like askUser, but waits long enough for the user to do something
    /// themselves (sign in, enter a code); nil when the client cannot ask.
    public var waitForUser: ((String) async -> Bool?)?
    let settleDelay: Double
    let directLockedUse = DirectLockedUse()
    /// Refuses repeating a risky action whose effect was not verified.
    var repeatGuard = RepeatGuard()
    /// The last capability report per app, to say what changed since.
    var capabilityHistory: [String: CapabilityReport] = [:]
    /// Whether the client can ask the user (MCP elicitation); nil when unknown.
    public var clientCanAsk: (() -> Bool)?
    /// The last few looks per app, for get_app_state since.
    var stateHistory: [pid_t: [StateRecord]] = [:]
    /// The text field a click last focused, per app: a background Chromium
    /// app (Electron) reports no focused element, so typing needs to know.
    var typingTargets: [pid_t: AXUIElement] = [:]

    public func disconnect() {
        _ = directLockedUse.status(end: true)
        restoreEnhancedInterface()
        forgetApps()
    }

    /// Turns Flutter's semantics back off where skfiy turned them on.
    func restoreEnhancedInterface() {
        for pid in enhancedInterfaceSet where NSRunningApplication(processIdentifier: pid)?.isTerminated == false {
            _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
        }
        enhancedInterfaceSet.removeAll()
    }

    /// Element indices, earlier looks, and what was enabled or approved per
    /// process: none of it carries over a disconnect or a lock change.
    private func forgetApps() {
        sessions.removeAll()
        stateHistory.removeAll()
        accessibilityEnabled.removeAll()
        focusApproved.removeAll()
    }

    public init() {
        settleDelay = Double(ProcessInfo.processInfo.environment["SKFIY_SETTLE_SECONDS"] ?? "") ?? 0.4
    }

    nonisolated public static let toolNames = (ToolSchemas.all + ToolSchemas.browser).map(\.name)

    private let browser = BrowserTools()

    /// Runs a tool and records what it changed in the action log.
    public func call(_ name: String, _ raw: [String: Any]) async -> ToolResult {
        if DirectLockedUse.enabled {
            if directLockedUse.observeTransition() { forgetApps() }
            if name == "locked_use_end" { return directLockedUse.status(end: true) }
        }
        if name == "locked_use_end" {
            return ToolResult(text: "Locked use is off. To keep macOS locked while skfiy works, the user starts a new MCP session with SKFIY_LOCKED_USE=direct.")
        }
        lastInputWasSecret = false
        browser.lastInputWasSecret = false
        let result = await act(name, raw)
        if ["get_app_state", "wait_for"].contains(name), !result.isError { noteLooked(raw) }
        actionLog?.record(tool: name, arguments: raw, result: result, secret: lastInputWasSecret || browser.lastInputWasSecret)
        return result
    }

    private func act(_ name: String, _ raw: [String: Any]) async -> ToolResult {
        var raw = raw
        var note: String?
        // A target is resolved against the UI as it is now, then acted on by
        // element_index or x/y like any other call.
        if raw["target"] != nil, !name.hasPrefix("browser_"), name != "locate", !EmergencyStop.isStopped {
            do {
                if let resolved = try await resolveTarget(name, raw) {
                    raw = resolved.raw
                    note = resolved.note
                }
            } catch let error as ToolError {
                return ToolResult(text: error.description, isError: true)
            } catch {
                return ToolResult(text: "\(error)", isError: true)
            }
        }
        var result = Self.verifiableTools.contains(name) ? await performVerified(name, raw) : await perform(name, raw)
        if let note { result.text = note + "\n" + result.text }
        return result
    }

    /// Where actions are recorded; nil records nothing.
    var actionLog = ActionLog.standard

    /// Typing or a value went into a password field, so the log keeps only its length.
    var lastInputWasSecret = false
    /// Tools that work on an app's window: while macOS is locked (direct
    /// mode) they take the locked path, which refuses those it cannot serve.
    private static let lockedPathTools = ToolSchemas.names([.whileLocked, .refusedWhileLocked])
    private static let answeringWhileStopped = ToolSchemas.names(.whileStopped)

    func perform(_ name: String, _ raw: [String: Any]) async -> ToolResult {
        let args = Arguments(raw)
        if DirectLockedUse.isActive, name == "type_text" || name == "press_key" || name == "set_value" {
            lastInputWasSecret = true
        }
        if EmergencyStop.isStopped, !Self.answeringWhileStopped.contains(name) {
            return ToolResult(text: EmergencyStop.refusal, isError: true)
        }
        do {
            if Self.inputTools.contains(name) || name == "scroll" {
                try refuseProtectedTarget(args, scrolling: name == "scroll")
            }
            if DirectLockedUse.isActive, Self.lockedPathTools.contains(name) {
                // No foreground preservation, AX fallback, menu emulation, or
                // clipboard logic is entered by this strictly scoped path.
                if name == "scroll" { try refuseProtectedTarget(args) }
                if name == "locate" { return try await locate(args) }
                return try await directLockedUse.perform(name, args)
            }
            switch name {
            case "list_apps": return listApps()
            case "get_desktop_status":
                if DirectLockedUse.enabled { return directLockedUse.status() }
                return ToolResult(text: "Desktop: \(isScreenLocked() ? "locked or unavailable" : "unlocked").\nLocked use: off.\nEmergency stop: \(EmergencyStop.isStopped ? "stopped" : "running").")
            case "get_app_state": return try await keepingFront(args, readOnly: true) { try await self.getAppState(args) }
            case "get_app_capabilities": return try await appCapabilities(args)
            case "click": return try await keepingFront(args) { try await self.click(args) }
            case "perform_secondary_action": return try await keepingFront(args) { try await self.performSecondaryAction(args) }
            case "set_value": return try await keepingFront(args) { try await self.setValue(args) }
            case "select_text": return try await keepingFront(args) { try await self.selectText(args) }
            case "scroll": return try await keepingFront(args) { try await self.scroll(args) }
            case "drag": return try await keepingFront(args) { try await self.drag(args) }
            case "press_key": return try await keepingFront(args) { try await self.pressKey(args) }
            case "type_text": return try await keepingFront(args) { try await self.typeText(args) }
            case "open_file": return try await keepingFront(args) { try await self.openFile(args) }
            case "save_document": return try await keepingFront(args) { try await self.saveDocument(args) }
            case "run_in_front":
                return try await runInFront(args)
            case "zoom": return try await zoom(args)
            case "wait_for": return try await waitFor(args)
            case "locate": return try await locate(args)
            case "flow_start": return try await flowStart(args)
            case "flow_record": return try await flowRecord(args)
            case "flow_status": return try await flowStatus(args)
            case "read_clipboard": return try await readClipboard(args)
            case "hand_over": return try await handOver(args)
            case "file_dialog": return try await keepingFront(args) { try await self.fileDialog(args) }
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
    private func keepingFront(_ args: Arguments, readOnly: Bool = false, _ body: () async throws -> ToolResult) async throws -> ToolResult {
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
        let guardian = FrontGuard(userApp: before, target: target?.processIdentifier, onlyTarget: readOnly)
        var result: ToolResult
        do {
            result = try await body()
            await Input.pause(0.15)
        } catch {
            guardian.stop()
            throw error
        }
        let taker = guardian.stop(lingering: 2)
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
                _ = guardedAXPerformAction(window, kAXRaiseAction as CFString)
                let name = NSRunningApplication(processIdentifier: top.pid)?.localizedName ?? "The app"
                notes.append("\(name) put a window over the user's; skfiy put \(user)'s window back on top.")
            }
            if let target, target.processIdentifier != before {
                let popped = overlayWindows(of: target.processIdentifier).filter { !overlaysBefore.contains($0) }
                if !popped.isEmpty {
                    let appElement = AXUIElementCreateApplication(target.processIdentifier)
                    for menu in appElement.elements(kAXChildrenAttribute) where menu.string(kAXRoleAttribute) == kAXMenuRole {
                        _ = guardedAXPerformAction(menu, kAXCancelAction as CFString)
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
    static let inputTools = ToolSchemas.names(.input)

    lazy var hostProcesses = ancestorProcessIDs()

    /// Typing into a terminal runs shell commands, sidestepping the MCP
    /// client's permission checks, and the app hosting the agent must never
    /// receive input from it.
    private func refuseProtectedTarget(_ args: Arguments, scrolling: Bool = false) throws {
        guard let query = args.string("app"), case .running(let app)? = try? directory.resolve(query) else { return }
        let name = app.localizedName ?? query
        if isProtectedInterface(app) {
            throw ToolError("\(name) is a system authentication or locked-use protection interface. skfiy never sends it agent-directed input; unlock manually if needed.")
        }
        // Scrolling ordinary terminals/host windows has always been supported.
        if scrolling { return }
        if hostProcesses.contains(app.processIdentifier) {
            throw ToolError("\(name) is hosting this agent, so skfiy never sends it input. Reading it with get_app_state still works.")
        }
        if isTerminal(bundleID: app.bundleIdentifier), ProcessInfo.processInfo.environment["SKFIY_ALLOW_TERMINALS"] != "1" {
            throw ToolError("\(name) is a terminal: whatever is typed there runs as shell commands, outside your client's permission checks, so skfiy does not send it input (get_app_state and scroll still work). Use your own shell tool if you have one; the user can allow terminals with SKFIY_ALLOW_TERMINALS=1.")
        }
    }

    func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw ToolError("Accessibility permission is not granted to the app hosting skfiy (e.g. your terminal). Run `skfiy doctor`, grant it in System Settings → Privacy & Security → Accessibility, then restart that app.")
        }
    }

    /// Resolves the `app` argument to a running app with a session.
    func target(_ args: Arguments) throws -> (NSRunningApplication, AppSession) {
        try requireAccessibility()
        let query = try args.requiredString("app")
        guard case .running(let app) = try directory.resolve(query) else {
            throw ToolError("\(query) is not running. Call get_app_state first; it launches the app in the background.")
        }
        guard let session = sessions[app.processIdentifier] else {
            throw ToolError("No state for \(app.localizedName ?? query) yet. Call get_app_state first.")
        }
        try checkWindowID(args, session: session)
        if let index = try args.elementIndex() { try checkElementWindow(index, session: session, app: app) }
        return (app, session)
    }

    func checkInputTarget(_ app: NSRunningApplication) throws {
        guard !isScreenLocked() else {
            throw ToolError("The screen is locked. No input was sent.")
        }
        guard !app.isTerminated else {
            throw ToolError("\(app.localizedName ?? "The app") has quit.")
        }
    }

    /// The running app `query` names; an app that is only installed is
    /// launched in the background when `launch`, else refused.
    func runningApp(_ query: String, launch: Bool) async throws -> NSRunningApplication {
        switch try directory.resolve(query) {
        case .running(let app):
            return app
        case .installed(let url):
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
    func enableAccessibility(_ app: NSRunningApplication, _ appElement: AXUIElement) async {
        let pid = app.processIdentifier
        guard !accessibilityEnabled.contains(pid) else { return }
        accessibilityEnabled.insert(pid)
        var enabled = guardedAXSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        let chromium = isChromium(app)
        let flutter = isFlutter(app)
        if chromium {
            enabled = guardedAXSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success || enabled
        } else if flutter {
            // Flutter builds its semantics tree only once AppKit posts the
            // enhanced-user-interface notification. NSApplication answers the
            // set with kAXErrorNotImplemented, yet stores it and posts it.
            let before = appElement.bool("AXEnhancedUserInterface")
            _ = guardedAXSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            if appElement.bool("AXEnhancedUserInterface") == true {
                enabled = true
                if before != true { enhancedInterfaceSet.insert(pid) }
            }
        }
        guard enabled else { return }
        // The web tree (and Flutter's semantics) is built lazily after the first request; wait for it.
        for _ in 0..<12 {
            await Input.pause(0.25)
            if let window = appElement.element(kAXFocusedWindowAttribute) ?? appElement.elements(kAXWindowsAttribute).first,
               flutter ? containsFlutterSemantics(window) : containsWebArea(window, budget: 400) {
                return
            }
        }
        // Chromium builds no tree for a window it is not drawing (fully
        // covered): ask again next time instead of taking the window as opaque.
        if chromium, chromiumWindowFrozen(app, window: focusedWindowID(of: pid)) {
            accessibilityEnabled.remove(pid)
        }
    }

    /// Whether Flutter has published semantics nodes (anything beyond its view's group).
    private func containsFlutterSemantics(_ window: AXUIElement) -> Bool {
        let content: Set<String> = ["AXStaticText", "AXButton", "AXTextField", "AXTextArea", "AXImage", "AXLink", "AXCheckBox", "AXSlider"]
        return window.descendant(limit: 400, where: { element in
            content.contains(element.string(kAXRoleAttribute) ?? "") && element.string(kAXSubroleAttribute).map { !$0.hasSuffix("Button") || $0 == "AXButton" } ?? true
        }) != nil
    }

    /// Whether `root` or one of the first elements below it is web content.
    private func containsWebArea(_ root: AXUIElement, budget: Int) -> Bool {
        let isWeb = { (element: AXUIElement) in element.string(kAXRoleAttribute) == "AXWebArea" }
        return isWeb(root) || root.descendant(limit: budget - 1, where: isWeb) != nil
    }

    /// Settles, then returns a fresh screenshot and remaps coordinates to it.
    /// Element indices stay those of the last get_app_state.
    func afterAction(_ app: NSRunningApplication, _ message: String) async throws -> ToolResult {
        await Input.pause(settleDelay)
        let pid = app.processIdentifier
        guard !app.isTerminated else {
            sessions[pid] = nil
            return ToolResult(text: message + "\nThe app quit.")
        }
        // A window the action opened that took the keyboard (a new document,
        // a dialog) is where the model works now: it is shown, and keys follow it.
        let followed = followNewKeyWindow(pid)
        let message = message + followed
        // The action closed the window inspected by name, and no window it
        // opened took over: the session keeps naming the closed window, so
        // keyboardTarget refuses keys until the model looks at the app again.
        if inspectedWindowClosed(pid) {
            return ToolResult(text: message + "\nNo screenshot: the window you were working in is closed. Call get_app_state to see the app's windows.")
        }
        // A background Electron app may report no focused window: then its main or first one.
        let appElement = AXUIElementCreateApplication(pid)
        let window = sessions[pid]?.window ?? appElement.element(kAXFocusedWindowAttribute) ?? appElement.element(kAXMainWindowAttribute)
            ?? appElement.elements(kAXWindowsAttribute).first { $0.string(kAXRoleAttribute) == kAXWindowRole }
        if appIsHidden(app) || window?.bool(kAXMinimizedAttribute) == true {
            return ToolResult(text: message + "\nNo screenshot: " + (appIsHidden(app) ? "the app is hidden" : "the window is minimized") + ", and skfiy does not bring windows forward. Call get_app_state for its tree.")
        }
        guard let region = appRegion(pid: pid, focusedWindow: window?.frame) else {
            return ToolResult(text: message + "\nNo screenshot: the app has no visible window now. Call get_app_state to see its state.")
        }
        let id = window.flatMap(windowID(of:))
        // Chromium neither draws nor updates a window that is fully covered:
        // an unchanged picture says nothing about the action's effect.
        let frozen = chromiumWindowFrozen(app, window: id)
        do {
            // A window inspected by name is captured on its own, as get_app_state
            // did: as a region, another window of the app above it (RustDesk's
            // remote session over its main window) would show instead.
            // Sheets and panels attached to it are drawn on it, as the user sees them.
            let independent = sessions[pid]?.window.flatMap { independentWindow($0, pid: pid) }
            let screenshot: Screenshot
            if let independent {
                screenshot = try await captureDirectLockedWindow(independent, maxScale: 1, children: true)
            } else {
                screenshot = try await captureApp(pid: pid, rect: region)
            }
            let fingerprint = TextRecognition.decode(screenshot.data).flatMap { PixelFingerprint($0, region: nil) }
            if followed.isEmpty, let session = sessions[pid], session.geometry == screenshot.geometry,
               let shown = session.shownFingerprint, let now = fingerprint, !now.changed(from: shown) {
                if frozen {
                    return ToolResult(text: message + "\nThe screenshot is unchanged, but that proves nothing: " + frozenNote(app) + " Its x/y still hold.")
                }
                // The model already has this picture; a second copy would only take up its context.
                return ToolResult(text: message + "\nThe window looks the same as in the latest screenshot, so none is attached; its x/y still hold. Element indices are unchanged; call get_app_state for a fresh tree.")
            }
            sessions[pid]?.geometry = screenshot.geometry
            sessions[pid]?.windowID = id
            sessions[pid]?.windowFrame = window?.frame
            sessions[pid]?.shownFingerprint = fingerprint
            sessions[pid]?.independent = independent != nil
            return ToolResult(
                text: message + "\n" + screenshotLine(screenshot.geometry) + " Element indices are unchanged; call get_app_state for a fresh tree."
                    + (frozen ? " " + frozenNote(app) : ""),
                image: screenshot.data,
                imageMimeType: screenshot.mimeType
            )
        } catch let error as ToolError {
            let reason = error.description.hasPrefix("No screenshot: ") ? String(error.description.dropFirst("No screenshot: ".count)) : error.description
            return ToolResult(text: message + "\n(No screenshot: \(reason))")
        }
    }

    func focusedElement(_ pid: pid_t) -> AXUIElement? {
        AXUIElementCreateApplication(pid).element(kAXFocusedUIElementAttribute)
    }

    /// A text field, or anything else with a text selection.
    func isTextLike(_ element: AXUIElement) -> Bool {
        Self.textRoles.contains(element.string(kAXRoleAttribute) ?? "") || element.value(kAXSelectedTextRangeAttribute) != nil
    }

    /// The app's own element under a screen point; works for covered windows.
    /// Accessibility answers for the app's topmost window there: when the
    /// latest screenshot showed a window on its own and another window of the
    /// app lies over it at that point, the element is looked up in the
    /// screenshot's window instead (nothing of the other one was meant).
    func hitTest(pid: pid_t, at point: CGPoint) -> AXUIElement? {
        var element: AXUIElement?
        let status = AXUIElementCopyElementAtPosition(
            AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &element
        )
        let hit = status == .success ? element : nil
        let shallow = { (element: AXUIElement) in element.string(kAXRoleAttribute) == kAXWindowRole }
        if let session = sessions[pid], session.independent, let shown = session.windowID,
           pointerWindow(pid: pid, at: point) == shown {
            if let hit, containingWindow(of: hit).flatMap(windowID(of:)) == shown, !shallow(hit) { return hit }
            guard let window = session.window ?? axWindow(shown, pid: pid) else { return nil }
            return deepestElement(in: window, at: point) ?? (window.frame?.contains(point) == true ? window : nil)
        }
        // Flutter answers with the window itself; its controls are found by frame.
        if let hit, shallow(hit), let app = NSRunningApplication(processIdentifier: pid), isFlutter(app) {
            return deepestElement(in: hit, at: point) ?? hit
        }
        return hit
    }

    func screenPoint(_ args: Arguments, _ xKey: String, _ yKey: String, session: AppSession) throws -> CGPoint {
        if let zoomed = try zoomPoint(args, xKey, yKey, latest: session.zoom, screenshot: session.geometry, taken: session.captured,
                                      notDone: "nothing was done") {
            try checkWindowUnmoved(session)
            return zoomed
        }
        guard let x = try args.double(xKey), let y = try args.double(yKey) else {
            throw ToolError("Pass both \(xKey) and \(yKey) (or an element_index).")
        }
        try checkWindowUnmoved(session)
        guard let geometry = session.geometry else {
            throw ToolError("There is no screenshot to map coordinates from. Call get_app_state first.")
        }
        guard geometry.containsPixel(x: x, y: y) else {
            throw ToolError("(\(formatNumber(x)), \(formatNumber(y))) is outside the latest \(geometry.pixelWidth)×\(geometry.pixelHeight) screenshot.")
        }
        return geometry.toScreen(x: x, y: y)
    }

    /// Screenshot pixels say where things are only while the window they
    /// show is still there, at the same place and size.
    func checkWindowUnmoved(_ session: AppSession) throws {
        guard let id = session.windowID, let then = session.windowFrame else { return }
        let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
        // Minimized, hidden or on another desktop is not closed: say which.
        if rows.first?[kCGWindowIsOnscreen as String] as? Bool != true,
           let pid = sessions.first(where: { $0.value.windowID == id })?.key,
           let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated {
            let presence = presence(of: id, app: app)
            if let refusal = presence.refusal(window: axWindow(id, pid: pid)?.string(kAXTitleAttribute) ?? "", id: id,
                                                                 app: app.localizedName ?? "The app") {
                throw ToolError(refusal)
            }
        }
        guard let row = rows.first, let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let now = CGRect(dictionaryRepresentation: bounds) else {
            throw ToolError("The window of the latest screenshot (id \(id)) closed; if the app opened a new one, it has another id. Call get_app_state again; nothing was done.")
        }
        guard abs(now.minX - then.minX) < 1, abs(now.minY - then.minY) < 1, abs(now.width - then.width) < 1, abs(now.height - then.height) < 1 else {
            throw ToolError("The window moved or changed size since the latest screenshot (it was \(then), now \(now)), so its x/y would land elsewhere. Call get_app_state again; nothing was done.")
        }
    }

    /// An element index from a window that was closed meanwhile: a closed
    /// AppKit window can live on off screen, its buttons still pressable, and
    /// its controls can move into a new window (closed and recreated). Either
    /// way the model's picture of that window is out of date.
    func checkElementWindow(_ index: Int, session: AppSession, app: NSRunningApplication) throws {
        guard let shown = session.windowID, !appIsHidden(app), let element = session.elements[safe: index],
              let window = element.element(kAXWindowAttribute), window.bool(kAXMinimizedAttribute) != true else { return }
        let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], shown) as? [[String: Any]] ?? []
        guard rows.first?[kCGWindowIsOnscreen as String] as? Bool != true else { return }
        // Not on screen: closed, unless the app still lists it (another Space).
        let listed = AXUIElementCreateApplication(app.processIdentifier).elements(kAXWindowsAttribute).contains { windowID(of: $0) == shown }
        guard !listed else { return }
        let now = windowID(of: window)
        if now == shown || now == nil {
            throw ToolError("The window of the latest get_app_state (id \(shown)) was closed, and element [\(index)] was in it. Call get_app_state again; nothing was done.")
        }
        throw ToolError("The window of the latest get_app_state (id \(shown)) was closed; element [\(index)] is now in window id \(now!) (closed and recreated). Call get_app_state again; nothing was done.")
    }

    /// window_id, when given, must be the window the latest screenshot showed.
    func checkWindowID(_ args: Arguments, session: AppSession?) throws {
        guard let raw = args.string("window_id")?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return }
        guard let wanted = CGWindowID(raw) else { throw ToolError("window_id must be a window id number from get_app_state.") }
        guard let session, let id = session.windowID else {
            throw ToolError("No window is known for this app yet; call get_app_state before passing window_id.")
        }
        guard id == wanted else {
            throw ToolError("window_id \(wanted) is not the window the latest get_app_state showed (id \(id)). Call get_app_state with window: \"\(wanted)\" first; nothing was done.")
        }
        try checkWindowUnmoved(session)
    }

    func visibleCenter(of element: AXUIElement, session: AppSession) async throws -> CGPoint {
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

    func describe(_ element: AXUIElement) -> String {
        let values = element.multipleValues([kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
        let role = values[kAXRoleAttribute].flatMap(axString).map(withoutAXPrefix) ?? "element"
        let label = nonEmpty(values[kAXTitleAttribute].flatMap(axString)) ?? nonEmpty(values[kAXDescriptionAttribute].flatMap(axString))
        return label.map { "\(role) \(quote($0, limit: 60))" } ?? role
    }
}

func formatNumber(_ value: Double) -> String {
    value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
}

/// Bundle id prefixes of Chromium-based browsers, which can run the extension.
let chromiumBrowserPrefixes = ["com.google.chrome", "org.chromium.", "com.microsoft.edgemac", "com.brave.browser",
                               "com.vivaldi.vivaldi", "company.thebrowser.", "com.operasoftware.", "ai.perplexity.comet"]

/// Flutter macOS apps (RustDesk...): their accessibility tree stays empty
/// until AXEnhancedUserInterface is set, and their views ignore mouse events
/// posted while the app is in the background.
func isFlutter(_ app: NSRunningApplication) -> Bool {
    isFlutter(bundlePath: app.bundleURL?.path)
}

func isFlutter(bundlePath: String?) -> Bool {
    guard let bundlePath else { return false }
    return FileManager.default.fileExists(atPath: bundlePath + "/Contents/Frameworks/FlutterMacOS.framework")
}

/// Chromium-based browsers (Chrome, Chrome for Testing, Edge, Brave, Arc...)
/// and apps embedding Chromium, through CEF (NetEase Music) or Electron.
func isChromium(_ app: NSRunningApplication) -> Bool {
    let bundleID = (app.bundleIdentifier ?? "").lowercased()
    let frameworks = (app.bundleURL?.path ?? "") + "/Contents/Frameworks/"
    return chromiumBrowserPrefixes.contains { bundleID.hasPrefix($0) }
        || ["Chromium Framework.framework", "Chromium Embedded Framework.framework", "Electron Framework.framework"]
            .contains { FileManager.default.fileExists(atPath: frameworks + $0) }
}
