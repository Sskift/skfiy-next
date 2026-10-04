import AppKit
import ApplicationServices
import Foundation

/// Opt-in, process-directed input and single-window capture while the OS
/// stays locked. This path never asks an authorization service to unlock.
@MainActor
final class DirectLockedUse {
    static var enabled: Bool { ProcessInfo.processInfo.environment["SKFIY_LOCKED_USE"] == "direct" }

    enum LockState { case locked, unlocked, unavailable }
    static var lockState: LockState {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session["kCGSSessionOnConsoleKey"] as? Bool == true,
              session["kCGSessionLoginDoneKey"] as? Bool == true,
              session["kCGSSessionUserIDKey"] as? Int == Int(getuid()) else { return .unavailable }
        return session["CGSSessionScreenIsLocked"] as? Bool == true ? .locked : .unlocked
    }

    private struct State {
        let app: NSRunningApplication
        let executable: URL?
        let launched: Date?
        let window: DirectLockedWindow
        let geometry: CaptureGeometry
        let captured: Date
        let generation: UInt64
    }

    private let directory = AppDirectory()
    private var states: [pid_t: State] = [:]
    private var previousLockState: LockState?
    private var ended = false
    private var generation: UInt64 = 0
    private var observers: [NSObjectProtocol] = []
    private let settle = Double(ProcessInfo.processInfo.environment["SKFIY_SETTLE_SECONDS"] ?? "") ?? 0.4

    init() {
        guard Self.enabled else { return }
        for name in ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"] {
            observers.append(DistributedNotificationCenter.default().addObserver(
                forName: NSNotification.Name(name), object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.generation &+= 1
                    self?.states.removeAll()
                }
            })
        }
    }

    /// Tell the ordinary AX path to discard indices across an observed lock
    /// transition as well. Direct snapshots are never usable as AX sessions.
    func observeTransition() -> Bool {
        let current = Self.lockState
        defer { previousLockState = current }
        guard previousLockState != current else { return false }
        generation &+= 1
        states.removeAll()
        return true
    }

    func status(end: Bool = false) -> ToolResult {
        if end { ended = true; generation &+= 1; states.removeAll() }
        let state = Self.lockState
        let object: [String: Any] = [
            "enabled": !ended, "mode": "direct", "screenLocked": state == .locked,
            "lockStateKnown": state != .unavailable, "temporarilyUnlocks": false,
            "phase": ended ? "ended" : state == .locked ? "locked" : "idle",
            "requiresDeveloperCertificate": false
        ]
        return ToolResult(text: String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self))
    }

    private func check(generation expected: UInt64? = nil) throws {
        guard !ended else { throw ToolError("Direct locked use ended for this MCP session. Start a new session to enable it again.") }
        guard !EmergencyStop.isStopped else { throw ToolError(EmergencyStop.refusal) }
        try Task.checkCancellation()
        if let expected, expected != generation {
            throw ToolError("The locked session changed during this operation. Refresh get_app_state; no further input was sent.")
        }
        guard Self.lockState == .locked else {
            states.removeAll()
            throw ToolError("The locked session changed or is unavailable. No further direct input was sent; call get_app_state again.")
        }
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw ToolError("Direct locked use requires Accessibility and Screen Recording permissions for the host app. Run skfiy doctor.")
        }
    }

    private func application(_ args: Arguments) throws -> NSRunningApplication {
        let query = try args.requiredString("app")
        guard case .running(let app) = try directory.resolve(query), !app.isTerminated else {
            throw ToolError("Open \(query) before locking the Mac, then call get_app_state. Direct locked use targets running apps only.")
        }
        let identifier = app.bundleIdentifier ?? ""
        guard identifier != "com.apple.loginwindow", !identifier.hasPrefix("com.apple.SecurityAgent"),
              !identifier.hasPrefix("com.apple.authorizationhost"),
              !["loginwindow", "SecurityAgent", "authorizationhost"].contains(app.executableURL?.lastPathComponent ?? "") else {
            throw ToolError("Direct locked use does not read or control system login and authentication windows.")
        }
        return app
    }

    private func sameProcess(_ state: State) -> Bool {
        guard !state.app.isTerminated, let current = NSRunningApplication(processIdentifier: state.window.pid) else { return false }
        return current.executableURL == state.executable && current.launchDate == state.launched
    }

    private func windowIDs(_ windows: [[String: Any]], ownedBy pid: pid_t) -> Set<CGWindowID> {
        Set(windows.compactMap { row in
            guard row[kCGWindowOwnerPID as String] as? Int == Int(pid) else { return nil }
            return row[kCGWindowNumber as String] as? CGWindowID
        })
    }

    private func currentWindowIDs(ownedBy pid: pid_t) throws -> Set<CGWindowID> {
        guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw ToolError("Window ownership metadata is unavailable; no keyboard input was sent.")
        }
        return windowIDs(windows, ownedBy: pid)
    }

    private func validationProblem(_ state: State, keyboardWindows: Set<CGWindowID>? = nil) -> String? {
        guard !ended, state.generation == generation else { return "locked session generation changed" }
        guard Self.lockState == .locked else { return "OS session is no longer locked" }
        guard sameProcess(state) else { return "app process identity changed" }
        let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        if let keyboardWindows {
            // This includes inactive helpers as well as real windows. Only
            // the SCK check at operation start may classify helpers; any new
            // window needs a fresh classification before more keys are sent.
            guard windowIDs(windows, ownedBy: state.window.pid) == keyboardWindows else {
                return "the app's window set changed during keyboard input"
            }
            let candidates = windows.filter { row in
                guard row[kCGWindowOwnerPID as String] as? Int == Int(state.window.pid),
                      row[kCGWindowIsOnscreen as String] as? Bool == true,
                      (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                      let bounds = row[kCGWindowBounds as String] as? NSDictionary,
                      let frame = CGRect(dictionaryRepresentation: bounds) else { return false }
                return frame.width >= 2 && frame.height >= 2
            }
            guard candidates.count == 1, candidates[0][kCGWindowNumber as String] as? UInt32 == state.window.id else {
                return "keyboard destination is ambiguous because the app's windows changed"
            }
        }
        guard let row = windows.first(where: { $0[kCGWindowNumber as String] as? UInt32 == state.window.id }),
              row[kCGWindowOwnerPID as String] as? Int == Int(state.window.pid),
              row[kCGWindowIsOnscreen as String] as? Bool == true,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds) else { return "window ownership metadata is unavailable" }
        return frame == state.window.frame ? nil : "window geometry differs: CG=\(frame), screenshot=\(state.window.frame)"
    }

    private func valid(_ state: State, keyboardWindows: Set<CGWindowID>? = nil) -> Bool {
        validationProblem(state, keyboardWindows: keyboardWindows) == nil
    }

    private func target(_ args: Arguments) async throws -> State {
        try check()
        let app = try application(args)
        guard let state = states[app.processIdentifier], Date().timeIntervalSince(state.captured) < 30,
              valid(state) else {
            states[app.processIdentifier] = nil
            throw ToolError("No recent matching locked-window screenshot. Call get_app_state before sending input.")
        }
        guard let live = try await directLockedWindows(pid: app.processIdentifier).first(where: { $0.id == state.window.id }),
              live.frame == state.window.frame else {
            states[app.processIdentifier] = nil
            throw ToolError("The captured window moved, resized, or closed. Call get_app_state again; no input was sent.")
        }
        try check(generation: state.generation)
        return state
    }

    private func point(_ args: Arguments, _ x: String, _ y: String, state: State) throws -> CGPoint {
        guard let px = try args.double(x), let py = try args.double(y), px.isFinite, py.isFinite,
              px >= 0, py >= 0, px < Double(state.geometry.pixelWidth), py < Double(state.geometry.pixelHeight) else {
            throw ToolError("\(x)/\(y) must be inside the latest screenshot in pixels.")
        }
        return state.geometry.toScreen(x: px, y: py)
    }

    private func snapshot(_ args: Arguments, selected: DirectLockedWindow? = nil, message: String? = nil) async throws -> ToolResult {
        try check()
        let captureGeneration = generation
        let app = try application(args)
        states[app.processIdentifier] = nil
        let windows = try await directLockedWindows(pid: app.processIdentifier).sorted {
            if $0.title.isEmpty != $1.title.isEmpty { return !$0.title.isEmpty }
            return $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height
        }
        let query = args.string("window")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let window: DirectLockedWindow
        if let selected {
            guard let existing = windows.first(where: { $0.id == selected.id }) else {
                states[app.processIdentifier] = nil
                throw ToolError("The selected window closed. Call get_app_state to choose a current window.")
            }
            window = existing
        } else if !query.isEmpty {
            let matches = windows.filter { $0.title.localizedCaseInsensitiveContains(query) || String($0.id) == query }
            guard matches.count == 1, let match = matches.first else {
                throw ToolError("Window selection is absent or ambiguous. Available windows: \(windows.map { "\($0.id): \($0.title)" }.joined(separator: "; "))")
            }
            window = match
        } else if let first = windows.first { window = first }
        else { throw ToolError("This app has no capturable window in the locked session.") }
        let shot = try await captureDirectLockedWindow(window)
        try check(generation: captureGeneration)
        guard shot.geometry.rect == window.frame else { throw ToolError("The selected window changed before capture. Refresh get_app_state.") }
        let state = State(app: app, executable: app.executableURL, launched: app.launchDate,
                          window: window, geometry: shot.geometry, captured: Date(), generation: captureGeneration)
        if let problem = validationProblem(state) { throw ToolError("The target window changed while capturing it (\(problem)). Refresh get_app_state.") }
        var lines = [message, "App: \(app.localizedName ?? "?") — \(app.bundleIdentifier ?? "") (pid \(app.processIdentifier))",
                     "Direct locked use: macOS remains locked. This is a live window screenshot; use x/y, press_key and type_text. AX element indices and foreground actions are unavailable.",
                     "Window: \(quote(window.title, limit: 100)) (id \(window.id))",
                     "Screenshot: \(shot.geometry.pixelWidth)×\(shot.geometry.pixelHeight) px showing screen region x=\(window.frame.minX) y=\(window.frame.minY) w=\(window.frame.width) h=\(window.frame.height) pt. x/y arguments are pixels in this latest screenshot."].compactMap { $0 }
        if windows.count > 1 {
            lines.append("Other windows (pass window title or id to get_app_state): " + windows.filter { $0.id != window.id }.map { "\($0.id): \($0.title)" }.joined(separator: "; "))
        }
        if (args.values["ocr"] as? Bool) ?? true, let image = TextRecognition.decode(shot.data) {
            let recognized = TextRecognition.sorted(try await TextRecognition.recognize(image, showing: shot.geometry.rect))
            lines.append("Text recognized in the screenshot (use x/y):")
            for text in recognized.prefix(200) {
                let middle = shot.geometry.toPixels(CGPoint(x: text.frame.midX, y: text.frame.midY))
                lines.append("  \(quote(text.text, limit: 100)) x=\(Int(middle.x.rounded())) y=\(Int(middle.y.rounded()))")
            }
        }
        try check(generation: captureGeneration)
        guard valid(state) else { throw ToolError("The window changed while reading its screenshot. Refresh get_app_state.") }
        states[app.processIdentifier] = state
        return ToolResult(text: lines.joined(separator: "\n"), image: shot.data, imageMimeType: shot.mimeType)
    }

    func perform(_ name: String, _ args: Arguments) async throws -> ToolResult {
        try check()
        if name == "get_app_state" { return try await snapshot(args) }
        let allowed: Set<String> = ["click", "scroll", "drag", "press_key", "type_text"]
        guard allowed.contains(name) else {
            throw ToolError("\(name) is unavailable while macOS remains locked. Use get_app_state and screenshot coordinates with click, scroll, drag, press_key or type_text; unlock manually for AX or foreground actions.")
        }
        guard try args.elementIndex() == nil, args.values["focus"] as? Bool != true else {
            throw ToolError("Direct locked use accepts screenshot coordinates only, without element_index or focus. Refresh get_app_state.")
        }
        let state = try await target(args)
        let pid = state.window.pid
        let keyboardWindows: Set<CGWindowID>?
        if name == "type_text" || name == "press_key" {
            // Bracket the async active-window classification with the complete
            // CG set, so a window created during that await is not silently
            // accepted into the per-event baseline without being classified.
            let before = try currentWindowIDs(ownedBy: pid)
            let active = try await directLockedActiveWindowIDs(pid: pid)
            try check(generation: state.generation)
            guard active == Set([state.window.id]) else {
                throw ToolError("This app has multiple or different active windows, so the keyboard destination cannot be verified while locked. Leave one window open before locking, or unlock manually.")
            }
            guard try currentWindowIDs(ownedBy: pid) == before, valid(state, keyboardWindows: before) else {
                states[pid] = nil
                throw ToolError("The app's windows changed while checking the keyboard destination. Refresh get_app_state; no keyboard input was sent.")
            }
            keyboardWindows = before
        } else { keyboardWindows = nil }
        Input.directLockedAborted = false
        Input.directLockedValidation = { [weak self] in self?.valid(state, keyboardWindows: keyboardWindows) == true }
        Input.directLockedReleaseValidation = { [weak self] in self?.sameProcess(state) == true }
        Input.directLockedWindowOrigin = state.window.frame.origin
        defer {
            Input.directLockedValidation = nil
            Input.directLockedReleaseValidation = nil
            Input.directLockedWindowOrigin = nil
        }
        let message: String
        switch name {
        case "click":
            let at = try point(args, "x", "y", state: state)
            guard let button = MouseButton(rawValue: (args.string("mouse_button") ?? "left").lowercased()) else {
                throw ToolError("mouse_button must be left, right, or middle.")
            }
            let count = try args.int("click_count") ?? 1
            guard (1...3).contains(count) else { throw ToolError("click_count must be 1, 2, or 3.") }
            await Input.click(at: at, pid: pid, windowID: state.window.id, button: button, count: count,
                              modifiers: try parseModifierList(args.string("modifiers")), chromium: false)
            message = "Sent \(button.rawValue) click to the captured window while macOS remained locked."
        case "scroll":
            let at = try point(args, "x", "y", state: state)
            let direction = try args.requiredString("direction").lowercased()
            let pages = try args.double("pages") ?? 1
            guard pages.isFinite, pages > 0, pages <= 50, ["up", "down", "left", "right"].contains(direction) else {
                throw ToolError("Use direction up/down/left/right and pages between 0 and 50.")
            }
            let vertical = direction == "up" || direction == "down"
            let distance = max((vertical ? state.window.frame.height : state.window.frame.width) * 0.85, 40) * pages
            let dx = direction == "left" ? -distance : direction == "right" ? distance : 0
            let dy = direction == "up" ? -distance : direction == "down" ? distance : 0
            await Input.scroll(at: at, dx: dx, dy: dy, pid: pid, windowID: state.window.id)
            message = "Sent scroll \(direction) to the captured window."
        case "drag":
            let from = try point(args, "from_x", "from_y", state: state)
            let to = try point(args, "to_x", "to_y", state: state)
            await Input.drag(from: from, to: to, pid: pid, windowID: state.window.id)
            message = "Sent drag to the captured window."
        case "press_key":
            let chord = try parseKeyChord(args.requiredString("key"))
            guard !chord.modifiers.contains(.command) || !["c", "x", "v"].contains(chord.baseCharacter ?? "") else {
                throw ToolError("Clipboard shortcuts are unavailable in direct locked use. Use type_text for text input.")
            }
            let count = try args.int("repeat") ?? 1
            guard (1...100).contains(count) else { throw ToolError("repeat must be between 1 and 100.") }
            if let seconds = try args.double("hold_seconds") {
                guard seconds.isFinite, (0.05...10).contains(seconds), count == 1 else {
                    throw ToolError("hold_seconds must be between 0.05 and 10, without repeat.")
                }
                await Input.hold(chord, seconds: seconds, to: pid)
            } else { await Input.press(chord, repeat: count, to: pid) }
            message = "Sent keyboard events to the app while macOS remained locked. Verify the result in the screenshot."
        default:
            let text = try args.requiredText("text")
            guard text.count <= 100_000 else { throw ToolError("Text is too long for one operation.") }
            let count = await Input.type(text, to: pid)
            guard count == text.count else { throw ToolError("Text input was interrupted after \(count) characters.") }
            message = "Sent \(count) characters to the app while macOS remained locked."
        }
        guard !Input.directLockedAborted else { states[pid] = nil; throw ToolError("Direct input stopped because the lock state or target window changed. Refresh get_app_state.") }
        try check(generation: state.generation)
        await Input.pause(settle)
        try check(generation: state.generation)
        return try await snapshot(args, selected: state.window, message: message)
    }
}
