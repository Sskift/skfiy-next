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
    private var zoomCount = 0
    private var accessibilityEnabled: Set<pid_t> = []
    /// Flutter apps whose AXEnhancedUserInterface skfiy turned on: app-wide
    /// and costly for them, so it is turned off again when skfiy disconnects.
    private var enhancedInterfaceSet: Set<pid_t> = []
    /// Apps the user allowed brief focus for, this session.
    private var focusApproved: Set<pid_t> = []
    /// What cmd+c / cmd+x copied (or read_clipboard took, with the user's
    /// approval). The system clipboard belongs to the user.
    private var clipboard: ClipboardContents?
    /// Asks the user a yes/no question through the client; nil when it cannot.
    public var askUser: ((String) async -> Bool?)? {
        didSet { browser.askUser = askUser }
    }
    /// Like askUser, but waits long enough for the user to do something
    /// themselves (sign in, enter a code); nil when the client cannot ask.
    public var waitForUser: ((String) async -> Bool?)?
    private let settleDelay: Double
    var lockedUse: LockedUseClient?
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

    public func enableLockedUse() async throws {
        guard !DirectLockedUse.enabled else {
            throw ToolError("SKFIY_LOCKED_USE=direct cannot be combined with --locked-use. Choose direct mode to keep macOS locked.")
        }
        let client = LockedUseClient()
        try await client.start()
        lockedUse = client
        Input.lockedUseIsValid = { [weak client] in client != nil && client?.failure == nil }
    }

    public func disconnect() {
        lockedUse?.disconnect()
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

    nonisolated public static let toolNames = [
        "list_apps", "get_desktop_status", "get_app_state", "get_app_capabilities", "click", "perform_secondary_action", "set_value",
        "select_text", "scroll", "drag", "press_key", "type_text", "open_file", "save_document", "zoom", "run_in_front",
        "file_dialog", "read_clipboard", "wait_for", "locate", "flow_start", "flow_record", "flow_status", "hand_over",
        "locked_use_status", "locked_use_end"
    ] + BrowserTools.toolNames

    private let browser = BrowserTools()

    /// Runs a tool and records what it changed in the action log.
    public func call(_ name: String, _ raw: [String: Any]) async -> ToolResult {
        if DirectLockedUse.enabled {
            if directLockedUse.observeTransition() { forgetApps() }
            if name == "locked_use_status" { return directLockedUse.status() }
            if name == "locked_use_end" { return directLockedUse.status(end: true) }
        }
        if name == "locked_use_status" || name == "locked_use_end" {
            if name == "locked_use_end" { lockedUse?.disconnect() }
            return ToolResult(text: lockedUse?.status ?? "Locked use is disabled. Start a new MCP session with SKFIY_LOCKED_USE=direct to keep macOS locked, or --locked-use for the experimental guardian.")
        }
        lastInputWasSecret = false
        browser.lastInputWasSecret = false
        let needsDesktop = Self.toolNames.contains(name) && !name.hasPrefix("browser_") &&
            !["list_apps", "get_desktop_status", "hand_over", "get_app_capabilities"].contains(name)
        var result: ToolResult
        if let lockedUse, needsDesktop, !EmergencyStop.isStopped {
            do {
                try await lockedUse.begin()
                result = await act(name, raw)
                // End also verifies relock. An interrupted/partial operation is
                // an error, even when the app's action itself already succeeded.
                try await lockedUse.end()
            } catch {
                result = ToolResult(text: "Locked use stopped: \(error). The last action may be partial; inspect the app after manual unlock before retrying.", isError: true)
            }
        } else {
            result = await act(name, raw)
        }
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
    private var lastInputWasSecret = false
    private static let nativeSessionTools: Set<String> = [
        "get_app_state", "click", "perform_secondary_action", "set_value", "select_text", "scroll", "drag",
        "press_key", "type_text", "open_file", "save_document", "zoom", "run_in_front", "file_dialog", "wait_for", "locate"
    ]

    func perform(_ name: String, _ raw: [String: Any]) async -> ToolResult {
        let args = Arguments(raw)
        if DirectLockedUse.isActive, name == "type_text" || name == "press_key" || name == "set_value" {
            lastInputWasSecret = true
        }
        if EmergencyStop.isStopped, !["list_apps", "get_desktop_status", "get_app_capabilities"].contains(name) {
            return ToolResult(text: EmergencyStop.refusal, isError: true)
        }
        do {
            if Self.nativeSessionTools.contains(name) { try lockedUse?.check() }
            if Self.inputTools.contains(name) || name == "scroll" {
                try refuseProtectedTarget(args, scrolling: name == "scroll")
            }
            if DirectLockedUse.isActive, Self.nativeSessionTools.contains(name) || name == "read_clipboard" {
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
                return ToolResult(text: "Desktop: \(isScreenLocked() ? "locked or unavailable" : "unlocked").\nLocked use: \(lockedUse?.status ?? "disabled; start skfiy mcp --locked-use to opt in").\nEmergency stop: \(EmergencyStop.isStopped ? "stopped" : "running").")
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
                guard lockedUse?.protected != true else {
                    throw ToolError("run_in_front needs the user's visible desktop. Use background actions during locked use, or unlock manually.")
                }
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
        // loginwindow and the guardian's covers must never become restoration
        // targets. The guardian owns presentation during temporary unlock.
        if lockedUse?.protected == true { return try await body() }
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
    static let inputTools: Set<String> = [
        "click", "perform_secondary_action", "set_value", "select_text", "drag", "press_key", "type_text", "open_file",
        "save_document", "run_in_front", "file_dialog"
    ]

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

    // MARK: - open_file

    /// Opens a document or folder the way a double-click would, but without
    /// activating anything, so no Open panel is needed.
    func openFile(_ args: Arguments) async throws -> ToolResult {
        let path = try args.absolutePath("path")
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
            case .installed(let bundle):
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

    // MARK: - zoom

    /// A part of the latest screenshot at the display's full resolution, for
    /// small text. The coordinate system for x/y arguments does not change.
    func zoom(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let geometry = session.geometry, let taken = session.captured else {
            throw ToolError("There is no screenshot to zoom into. Call get_app_state first.")
        }
        let region = try zoomRegion(args, geometry: geometry)
        let pid = app.processIdentifier
        // The window may have moved since: then the screenshot's pixels no longer
        // say where things are, and nothing should be mapped from them.
        let window = session.window ?? AXUIElementCreateApplication(pid).element(kAXFocusedWindowAttribute)
        if session.independent {
            try checkWindowUnmoved(session)
        } else if let now = appRegion(pid: pid, focusedWindow: window?.frame), now != geometry.rect {
            sessions[pid]?.zoom = nil
            throw ToolError("The window moved or changed size since the latest screenshot (it showed \(geometry.rect), now \(now)). Call get_app_state again; its old coordinates are not used.")
        }
        let backing = backingScale(for: geometry.rect)
        let native = backing / geometry.scale
        let factor = try ZoomMapping.factor(args, native: native, region: region)
        let topLeft = geometry.toScreen(x: region.minX, y: region.minY)
        let bottomRight = geometry.toScreen(x: region.maxX, y: region.maxY)
        let rect = CGRect(x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y)
        // An inspected window is cut from a capture of it alone, as it was shown.
        let shot = try await captureView(pid: pid, window: inspectedWindow(pid), rect: rect, maxScale: backing)
        guard let capture = TextRecognition.decode(shot.data),
              let cut = cutZoom(from: capture, captureGeometry: shot.geometry, screenshot: geometry, region: region, factor: factor) else {
            throw ToolError("Could not cut that region from the window.")
        }
        zoomCount += 1
        let mapping = ZoomMapping(id: "z\(zoomCount)", region: cut.shown, zoomWidth: cut.image.width, zoomHeight: cut.image.height,
                                  screenshot: geometry, screenshotTaken: taken)
        sessions[pid]?.zoom = mapping
        var lines = mapping.lines(factor: factor, native: native, lasting: ", until the next screenshot of this app.")
        if args.bool("ocr") ?? false {
            lines += try await mapping.recognizedText(in: cut.image, showing: rect)
        }
        return ToolResult(text: lines.joined(separator: "\n"), image: try encode(cut.image, format: "png"), imageMimeType: "image/png")
    }

    // MARK: - wait_for

    /// Polls the accessibility tree, sending nothing, until a text shows up (or
    /// goes away), or without a text until the window stops changing; then
    /// returns the fresh state.
    func waitFor(_ args: Arguments) async throws -> ToolResult {
        try requireAccessibility()
        let query = try args.requiredString("app")
        guard case .running(let app) = try directory.resolve(query) else {
            throw ToolError("\(query) is not running. Call get_app_state first; it launches the app in the background.")
        }
        let timeout = try args.double("timeout") ?? 10
        guard (0.5...60).contains(timeout) else {
            throw ToolError("timeout must be between 0.5 and 60 seconds.")
        }
        let stableFor = try args.double("stable_for") ?? 1
        guard (0.3...10).contains(stableFor) else {
            throw ToolError("stable_for must be between 0.3 and 10 seconds.")
        }
        let text = args.string("text")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gone = args.bool("gone") ?? false
        if gone, text.isEmpty {
            throw ToolError("gone needs a text to wait for the disappearance of.")
        }
        if args.values["region"] != nil {
            throw ToolError("region applies while macOS is locked (pixels); unlocked waits watch the accessibility tree. Wait for a text instead, or without one until the window stops changing.")
        }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appElement, 2)
        await enableAccessibility(app, appElement)
        let windowQuery = args.string("window")?.trimmingCharacters(in: .whitespaces)
        let name = app.localizedName ?? query
        var engine = WaitEngine(text: text.isEmpty ? nil : text, gone: gone, stableFor: stableFor, timeout: timeout)
        // Look when the app announces a change, and once a second otherwise
        // (not every change is announced). SKFIY_WAIT_EVENTS=0 polls instead.
        let events = ProcessInfo.processInfo.environment["SKFIY_WAIT_EVENTS"] == "0" ? nil : AXChangeEvents(pid: app.processIdentifier)
        defer { events?.stop() }
        // Without notifications to go by (a canvas animating), stability is
        // judged from pixels too, so look a little more often then.
        if events != nil { engine.interval = text.isEmpty ? 0.5 : 1 }
        var looks = 0
        var sawWindow = false
        let watched = windowQuery?.isEmpty == false ? windowQuery : nil
        let started = Date()
        let result = await engine.run(
            now: { Date().timeIntervalSince(started) },
            sleep: { seconds in
                if let events {
                    // An app announcing changes all the time (a progress bar)
                    // is still read no more often than polling would.
                    let began = Date()
                    await events.wait(upTo: seconds)
                    try Task.checkCancellation()
                    let spacing = min(0.25, seconds) - Date().timeIntervalSince(began)
                    if spacing > 0 { try await Task.sleep(nanoseconds: UInt64(spacing * 1_000_000_000)) }
                } else {
                    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                }
            },
            check: {
                if EmergencyStop.isStopped { throw WaitStopped("emergency stop is on.") }
                // While locked, accessibility answers for the lock screen, not the app.
                if isScreenLocked() { throw WaitStopped("the screen locked, and accessibility no longer describes the app.") }
                if app.isTerminated { throw WaitStopped("\(name) quit.") }
            },
            observe: {
                looks += 1
                let snapshot: Snapshot
                do {
                    snapshot = try self.buildSnapshot(app: app, appElement: appElement, windowQuery: watched)
                } catch let error as ToolError where sawWindow && error.description.hasPrefix("No window") {
                    throw WaitStopped("the window closed.")
                } catch {
                    // A window that is not there (yet) proves nothing either way.
                    return WaitObservation(text: nil, textFingerprint: UUID().uuidString)
                }
                sawWindow = true
                var current = snapshot.text
                // A window watched by name is read on its own, not with the
                // app's windows above it.
                let watchedWindow = snapshot.chosenWindow
                let area = watchedWindow?.frame ?? appRegion(pid: app.processIdentifier, focusedWindow: snapshot.focusedWindowFrame)
                if args.bool("ocr") ?? snapshot.opaque, let area,
                   let lines = try? await self.recognizeView(pid: app.processIdentifier, window: watchedWindow, rect: area) {
                    current += "\n" + lines.map(\.text).joined(separator: "\n")
                }
                var observation = WaitObservation(text: current, textFingerprint: current)
                if text.isEmpty, let area,
                   let shot = try? await self.captureView(pid: app.processIdentifier, window: watchedWindow, rect: area), let image = TextRecognition.decode(shot.data) {
                    observation.fingerprint = PixelFingerprint(image, region: nil)
                }
                return observation
            })
        if case .cancelled = result { throw CancellationError() }
        if app.isTerminated { sessions[app.processIdentifier] = nil }
        let outcome = engine.describe(result) + " (\(looks) look\(looks == 1 ? "" : "s")"
            + (events.map { ", woken by \($0.received) accessibility notification\($0.received == 1 ? "" : "s")" } ?? ", polling") + ")"
        if case .stopped = result { throw ToolError(outcome) }
        var state = try await getAppState(args)
        state.text = outcome + "\n" + state.text
        if case .timedOut = result {
            state.isError = true
            if chromiumWindowFrozen(app, window: sessions[app.processIdentifier]?.windowID) {
                state.text = "The window is completely covered by other windows, so Chromium has not been updating it: what was waited for may have happened unseen (see below).\n" + state.text
            }
        }
        return state
    }

    // MARK: - file_dialog

    /// Fills in the Open or Save panel an app is showing, in the background.
    func fileDialog(_ args: Arguments) async throws -> ToolResult {
        let (app, _) = try target(args)
        try checkInputTarget(app)
        let path = try args.absolutePath("path")
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        guard let panel = FilePanel.find(in: appElement) else {
            throw ToolError("\(app.localizedName ?? "The app") is not showing an Open or Save panel. Open one first (its menu item or button), or use open_file / save_document, which need no panel.")
        }
        let overwrite = args.bool("overwrite") ?? false
        let summary = try await panel.choose(URL(fileURLWithPath: path), overwrite: overwrite, in: appElement)
        return try await afterAction(app, summary)
    }

    // MARK: - run_in_front

    /// The one exception to working in the background: a shortcut that only
    /// works in the frontmost app, run after the user approves it in the
    /// client, in a quiet moment, with their front app and top window put back.
    func runInFront(_ args: Arguments) async throws -> ToolResult {
        let query = try args.requiredString("app")
        let app = try await runningApp(query, launch: false)
        try checkInputTarget(app)
        let pid = app.processIdentifier
        let name = app.localizedName ?? query
        // A shortcut, an item of an element's context menu, or a click.
        let key = args.string("key")
        let menuPath = args.string("menu_item").map { $0.components(separatedBy: CharacterSet(charactersIn: ">›")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        let index = try args.elementIndex()
        let hasPoint = args.values["x"] != nil || args.values["y"] != nil
        var menuElement: AXUIElement?
        var clickPoint: CGPoint?
        let action: String
        if let menuPath, !menuPath.isEmpty {
            guard key == nil, !hasPoint, let index else {
                throw ToolError("Pass one of: key; element_index with menu_item; or element_index or x/y alone to click.")
            }
            guard let session = sessions[pid] else {
                throw ToolError("No state for \(name) yet. Call get_app_state first.")
            }
            let element = try session.element(index)
            menuElement = element
            action = "choose \(quote(menuPath.joined(separator: " › "), limit: 80)) from the menu of \(describe(element))"
        } else if let key {
            guard index == nil, !hasPoint else {
                throw ToolError("Pass one of: key; element_index with menu_item; or element_index or x/y alone to click.")
            }
            action = "press \(key)"
        } else if index != nil || hasPoint {
            guard let session = sessions[pid] else {
                throw ToolError("No state for \(name) yet. Call get_app_state first.")
            }
            if let index {
                let element = try session.element(index)
                clickPoint = try await visibleCenter(of: element, session: session)
                action = "click [\(index)] \(describe(element))"
            } else {
                clickPoint = try screenPoint(args, "x", "y", session: session)
                action = "click at (\(formatNumber(try args.double("x") ?? 0)), \(formatNumber(try args.double("y") ?? 0)))"
            }
            try checkPointerTarget(app, allowRemote: true)
        } else {
            throw ToolError("Pass one of: key; element_index with menu_item; or element_index or x/y alone to click.")
        }
        let chord = try key.map(parseKeyChord)
        // A RustDesk remote session passes what it gets to the remote computer.
        let appElementNow = AXUIElementCreateApplication(pid)
        let remoteWindow: AXUIElement? = {
            if let clickPoint, let id = pointerWindow(pid: pid, at: clickPoint), let window = axWindow(id, pid: pid) { return window }
            return appElementNow.element(kAXFocusedWindowAttribute)
        }()
        let remoteTitle = remoteWindow.flatMap { window -> String? in
            let title = window.string(kAXTitleAttribute) ?? ""
            return RemoteSurface.isRemoteSession(bundleID: app.bundleIdentifier, title: title) ? title : nil
        }
        // cmd+c, cmd+x and cmd+v work on skfiy's clipboard here too (not in a
        // remote session, where they are the remote computer's).
        let clipboardKey = remoteTitle != nil ? nil : chord.flatMap { chord in chord.modifiers == .command ? chord.baseCharacter.flatMap { "cxv".contains($0) ? $0 : nil } : nil }
        if clipboardKey == "v", clipboard == nil {
            throw ToolError("skfiy's clipboard is empty, so there is nothing to paste. Copy with cmd+c first, or take what the user copied with read_clipboard.")
        }
        guard let userApp = frontmostProcessID() else {
            throw ToolError("Could not tell which app is in front.")
        }
        guard userApp != pid else {
            throw ToolError("\(name) is already the front app; use press_key.")
        }
        guard let askUser else {
            throw ToolError("skfiy can only bring \(name) forward after the user approves it, and this client cannot ask them. Tell the user what needs doing instead.")
        }
        let user = NSRunningApplication(processIdentifier: userApp)?.localizedName ?? "your app"
        let reason = args.string("reason").map { " (\($0))" } ?? ""
        var message = "skfiy wants to bring \(name) to the front for about a second to \(action)\(reason). \(user) and your window order are restored right after; it waits until you stop typing."
        if let remoteTitle {
            message += " This goes to RustDesk's remote session \(quote(remoteTitle, limit: 80)), so the remote computer receives it; RustDesk may keep your keyboard for the remote computer until you click elsewhere."
        }
        switch await askUser(message) {
        case nil:
            throw ToolError("skfiy can only bring \(name) forward after the user approves it, and this client cannot ask them (or no answer came). Tell the user what needs doing instead.")
        case false?:
            throw ToolError("The user declined bringing \(name) to the front. Do not ask again for the same thing; tell them what is left to do.")
        case true?:
            break
        }
        // A quiet moment: no typing or clicking for a second, within 15 s.
        var quiet = false
        for _ in 0..<60 {
            if EmergencyStop.isStopped { throw ToolError(EmergencyStop.refusal) }
            if Input.userIdleSeconds() >= 1 { quiet = true; break }
            await Input.pause(0.25)
        }
        guard quiet else {
            throw ToolError("The user kept typing or clicking, so \(name) was not brought forward. Try again later.")
        }
        let userTop = topWindow().flatMap { $0.pid == userApp ? $0.id : nil }
        let front = { SkyLight.frontProcessID() ?? frontmostProcessID() }
        // Whatever happens from here on, the user's app gets the front back.
        func restore() async {
            guard let previous = NSRunningApplication(processIdentifier: userApp), !previous.isTerminated else { return }
            for _ in 0..<3 where front() != userApp {
                _ = try? AXUIElementCreateApplication(userApp).set(kAXFrontmostAttribute, kCFBooleanTrue)
                previous.activate(options: [])
                for _ in 0..<10 where front() != userApp {
                    await Input.pause(0.05)
                }
            }
            if let userTop, topWindow()?.id != userTop,
               let window = AXUIElementCreateApplication(userApp).elements(kAXWindowsAttribute).first(where: { windowID(of: $0) == userTop }) {
                _ = guardedAXPerformAction(window, kAXRaiseAction as CFString)
            }
        }
        // Since macOS 14 a background process's activate() may be ignored;
        // the accessibility frontmost attribute is honored. Activation can take
        // a moment to land.
        let appElement = AXUIElementCreateApplication(pid)
        // Guards of this and every other skfiy process leave it in front meanwhile.
        FrontGrant.grant(pid, seconds: 20)
        defer { FrontGrant.revoke() }
        _ = try? appElement.set(kAXFrontmostAttribute, kCFBooleanTrue)
        app.activate(options: [])
        for _ in 0..<40 where front() != pid {
            await Input.pause(0.05)
        }
        guard front() == pid else {
            await restore()
            throw ToolError("\(name) did not come to the front, so nothing was pressed.")
        }
        // Make sure the shortcut lands in the app's document window.
        if let window = appElement.element(kAXFocusedWindowAttribute) ?? appElement.elements(kAXWindowsAttribute).first {
            _ = try? window.set(kAXMainAttribute, kCFBooleanTrue)
        }
        // Let the switch settle: the window becomes key and menus revalidate.
        await Input.pause(0.3)
        let system = SystemClipboard()
        let saved = clipboardKey.map { _ in system.read() }
        if clipboardKey == "v", let clipboard {
            system.write(clipboard)
        }
        let lent = system.changeCount
        var how: String
        if let clickPoint {
            guard front() == pid, let window = pointerWindow(pid: pid, at: clickPoint) else {
                await restore()
                throw ToolError("\(name) lost the front, or has no window at that point, so nothing was clicked.")
            }
            // Posted to the app, now active, so the user's cursor stays where it is.
            guard await Input.click(at: clickPoint, pid: pid, windowID: window, button: .left, count: 1, modifiers: [], chromium: isChromium(app)) else {
                await restore()
                throw ToolError(axMutationRefusal() ?? "The click could not be sent, so nothing was clicked.")
            }
            how = "clicked there"
        } else if let menuElement, let menuPath {
            do {
                how = try await chooseFromMenu(of: menuElement, path: menuPath, pid: pid)
            } catch {
                await restore()
                throw error
            }
        } else if let chord, let item = menuItem(for: chord, pid: pid), item.enabled {
            if guardedAXPerformAction(item.element, kAXPressAction as CFString) == .failure, let refusal = axMutationRefusal() {
                if let saved, system.changeCount == lent { system.write(saved) }
                await restore()
                throw ToolError(refusal)
            }
            how = "ran the menu item \(quote(item.title, limit: 60))"
        } else if let chord, front() == pid {
            // It is the front app now, so a keystroke like a real one reaches it.
            await Input.pressToFrontApp(chord)
            how = "pressed \(key ?? "")"
        } else {
            if let saved, system.changeCount == lent { system.write(saved) }
            await restore()
            throw ToolError("\(name) lost the front before the shortcut, so nothing was pressed.")
        }
        await Input.pause(0.3)
        if let saved, let clipboardKey {
            if clipboardKey == "v" {
                if system.changeCount == lent { system.write(saved) }
                how += " on skfiy's clipboard (the user's clipboard was lent for that moment and put back)"
            } else if await system.waitForChange(from: lent, seconds: 1) {
                await Input.pause(0.1)
                let copied = system.read()
                system.write(saved)
                clipboard = copied
                how += ", keeping what it copied (\(copied.summary)) in skfiy's clipboard and putting the user's clipboard back"
            } else {
                how += ", but nothing was copied"
            }
        }
        await restore()
        let restored = front() == userApp ? "gave the front back to \(user)" : "could not give the front back to \(user)"
        return try await afterAction(app, "With the user's approval, brought \(name) forward for a moment, \(how), and \(restored).")
    }

    /// Opens the context menu of `element` (or the menu of a menu button) in
    /// the front app and presses the item at `path`, e.g. ["Share", "Mail"].
    private func chooseFromMenu(of element: AXUIElement, path: [String], pid: pid_t) async throws -> String {
        let appElement = AXUIElementCreateApplication(pid)
        let opener = ["AXMenuButton", "AXPopUpButton"].contains(element.string(kAXRoleAttribute) ?? "") ? kAXPressAction : kAXShowMenuAction
        let status = guardedAXPerformAction(element, opener as CFString)
        try throwIfRefused(status)
        guard status == .success || status == .cannotComplete else {
            throw ToolError("\(describe(element)) has no menu to open.")
        }
        // Context menus hang off the application element, a button's menu off the button.
        var menu: AXUIElement?
        for _ in 0..<20 {
            let open = { (parent: AXUIElement) in
                parent.elements(kAXChildrenAttribute).first { $0.string(kAXRoleAttribute) == kAXMenuRole && self.isOpenMenu($0) }
            }
            menu = open(appElement) ?? open(element)
            if menu != nil { break }
            await Input.pause(0.05)
        }
        guard let menu else {
            throw ToolError("No menu opened for \(describe(element)).")
        }
        let close = { _ = guardedAXPerformAction(menu, kAXCancelAction as CFString) }
        var current = menu
        for (depth, title) in path.enumerated() {
            let items = current.elements(kAXChildrenAttribute)
            let titles = items.map { $0.string(kAXTitleAttribute) ?? "" }
            let wanted = title.lowercased()
            guard let index = titles.firstIndex(where: { $0.lowercased() == wanted })
                    ?? titles.firstIndex(where: { $0.lowercased().contains(wanted) }) else {
                close()
                let listing = titles.filter { !$0.isEmpty }.prefix(40).map { quote($0, limit: 40) }.joined(separator: ", ")
                throw ToolError("The menu has no item \(quote(title, limit: 60)), so nothing was chosen. Its items: \(listing).")
            }
            let item = items[index]
            if depth == path.count - 1 {
                guard item.bool(kAXEnabledAttribute) != false else {
                    close()
                    throw ToolError("\(quote(titles[index], limit: 60)) is disabled in that menu, so nothing was chosen.")
                }
                try throwIfRefused(guardedAXPerformAction(item, kAXPressAction as CFString))
                return "chose \(quote(path.dropLast().map { $0 + " › " }.joined() + titles[index], limit: 80)) from the menu of \(describe(element))"
            }
            guard let submenu = item.elements(kAXChildrenAttribute).first(where: { $0.string(kAXRoleAttribute) == kAXMenuRole }) else {
                close()
                throw ToolError("\(quote(titles[index], limit: 60)) has no submenu, so nothing was chosen.")
            }
            current = submenu
        }
        close()
        throw ToolError("No menu item was given.")
    }

    // MARK: - save_document

    /// Saves through the app's scripting interface: the standard suite's
    /// `save … in`, which needs no Save panel and no front app.
    func saveDocument(_ args: Arguments) async throws -> ToolResult {
        let query = try args.requiredString("app")
        let app = try await runningApp(query, launch: false)
        let path = try args.absolutePath("path")
        var isDirectory: ObjCBool = false
        let parent = (path as NSString).deletingLastPathComponent
        guard FileManager.default.fileExists(atPath: parent, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ToolError("The folder \(parent) does not exist.")
        }
        let overwrite = args.bool("overwrite") ?? false
        if FileManager.default.fileExists(atPath: path), !overwrite {
            throw ToolError("\(path) already exists; pass overwrite: true to replace it, or choose another path.")
        }
        let name = app.localizedName ?? query
        guard let bundleID = app.bundleIdentifier, mayAutomate(bundleID) else {
            return try await saveThroughPanel(app, path: path, overwrite: overwrite,
                why: "skfiy may not send Apple Events to \(name) without a permission prompt (which would pop up over the user's work), so it cannot script the save.")
        }
        let escape = { (text: String) in text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        let document = args.string("document").map { "document \"\(escape($0))\"" } ?? "document 1"
        var error: NSDictionary?
        _ = NSAppleScript(source: "tell application id \"\(bundleID)\" to save \(document) in POSIX file \"\(escape(path))\"")?
            .executeAndReturnError(&error)
        if let error {
            let reason = error[NSAppleScript.errorMessage] as? String ?? "unknown error"
            guard args.string("document") == nil else {
                throw ToolError("\(name) could not save: \(reason). It may not be scriptable, or has no such document.")
            }
            return try await saveThroughPanel(app, path: path, overwrite: overwrite, why: "\(name) could not save through scripting (\(reason)).")
        }
        guard FileManager.default.fileExists(atPath: path) else {
            throw ToolError("\(app.localizedName ?? query) reported no error, but nothing was written to \(path).")
        }
        return try await afterAction(app, "Saved \(args.string("document").map { quote($0, limit: 60) } ?? "the front document") of \(app.localizedName ?? query) to \(path).")
    }

    /// Saves the front document through the app's own Save panel, opened
    /// from a menu item that always shows one: Save As…, Save… for an untitled
    /// document (for a saved one it would overwrite its file), or ⇧⌘S in apps
    /// without Save As… (in document apps that is Duplicate).
    private func saveThroughPanel(_ app: NSRunningApplication, path: String, overwrite: Bool, why: String) async throws -> ToolResult {
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        if FilePanel.find(in: appElement) == nil {
            let saveAs = menuItem(for: try parseKeyChord("cmd+alt+shift+s"), pid: pid)
            let untitled = appElement.element(kAXFocusedWindowAttribute).map { nonEmpty($0.string(kAXDocumentAttribute)) == nil } ?? false
            let candidates = [saveAs, untitled ? menuItem(for: try parseKeyChord("cmd+s"), pid: pid) : nil,
                              saveAs == nil ? menuItem(for: try parseKeyChord("cmd+shift+s"), pid: pid) : nil].compactMap { $0 }
            guard let item = candidates.first(where: \.enabled) else {
                let shortcut = saveAs != nil ? "cmd+alt+shift+s" : (untitled ? "cmd+s" : "cmd+shift+s")
                throw ToolError(candidates.isEmpty
                    ? "\(why) It has no Save menu item that opens a Save panel. Tell the user what is left to do."
                    : "\(why) Its \(quote(candidates[0].title, limit: 40)) menu item is disabled while it is in the background. Open the Save panel with run_in_front (key \"\(shortcut)\", which asks the user), then call file_dialog with this path.")
            }
            try throwIfRefused(guardedAXPerformAction(item.element, kAXPressAction as CFString))
            for _ in 0..<20 where FilePanel.find(in: appElement) == nil {
                await Input.pause(0.15)
            }
            guard FilePanel.find(in: appElement) != nil else {
                throw ToolError("\(why) Pressed its \(quote(item.title, limit: 40)) menu item, but no Save panel appeared.")
            }
        }
        guard let panel = FilePanel.find(in: appElement), panel.isSave else {
            throw ToolError("\(app.localizedName ?? "The app") is showing an Open panel, not a Save panel; finish or cancel it first.")
        }
        let summary = try await panel.choose(URL(fileURLWithPath: path), overwrite: overwrite, in: appElement)
        return try await afterAction(app, summary)
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
    // Nothing here activates the target, raises a window, or moves the user's
    // cursor. Clipboard shortcuts that need the app's own Copy or Paste lend
    // it the user's clipboard for a moment and put it straight back.
    // Accessibility is tried first; pointer and keyboard events are posted to
    // the target process only.

    static let pressRoles: Set<String> = [
        "AXButton", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle", "AXLink", "AXDockItem",
        "AXTab", "AXSegment"
    ]
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    static let menuAlternatives = "Its commands are usually in the menu bar (click a menu bar item to list its items without opening it) or have keyboard shortcuts; to open a file, use open_file. A command found only in this menu can be run with run_in_front, element_index and menu_item, which asks the user first."
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

        // A status item's menu would open over the user's screen; its items
        // can only be listed when the app built the menu in advance.
        if let element, element.string(kAXRoleAttribute) == "AXMenuBarItem",
           element.element(kAXParentAttribute)?.string(kAXRoleAttribute) != kAXMenuBarRole
            || element.string(kAXSubroleAttribute) == "AXMenuExtra",
           element.elements(kAXChildrenAttribute).first?.string(kAXRoleAttribute) != kAXMenuRole {
            throw ToolError("\(described) is a status item in the menu bar; clicking it would open its menu over the user's screen, and the app does not expose the menu in advance, so it was not clicked. Use the app's own windows or menu bar instead.")
        }
        let inBackground = frontmostProcessID() != pid
        // Opening a background app's menu would draw it over the user's screen;
        // list the items instead, ready to be pressed by index.
        if let element, button == .left, count == 1, inBackground,
           ["AXMenuBarItem", "AXMenuItem"].contains(element.string(kAXRoleAttribute) ?? ""),
           let menu = element.elements(kAXChildrenAttribute).first,
           menu.string(kAXRoleAttribute) == kAXMenuRole {
            var lines: [String] = []
            listMenu(menu, pid: pid, depth: 1, lines: &lines)
            let title = element.string(kAXTitleAttribute) ?? ""
            let intro = "Menu \(quote(title, limit: 60)) of \(app.localizedName ?? "the app") — listed, not opened, so nothing appeared on screen. Click an item's index to run it. Enabled/checked states are as of when the app was last in front; items marked disabled cannot run while it is in the background."
            return ToolResult(text: ([intro] + lines).joined(separator: "\n"))
        }

        if let element, button == .left, count == 1, inBackground,
           element.string(kAXRoleAttribute) == "AXPopUpButton" {
            let options = popupOptions(element)
            let current = element.string(kAXValueAttribute).map { " Current value: \(quote($0, limit: 60))." } ?? ""
            let listing = options.isEmpty ? "" : " Options: " + options.map { quote($0.title, limit: 40) }.joined(separator: ", ") + "."
            return ToolResult(text: "\(described) is a pop-up menu; opening it would draw over the user's screen, so it was not opened.\(current)\(listing) Choose an option with set_value(element_index, value: \"<option text>\").")
        }
        if inBackground {
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
        // x/y in a remote session: not even an accessibility press on what a hit test finds there.
        if let point, let remote = remoteSessionTitle(app, receiver: pointerWindow(pid: pid, at: point), point: point, aimed: true) {
            throw ToolError(RemoteSurface.refusal(remote, what: "a click"))
        }
        // The agent cursor goes there first, so the user sees where it acts.
        if let shown = point ?? element?.frame.map({ CGPoint(x: $0.midX, y: $0.midY) }) {
            await VirtualCursor.move(to: shown, pid: pid, window: pointerWindow(pid: pid, at: shown, element: point == nil ? element : nil))
        }
        if let element, let how = try await accessibilityClick(element, at: point, button: button, count: count, modifiers: modifiers, exact: point == nil) {
            VirtualCursor.show(.click(count: count, button: button), pid: pid)
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
        // Checked before the cursor moves there: nothing happens on a refusal.
        let indexed = point == nil ? element : nil
        try checkPointerTarget(app, window: indexed.flatMap(containingWindow(of:)))
        if point == nil { await VirtualCursor.move(to: target, pid: pid) }
        let how = try await pointerClick(app, at: target, element: indexed, button: button, count: count, modifiers: modifiers,
                                         focus: args.bool("focus") ?? false)
        VirtualCursor.show(.click(count: count, button: button), pid: pid)
        return try await afterAction(app, "Clicked \(described): \(how).")
    }

    /// Performs a click semantically. Returns what was done, or nil when only a
    /// pointer event can do it. `exact` means the element was chosen by index
    /// rather than hit-tested, so its ancestors are not candidates. A refused
    /// action throws: no other way of clicking is tried then.
    private func accessibilityClick(
        _ element: AXUIElement,
        at point: CGPoint?,
        button: MouseButton,
        count: Int,
        modifiers: Modifiers,
        exact: Bool
    ) async throws -> String? {
        guard modifiers.isEmpty else { return nil }
        let role = element.string(kAXRoleAttribute) ?? ""
        switch (button, count) {
        case (.left, 1):
            // A file name in a list row (Finder) is a text field: a click on a
            // row that is not selected selects it, as a real click does.
            if !exact, Self.textRoles.contains(role), let row = ancestor(of: element, levels: 3, where: {
                $0.string(kAXRoleAttribute) == "AXRow" && $0.isSettable(kAXSelectedAttribute)
            }), row.bool(kAXSelectedAttribute) == false {
                let status = guardedAXSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                try throwIfRefused(status)
                if status == .success { return "selected the row (accessibility)" }
            }
            if Self.textRoles.contains(role) {
                try throwIfRefused(guardedAXSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue))
                if let pid = element.pid { typingTargets[pid] = element }
                // A click lands the caret under the pointer; by index, at the end.
                let length = (element.string(kAXValueAttribute) as NSString?)?.length ?? 0
                let location = point.flatMap { textIndex(in: element, at: $0) } ?? length
                let keyboard = await makeFieldWindowKey(element)
                setCaret(element, location)
                return "focused the field and placed the caret (accessibility)" + keyboard
            }
            // In web content AXPress only dispatches a click event: plain text or a
            // canvas would not take focus the way a real click does, so those
            // get a real (background) mouse click instead.
            if let pressable = ancestor(of: element, levels: exact ? 0 : 3, where: {
                Self.pressRoles.contains($0.string(kAXRoleAttribute) ?? "") && $0.actionNames().contains(kAXPressAction)
            }) ?? (element.actionNames().contains(kAXPressAction) && !isInWebContent(element) ? element : nil) {
                let name = describe(pressable)
                let status = guardedAXPerformAction(pressable, kAXPressAction as CFString)
                try throwIfRefused(status)
                // Menus and pop-ups run a tracking loop, so AXPress often times out while one opens.
                if status == .success || status == .cannotComplete {
                    return "pressed \(name) (accessibility)"
                }
            }
            if let row = ancestor(of: element, levels: exact ? 0 : 3, where: {
                $0.string(kAXRoleAttribute) == "AXRow" && $0.isSettable(kAXSelectedAttribute)
            }) {
                let status = guardedAXSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                try throwIfRefused(status)
                if status == .success { return "selected the row (accessibility)" }
            }
        case (.left, 2):
            if let openable = ancestor(of: element, levels: exact ? 1 : 3, where: { $0.actionNames().contains("AXOpen") }) {
                let name = describe(openable)
                let status = guardedAXPerformAction(openable, "AXOpen" as CFString)
                try throwIfRefused(status)
                if status == .success {
                    return "opened \(name) (accessibility)"
                }
            }
        case (.right, 1):
            if let target = ancestor(of: element, levels: exact ? 0 : 2, where: { $0.actionNames().contains(kAXShowMenuAction) }) {
                let name = describe(target)
                let status = guardedAXPerformAction(target, kAXShowMenuAction as CFString)
                try throwIfRefused(status)
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
        element: AXUIElement? = nil,
        button: MouseButton,
        count: Int,
        modifiers: Modifiers,
        focus: Bool
    ) async throws -> String {
        let pid = app.processIdentifier
        guard let window = pointerWindow(pid: pid, at: point, element: element) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at that point.")
        }
        let windowElement = element.flatMap(containingWindow(of:)) ?? axWindow(window, pid: pid)
        try checkPointerTarget(app, window: windowElement, receiver: window, point: point, aimed: element == nil)
        let chromium = isChromium(app)
        let flutter = isFlutter(app)
        var note = ""
        if flutter, frontmostProcessID() != pid {
            // Measured with RustDesk: Flutter views ignore every kind of
            // background click; brief focus was not tried (it defocuses the user).
            guard await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers) else {
                throw ToolError(axMutationRefusal() ?? "The click could not be sent, so nothing was clicked.")
            }
            return "sent a background mouse click, but Flutter apps (such as RustDesk) ignore mouse clicks while they are in the background, so expect no effect. Click their controls by element_index instead (get_app_state lists them), or use run_in_front with the same x/y (asks the user)."
        }
        if frontmostProcessID() != pid, briefFocusEnabled || focus {
            switch await briefFocusPermission(app) {
            case true?:
                if await waitForUserIdle() {
                    let delivered = await Input.withBriefFocus(pid: pid, windowID: window) {
                        await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers, chromium: chromium)
                    }
                    if delivered {
                        return "sent a mouse click while \(app.localizedName ?? "the app") had keyboard focus for a moment (it did not come forward; the user's front app kept its place). If the screenshot shows no change, this view only takes clicks while its app is in front: run_in_front with the same x/y (asks the user)."
                    }
                } else {
                    note = " The user kept typing, so it went without focus; try again in a moment."
                }
            case false?:
                note = " The user declined giving it focus."
            case nil:
                note = " Focus needs the user's approval, which this client cannot ask for."
            }
        }
        // Input sends nothing once stopped, cancelled or locked: that is no click.
        guard await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers, chromium: chromium) else {
            throw ToolError(axMutationRefusal() ?? "The click could not be sent, so nothing was clicked.")
        }
        let inFront = " this view only takes clicks while its app is in front: run_in_front with the same x/y (asks the user)."
        if isInWebContentAt(pid: pid, point: point) {
            // Chromium takes a click during a moment of focus; WebKit only in the front app.
            let retry = chromium && !focus
                ? " Click again with focus: true (asks the user once for this app)."
                : " If the screenshot shows no change," + inFront
            return "sent a background mouse click, but web content ignores pointer input in background windows; for browser tabs prefer the browser_* tools." + retry + note
        }
        let retry = focus
            ? " If the screenshot still shows no change," + inFront
            : " If the screenshot shows no change, click again with focus: true (asks the user once for this app), or use an element_index or the keyboard; failing that," + inFront
        return "sent a background mouse click." + retry + note
    }

    /// Whether this app may get keyboard focus for a moment during pointer
    /// input: SKFIY_BRIEF_FOCUS=1, or the user approved it once for the app
    /// this session. Nil when the client cannot ask.
    private func briefFocusPermission(_ app: NSRunningApplication) async -> Bool? {
        let pid = app.processIdentifier
        if briefFocusEnabled || focusApproved.contains(pid) { return true }
        guard let askUser else { return nil }
        let name = app.localizedName ?? "the app"
        let answer = await askUser("\(name) ignores clicks while it is in the background. Allow skfiy to give it keyboard focus for about a tenth of a second when it clicks there — only while you are not typing, without bringing it forward? (Asked once for \(name) this session.)")
        if answer == true {
            focusApproved.insert(pid)
        }
        return answer
    }

    func performSecondaryAction(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\" (or a target).")
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
        let status = guardedAXPerformAction(element, action as CFString)
        try throwIfRefused(status)
        if status != .success, status != .cannotComplete {
            try check(status, "\(action) on element \(index)")
        }
        return try await afterAction(app, "Performed \(TreeRenderer.actionDisplayName(action)) on [\(index)] \(describe(element)).")
    }

    func setValue(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\" (or a target).")
        }
        let element = try session.element(index)
        let text = try args.requiredText("value")
        let role = element.string(kAXRoleAttribute) ?? ""
        lastInputWasSecret = element.string(kAXSubroleAttribute) == "AXSecureTextField"
        if role == "AXPopUpButton" || role == "AXComboBox" && !element.isSettable(kAXValueAttribute) {
            let how = try await chooseOption(element, text, app: app)
            return try await afterAction(app, "Chose \(quote(text, limit: 60)) in [\(index)] \(describe(element)) (\(how)).")
        }
        guard element.isSettable(kAXValueAttribute) else {
            throw ToolError("Element [\(index)] \(describe(element)) has no settable value. Click it and use type_text, or use its actions.")
        }
        if Self.textRoles.contains(role), isFlutter(app) {
            // Measured with RustDesk: the value reads back as set, but only
            // Flutter's invisible stand-in field changes, not what the app has.
            throw ToolError("[\(index)] \(describe(element)) is a text field of a Flutter app, which ignores values set through accessibility (the field would only appear to change). Nothing was changed. Click it by element_index (that focuses it, and makes its window the key window), then use type_text; press cmd+a first to replace what is there.")
        }
        if let frame = element.frame {
            await VirtualCursor.move(to: CGPoint(x: frame.midX, y: frame.midY), pid: app.processIdentifier)
            VirtualCursor.show(.keys("⌨︎"), pid: app.processIdentifier)
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
            // Chromium sets the value of the element itself; its tree only
            // reports the focus late in a window that is covered or not key.
            guard element.bool(kAXFocusedAttribute) == true || isChromium(app) else {
                throw ToolError("Could not focus [\(index)] \(describe(element)) to set its value; nothing was changed. Click it and use type_text instead.")
            }
        }
        try element.set(kAXValueAttribute, newValue)
        if webText {
            // Chromium updates the tree of a window that is not the key window
            // (or is covered) late, or not at all: then the read-back proves nothing.
            let elementWindow = containingWindow(of: element).flatMap(windowID(of:))
            let lagging = elementWindow != focusedWindowID(of: app.processIdentifier) || chromiumWindowFrozen(app, window: elementWindow)
            var now = await settledValue(element, expecting: text)
            if lagging, now != text {
                await Input.pause(0.6)
                now = await settledValue(element, expecting: text)
            }
            if let now, now != text {
                return try await afterAction(app, lagging
                    ? "Set the value of [\(index)] \(describe(element)), but could not confirm it: accessibility still reads \(quote(now, limit: 60)), and Chromium updates it late (or not at all) in a window that is not the app's key window or is covered. Check the page itself before setting it again."
                    : "Tried to set the value of [\(index)] \(describe(element)), but it now reads \(quote(now, limit: 60)); the page may have reformatted or rejected it.")
            }
        }
        return try await afterAction(app, "Set the value of [\(index)] \(describe(element)).")
    }

    func selectText(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\" (or a target).")
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
        if let frame = element.frame {
            await VirtualCursor.move(to: CGPoint(x: frame.midX, y: frame.midY), pid: app.processIdentifier)
            VirtualCursor.show(.click(count: 1, button: .left), pid: app.processIdentifier)
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

        // Wheel events, a page being about 85% of what shows of the element
        // (or of the window), at least 40 pt. Not AXScroll*ByPage: TextEdit
        // reports failure for it yet scrolls, the wrong way.
        guard let window = pointerWindow(pid: pid, at: point, element: element) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at that point.")
        }
        // Not into a remote session either: the wheel would scroll the remote computer.
        try checkPointerTarget(app, window: element.flatMap(containingWindow(of:)), what: "wheel input", receiver: window, point: point,
                               aimed: args.values["x"] != nil || args.values["y"] != nil)
        // Chromium drops wheel input to a fully covered window once it stops
        // drawing it (it does so a little while after the window is covered).
        let frozen = chromiumWindowFrozen(app, window: window)
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
        await VirtualCursor.move(to: point, pid: pid, window: window)
        await Input.scroll(at: point, dx: delta.0, dy: delta.1, pid: pid, windowID: window)
        VirtualCursor.show(.scroll(dx: delta.0, dy: delta.1), pid: pid)
        return try await afterAction(app, "Scrolled \(described) \(direction) \(formatNumber(pages)) page(s) (wheel event sent to the app in the background)."
            + (frozen ? " It may have done nothing: Chromium ignores wheel input to a window that is completely covered once it stops drawing it." : ""))
    }

    func drag(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        let start = try screenPoint(args, "from_x", "from_y", session: session)
        let end = try screenPoint(args, "to_x", "to_y", session: session)
        let pid = app.processIdentifier
        guard let window = pointerWindow(pid: pid, at: start) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at the start point.")
        }
        try checkPointerTarget(app, window: axWindow(window, pid: pid), receiver: window, point: start, aimed: true)
        var how = "background mouse events"
        let focus = args.bool("focus") ?? false
        await VirtualCursor.move(to: start, pid: pid, window: window)
        // The events take about half a second; the cursor moves with them, pressed.
        VirtualCursor.glide(to: end, pid: pid, window: window, pressed: true, duration: 0.45)
        if frontmostProcessID() != pid, briefFocusEnabled || focus, await briefFocusPermission(app) == true, await waitForUserIdle(),
           await Input.withBriefFocus(pid: pid, windowID: window, { await Input.drag(from: start, to: end, pid: pid, windowID: window) }) {
            how = "mouse events while the app had keyboard focus for a moment"
        } else {
            await Input.drag(from: start, to: end, pid: pid, windowID: window)
        }
        VirtualCursor.show(.release, pid: pid)
        return try await afterAction(app, "Dragged from (\(formatNumber(try args.double("from_x") ?? 0)), \(formatNumber(try args.double("from_y") ?? 0))) to (\(formatNumber(try args.double("to_x") ?? 0)), \(formatNumber(try args.double("to_y") ?? 0))) (\(how))." + (how.hasPrefix("background") ? " Some views ignore background drags (TextEdit's text, for one): check the screenshot, and select text with select_text instead." : ""))
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
        // Key events go to the app's key window, which may not be the window
        // the model works in: it is made the key window, or no key is sent.
        let keyboard = try await keyboardTarget(app, args)
        if !keyboard.reachesIntended {
            // Shortcuts done through accessibility work on any window.
            if let how = try emulateShortcut(chord, pid: pid, window: keyboard.intendedWindow, text: keyboard.text) {
                await VirtualCursor.typing(VirtualCursor.keycaps(key), pid: pid)
                return try await afterAction(app, "Pressed \(key) in \(quote(keyboard.intendedTitle, limit: 60)): \(how) (accessibility; the app's key window \(quote(keyboard.keyTitle, limit: 60)) was left alone).")
            }
            if let text = keyboard.text, let how = try await clipboardShortcut(chord, pid: pid, text: text, menu: false) {
                await VirtualCursor.typing(VirtualCursor.keycaps(key), pid: pid)
                return try await afterAction(app, "Pressed \(key): \(how).")
            }
            throw ToolError(keyboard.refusal(app: app.localizedName ?? "the app"))
        }
        await VirtualCursor.typing(VirtualCursor.keycaps(key), pid: pid)
        if let seconds = try args.double("hold_seconds") {
            guard (0.05...10).contains(seconds), count == 1 else {
                throw ToolError("hold_seconds must be between 0.05 and 10, without repeat.")
            }
            await Input.hold(chord, seconds: seconds, to: pid)
            return try await afterAction(app, "Held \(key) for \(formatNumber(seconds)) s (sent to the app in the background).\(keyboard.note)")
        }
        let text = keyboard.text ?? focusedTextElement(pid)
        let window = keyboard.intendedWindow ?? AXUIElementCreateApplication(pid).element(kAXFocusedWindowAttribute)

        // A background app ignores menu key equivalents, so run the menu item
        // itself. Items that depend on the focused document or text (Save,
        // Select All, Close) are disabled while the app is in the background;
        // the common ones are done through accessibility instead.
        if let how = try await clipboardShortcut(chord, pid: pid, text: text) {
            return try await afterAction(app, "Pressed \(key): \(how).\(keyboard.note)")
        }
        var disabledItem: String?
        if !chord.modifiers.isDisjoint(with: [.command, .control]) {
            if let item = menuItem(for: chord, pid: pid) {
                if item.enabled {
                    var pressed = 0
                    for _ in 0..<count {
                        let status = guardedAXPerformAction(item.element, kAXPressAction as CFString)
                        try throwIfRefused(status)
                        guard status == .success || status == .cannotComplete else { break }
                        pressed += 1
                    }
                    if pressed == count {
                        return try await afterAction(app, "Pressed \(key) by invoking the menu item \(quote(item.title, limit: 60)).\(keyboard.note)")
                    }
                } else {
                    disabledItem = item.title
                }
            }
            if let how = try emulateShortcut(chord, pid: pid, window: window, text: text) {
                return try await afterAction(app, "Pressed \(key): \(how) (accessibility).\(keyboard.note)")
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
        var message = "Pressed \(key)" + (count > 1 ? " ×\(count)" : "") + " (sent to the app in the background)." + keyboard.note
        if let disabledItem {
            message += " Its menu item \(quote(disabledItem, limit: 60)) is disabled while the app is in the background, so the shortcut did nothing. Commands that act on the current selection or document (formatting, Save, Undo…) only work in the frontmost app, and toolbar buttons for them are ignored in the background too. skfiy does not bring apps forward on its own; use run_in_front, which asks the user first, or say what is left to do instead of retrying."
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
        // Key events go to the app's key window, which may not be the window
        // the model works in: it is made the key window, or the text goes
        // into its field through accessibility, or nothing is sent.
        let keyboard = try await keyboardTarget(app, args)
        // Flutter takes text set through accessibility only in an invisible
        // stand-in field, so for it keys are the only way.
        let flutter = isFlutter(app)
        if !keyboard.reachesIntended {
            guard !flutter, let field = keyboard.text, field.isSettable(kAXSelectedTextAttribute) else {
                throw ToolError(keyboard.refusal(app: app.localizedName ?? "the app"))
            }
            await VirtualCursor.typing("⌨︎", pid: pid)
            lastInputWasSecret = field.string(kAXSubroleAttribute) == "AXSecureTextField"
            let before = field.string(kAXValueAttribute)
            try field.set(kAXSelectedTextAttribute, text as CFString)
            guard await settledValue(field, changedFrom: before) != before || before == nil else {
                throw ToolError("Keyboard input would go to the app's key window \(quote(keyboard.keyTitle, limit: 60)), so skfiy tried to insert the text into \(describe(field)) of \(quote(keyboard.intendedTitle, limit: 60)) through accessibility, but its value did not change\(keyboard.why). " + keyboard.refusal(app: app.localizedName ?? "the app"))
            }
            return try await afterAction(app, "Entered \(text.count) character(s) into \(describe(field)) of \(quote(keyboard.intendedTitle, limit: 60)) through accessibility: key events would have gone to the app's key window \(quote(keyboard.keyTitle, limit: 60)) instead\(keyboard.why). The app may not count text entered this way as a change; save explicitly before closing the document.")
        }
        await VirtualCursor.typing("⌨︎", pid: pid)
        // Background Chromium (Electron) reports no focused element even
        // right after a click focused a field: that field is meant.
        let focused = focusedElement(pid) ?? keyboard.text ?? typingTargets[pid].flatMap { $0.string(kAXRoleAttribute) == nil ? nil : $0 }
        lastInputWasSecret = focused?.string(kAXSubroleAttribute) == "AXSecureTextField"
        var note = keyboard.note
        if let focused, !isTextLike(focused) {
            note += " Keyboard focus is on \(describe(focused)), not a text field; click the field first if the text went missing."
        } else if focused == nil {
            note += " The app reports no focused element; click the field first if the text went missing."
        }

        // Insert directly when the frontmost app's input method would compose
        // keystrokes, or when the text is long enough that keystrokes are slow.
        let imeWouldCompose = frontmostProcessID() == pid && Input.inputMethodActive()
        if imeWouldCompose || text.count > 200, !flutter, let focused, focused.isSettable(kAXSelectedTextAttribute) {
            let before = focused.string(kAXValueAttribute)
            // Some apps (TextEdit) take text set through accessibility without
            // counting it as an edit: the document stays unchanged, and closing
            // it drops the text without asking. So a space goes in after the
            // text and is taken back with a real Delete key press, which they
            // do count (an input method lets Delete through).
            if (try? focused.set(kAXSelectedTextAttribute, (text + " ") as CFString)) != nil,
               before == nil || focused.string(kAXValueAttribute) != before {
                let inserted = await settledValue(focused, changedFrom: before)
                if let backspace = try? parseKeyChord("backspace") {
                    await Input.press(backspace, to: pid)
                }
                let after = await settledValue(focused, changedFrom: inserted)
                if let inserted, after == inserted {
                    // The key did not arrive: take the space back through
                    // accessibility too, and say the app may not see an edit.
                    if let range = selectedRange(focused), range.location > 0,
                       (try? setSelection(focused, CFRange(location: range.location - 1, length: 1))) != nil {
                        try? focused.set(kAXSelectedTextAttribute, "" as CFString)
                    }
                    return try await afterAction(app, "Entered \(text.count) character(s) (accessibility). The app may not count text entered this way as a change; save explicitly before closing the document.\(note)")
                }
                return try await afterAction(app, "Entered \(text.count) character(s) (accessibility, then a Delete key press so the app counts it as a change).\(note)")
            }
        }
        let before = focused?.string(kAXValueAttribute)
        let typed = await Input.type(text, to: pid)
        if typed < text.count {
            throw ToolError("Stopped after \(typed) of \(text.count) character(s): " + EmergencyStop.refusal)
        }
        await Input.pause(0.15)
        if !flutter, let focused, let before, focused.string(kAXValueAttribute) == before {
            // The app ignored background keystrokes: insert at the caret
            // through accessibility, or set the field's value with the text
            // put where the caret is.
            if focused.isSettable(kAXSelectedTextAttribute), (try? focused.set(kAXSelectedTextAttribute, text as CFString)) != nil,
               await settledValue(focused, changedFrom: before) != before {
                return try await afterAction(app, "Entered \(text.count) character(s) (the app ignored background keystrokes, so they were inserted through accessibility).\(note)")
            }
            if focused.isSettable(kAXValueAttribute) {
                let current = before as NSString
                let range = selectedRange(focused) ?? CFRange(location: current.length, length: 0)
                let location = min(max(0, range.location), current.length)
                let length = min(max(0, range.length), current.length - location)
                let updated = current.replacingCharacters(in: NSRange(location: location, length: length), with: text)
                if (try? focused.set(kAXValueAttribute, updated as CFString)) != nil, await settledValue(focused, expecting: updated) == updated {
                    setCaret(focused, location + (text as NSString).length)
                    return try await afterAction(app, "Entered \(text.count) character(s) (the app ignored background keystrokes, so the field's value was set through accessibility, with the text at the caret).\(note)")
                }
            }
        }
        return try await afterAction(app, "Typed \(text.count) character(s) (sent to the app in the background).\(note)")
    }

    // MARK: - Helpers

    /// A web field's value as accessibility reports it after a change:
    /// Chromium updates its tree asynchronously, so a read right after
    /// setting can still show the old value for a moment.
    func settledValue(_ element: AXUIElement, expecting: String? = nil, changedFrom: String? = nil) async -> String? {
        let timeout = 0.6
        let started = Date()
        var value = element.string(kAXValueAttribute)
        while Date().timeIntervalSince(started) < timeout {
            if let expecting, value == expecting { return value }
            if let changedFrom, value != changedFrom { return value }
            if expecting == nil, changedFrom == nil { return value }
            await Input.pause(0.05)
            value = element.string(kAXValueAttribute)
        }
        return value
    }

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
            ?? options.first(where: { $0.title.lowercased().contains(wanted) }) {
            let status = guardedAXPerformAction(item.element, kAXPressAction as CFString)
            try throwIfRefused(status)
            if status == .success {
                await Input.pause(0.2)
                if selected() || popup.string(kAXValueAttribute) == nil {
                    return "pressed the option through accessibility"
                }
            }
        }
        if popup.isSettable(kAXValueAttribute) {
            let status = guardedAXSetAttributeValue(popup, kAXValueAttribute as CFString, option as CFString)
            try throwIfRefused(status)
            if status == .success {
                await Input.pause(0.2)
                if selected() { return "set through accessibility" }
            }
        }
        try checkInputTarget(app)
        // Typed keys go to the app's key window: only when the pop-up is in it.
        let names = options.map { quote($0.title, limit: 40) }.joined(separator: ", ")
        let popupWindow = containingWindow(of: popup).flatMap(windowID(of:))
        guard popupWindow == nil || popupWindow == focusedWindowID(of: app.processIdentifier) else {
            throw ToolError("Could not choose \(quote(option, limit: 60)) through accessibility, and typing its name would go to the app's key window, not to the window of this pop-up, so nothing was typed. The value is still \(quote(popup.string(kAXValueAttribute) ?? "?", limit: 60)).\(names.isEmpty ? "" : " Options: \(names).")")
        }
        _ = try? popup.set(kAXFocusedAttribute, kCFBooleanTrue)
        await Input.pause(0.1)
        await Input.type(option, to: app.processIdentifier)
        await Input.pause(0.3)
        if selected() { return "focused it and typed the option name" }
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
        try lockedUse?.check()
        guard !isScreenLocked() else {
            throw ToolError("The screen is locked. No input was sent.")
        }
        guard !app.isTerminated else {
            throw ToolError("\(app.localizedName ?? "The app") has quit.")
        }
    }

    /// The running app `query` names; an app that is only installed is
    /// launched in the background when `launch`, else refused.
    private func runningApp(_ query: String, launch: Bool) async throws -> NSRunningApplication {
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
    private func afterAction(_ app: NSRunningApplication, _ message: String) async throws -> ToolResult {
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

    /// The app's focused element, when it takes text.
    private func focusedTextElement(_ pid: pid_t) -> AXUIElement? {
        focusedElement(pid).flatMap { isTextLike($0) ? $0 : nil }
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

    /// The selected range of a text element, when it reports one.
    func selectedRange(_ element: AXUIElement) -> CFRange? {
        guard let value = element.value(kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange(location: 0, length: 0)
        return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
    }

    func setSelection(_ element: AXUIElement, _ range: CFRange) throws {
        var selection = range
        guard let value = AXValueCreate(.cfRange, &selection) else {
            throw ToolError("Could not build the selection range.")
        }
        try element.set(kAXSelectedTextRangeAttribute, value)
    }

    /// cmd+c, cmd+x and cmd+v work on skfiy's own clipboard, in any app. Text
    /// is copied and pasted through accessibility, without the system
    /// clipboard. Anything else (files, cells, images) goes through the app's
    /// own Copy, Cut or Paste command, with the user's clipboard lent for that
    /// moment and put straight back.
    /// `text` is the field to copy from or paste into; without one (or with
    /// rich contents) the app's own menu command is used, unless `menu` is
    /// false (it would act on the app's key window, not the one meant).
    private func clipboardShortcut(_ chord: KeyChord, pid: pid_t, text: AXUIElement?, menu: Bool = true) async throws -> String? {
        guard chord.modifiers == .command, let character = chord.baseCharacter, "cxv".contains(character) else { return nil }
        switch character {
        case "c", "x":
            guard let text else {
                guard menu else { return nil }
                return try await copyThroughSystemClipboard(chord, pid: pid, cut: character == "x")
            }
            guard let selected = text.string(kAXSelectedTextAttribute), !selected.isEmpty else {
                throw ToolError("Nothing is selected in the focused field; select text first (select_text).")
            }
            clipboard = .text(selected)
            if character == "x" {
                try text.set(kAXSelectedTextAttribute, "" as CFString)
            }
            let verb = character == "x" ? "cut" : "copied"
            return "\(verb) \(quote(selected, limit: 60)) to skfiy's own clipboard (the user's clipboard is untouched); cmd+v pastes it in any app"
        default:
            guard let clipboard else {
                throw ToolError("skfiy's clipboard is empty. Copy with cmd+c first, type with type_text, or take what the user copied with read_clipboard (they are asked).")
            }
            if let text, !clipboard.isRich, let string = clipboard.text {
                try text.set(kAXSelectedTextAttribute, string as CFString)
                return "pasted \(quote(string, limit: 60)) from skfiy's own clipboard (accessibility; the user's clipboard is untouched)"
            }
            guard menu else { return nil }
            return try await pasteThroughSystemClipboard(clipboard, chord, pid: pid)
        }
    }

    /// Runs the app's Copy or Cut command and keeps what it copied, putting
    /// the user's clipboard back right after.
    private func copyThroughSystemClipboard(_ chord: KeyChord, pid: pid_t, cut: Bool) async throws -> String {
        let key = cut ? "cmd+x" : "cmd+c"
        guard let item = menuItem(for: chord, pid: pid) else {
            throw ToolError("The focused element is not text, and the app has no menu command for \(key) to copy it with.")
        }
        guard item.enabled else {
            throw ToolError("\(quote(item.title, limit: 30)) is disabled while the app is in the background (nothing selected, or the command only works in the front app). run_in_front with key \"\(key)\" runs it with the user's approval; skfiy then keeps what was copied and puts the user's clipboard back.")
        }
        let system = SystemClipboard()
        let saved = system.read()
        let before = system.changeCount
        try throwIfRefused(guardedAXPerformAction(item.element, kAXPressAction as CFString))
        guard await system.waitForChange(from: before) else {
            throw ToolError("Pressed \(quote(item.title, limit: 30)), but the app copied nothing (is something selected?). The user's clipboard was not touched.")
        }
        await Input.pause(0.15)  // the app may still be adding representations
        let copied = system.read()
        system.write(saved)
        clipboard = copied
        return "\(cut ? "cut" : "copied") \(copied.summary) into skfiy's own clipboard with the app's \(quote(item.title, limit: 30)) command; the user's clipboard was lent for that moment and put back. cmd+v pastes it in any app"
    }

    /// Runs the app's Paste command on skfiy's clipboard, with the user's
    /// clipboard lent for that moment.
    private func pasteThroughSystemClipboard(_ contents: ClipboardContents, _ chord: KeyChord, pid: pid_t) async throws -> String {
        guard let item = menuItem(for: chord, pid: pid) else {
            throw ToolError("skfiy's clipboard holds \(contents.summary), which only the app's Paste command can paste, and the app has none for cmd+v.")
        }
        guard item.enabled else {
            throw ToolError("\(quote(item.title, limit: 30)) is disabled while the app is in the background. run_in_front with key \"cmd+v\" pastes skfiy's clipboard with the user's approval.")
        }
        let system = SystemClipboard()
        let saved = system.read()
        system.write(contents)
        let lent = system.changeCount
        if guardedAXPerformAction(item.element, kAXPressAction as CFString) == .failure, let refusal = axMutationRefusal() {
            if system.changeCount == lent { system.write(saved) }
            throw ToolError(refusal)
        }
        await Input.pause(0.5)  // the app reads the clipboard while pasting
        let putBack = system.changeCount == lent
        if putBack {
            system.write(saved)
        }
        return "pasted \(contents.summary) from skfiy's own clipboard with the app's \(quote(item.title, limit: 30)) command; "
            + (putBack ? "the user's clipboard was lent for that moment and put back" : "the clipboard changed meanwhile (the user may have copied something), so it was left as it is")
    }

    // MARK: - hand_over

    /// Hands a step to the user (signing in, a code, a confirmation) and
    /// waits until they say it is done, then optionally checks the app.
    func handOver(_ args: Arguments) async throws -> ToolResult {
        let message = try args.requiredText("message").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            throw ToolError("\"message\" must say what the user should do.")
        }
        guard let waitForUser else {
            throw ToolError("This client cannot ask the user. Tell them in the conversation what to do, and wait for their reply.")
        }
        switch await waitForUser("Your turn: \(message)\nConfirm when it is done, or decline if you cannot or do not want to.") {
        case nil:
            throw ToolError("No answer came from the user (or this client cannot ask). Tell them in the conversation what is left to do.")
        case false?:
            throw ToolError("The user did not do it. Do not try to do it yourself; stop and tell them what is left.")
        case true?:
            break
        }
        guard let app = args.string("app"), !app.isEmpty else {
            return ToolResult(text: "The user says it is done.")
        }
        if let expect = args.string("expect"), !expect.isEmpty {
            var result = try await waitFor(Arguments(["app": app, "text": expect, "timeout": 10]))
            result.text = "The user says it is done. " + result.text
            return result
        }
        var state = try await getAppState(Arguments(["app": app]))
        state.text = "The user says it is done. The app now:\n" + state.text
        return state
    }

    // MARK: - read_clipboard

    /// Takes what the user copied into skfiy's clipboard, once they approve.
    func readClipboard(_ args: Arguments) async throws -> ToolResult {
        let contents = SystemClipboard().read()
        guard !contents.isEmpty else {
            throw ToolError("The user's clipboard is empty.")
        }
        guard !contents.isConcealed else {
            throw ToolError("The user's clipboard holds something their password manager marked as secret; skfiy does not read it.")
        }
        guard let askUser else {
            throw ToolError("Reading the user's clipboard needs their approval, and this client cannot ask them. Ask the user to paste it into the conversation instead.")
        }
        let reason = args.string("reason").map { " (\($0))" } ?? ""
        switch await askUser("skfiy wants to use what you copied (\(contents.summary))\(reason).") {
        case nil:
            throw ToolError("Reading the user's clipboard needs their approval, and this client cannot ask them (or no answer came). Ask the user to paste it into the conversation instead.")
        case false?:
            throw ToolError("The user declined sharing their clipboard. Do not ask again.")
        case true?:
            break
        }
        clipboard = contents
        var text = "With the user's approval, took what they copied (\(contents.summary)) into skfiy's own clipboard; cmd+v pastes it in any app."
        if let string = contents.text {
            text += "\nIts text:\n" + String(string.prefix(20_000))
        }
        return ToolResult(text: text)
    }

    /// cmd+a, cmd+w and cmd+m through accessibility, on `window` (the window
    /// the model works in) and its text field.
    private func emulateShortcut(_ chord: KeyChord, pid: pid_t, window: AXUIElement?, text: AXUIElement?) throws -> String? {
        guard chord.modifiers == .command, let character = chord.baseCharacter else { return nil }
        switch character {
        case "a":
            guard let text else { return nil }
            let length = (text.string(kAXValueAttribute) as NSString?)?.length ?? 0
            try setSelection(text, CFRange(location: 0, length: length))
            return "selected all text in the focused field"
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

    func describe(_ element: AXUIElement) -> String {
        let values = element.multipleValues([kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute])
        let role = values[kAXRoleAttribute].flatMap(axString).map(withoutAXPrefix) ?? "element"
        let label = nonEmpty(values[kAXTitleAttribute].flatMap(axString)) ?? nonEmpty(values[kAXDescriptionAttribute].flatMap(axString))
        return label.map { "\(role) \(quote($0, limit: 60))" } ?? role
    }
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
