import AppKit
import ApplicationServices
import Foundation

/// Opt-in, process-directed input and single-window capture while the OS
/// stays locked. This path never asks an authorization service to unlock.
@MainActor
final class DirectLockedUse {
    static var enabled: Bool { ProcessInfo.processInfo.environment["SKFIY_LOCKED_USE"] == "direct" }
    /// Direct mode is on and macOS is not known to be unlocked: tools take
    /// the locked path.
    static var isActive: Bool { enabled && isScreenLocked() }

    /// Notifications remember a complete lock/unlock cycle between calls,
    /// even when polling sees the same state before and after that cycle.
    struct TransitionTracker {
        private var previousState: LockState?
        private var notificationPending = false

        mutating func receivedNotification() { notificationPending = true }

        mutating func observe(_ current: LockState) -> Bool {
            let changed = notificationPending || previousState != current
            notificationPending = false
            previousState = current
            return changed
        }
    }

    private struct State {
        let app: NSRunningApplication
        let executable: URL?
        let launched: Date?
        let window: DirectLockedWindow
        let geometry: CaptureGeometry
        let captured: Date
        let generation: UInt64
        /// The text recognized on the capture at display resolution.
        var recognized: [RecognizedText] = []
    }

    /// Tools this mode serves while macOS is locked, in the order capability
    /// reports list them; everything else is refused.
    nonisolated static let lockedTools = ToolSchemas.names(.whileLocked)

    /// How long a screenshot's coordinates are used while locked.
    private static let screenshotLifetime: TimeInterval = 30

    private let directory = AppDirectory()
    private var states: [pid_t: State] = [:]
    /// The latest zoom per app; its coordinates hold while its screenshot does.
    private var zooms: [pid_t: ZoomMapping] = [:]
    /// The window each app's latest screenshot showed, kept after the
    /// screenshot expires: locating looks there again.
    private var shownWindows: [pid_t: CGWindowID] = [:]
    /// The last looks per app, with what was recognized, for since.
    private var history: [pid_t: [(record: StateRecord, recognized: [RecognizedText])]] = [:]
    private var zoomCount = 0
    private var transitions = TransitionTracker()
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
                    self?.transitions.receivedNotification()
                    self?.generation &+= 1
                    self?.states.removeAll()
                    self?.history.removeAll()
                }
            })
        }
    }

    /// Tell the ordinary AX path to discard indices across an observed lock
    /// transition as well. Direct snapshots are never usable as AX sessions.
    func observeTransition() -> Bool {
        guard transitions.observe(sessionLockState()) else { return false }
        generation &+= 1
        states.removeAll()
        return true
    }

    var isEnded: Bool { ended }

    /// Seconds since the latest screenshot of this app, while its coordinates are still usable.
    func screenshotAge(pid: pid_t) -> Double? {
        guard let state = states[pid], valid(state) else { return nil }
        let age = Date().timeIntervalSince(state.captured)
        return age < Self.screenshotLifetime ? age : nil
    }

    func status(end: Bool = false) -> ToolResult {
        if end { ended = true; generation &+= 1; states.removeAll() }
        let state = sessionLockState()
        let object: [String: Any] = [
            "enabled": !ended, "mode": "direct", "screenLocked": state == .locked,
            "lockStateKnown": state != .unavailable, "temporarilyUnlocks": false,
            "phase": ended ? "ended" : state == .locked ? "locked" : "idle",
            "requiresDeveloperCertificate": false, "emergencyStop": EmergencyStop.isStopped
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
        guard sessionLockState() == .locked else {
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
        guard !isProtectedInterface(app) else {
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
        guard sessionLockState() == .locked else { return "OS session is no longer locked" }
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
        if let raw = args.string("window_id")?.trimmingCharacters(in: .whitespaces), !raw.isEmpty {
            guard let wanted = CGWindowID(raw) else { throw ToolError("window_id must be a window id number from get_app_state.") }
            guard let state = states[app.processIdentifier], state.window.id == wanted else {
                throw ToolError("window_id \(wanted) is not the window of the latest screenshot. Call get_app_state with window: \"\(wanted)\" first; no input was sent.")
            }
        }
        guard let state = states[app.processIdentifier], Date().timeIntervalSince(state.captured) < Self.screenshotLifetime,
              valid(state) else {
            let previous = states[app.processIdentifier]
            states[app.processIdentifier] = nil
            if let previous, let current = try? await directLockedWindows(pid: app.processIdentifier),
               !current.contains(where: { $0.id == previous.window.id }) {
                let same = current.filter { $0.title == previous.window.title && !$0.title.isEmpty }
                throw ToolError("The captured window (id \(previous.window.id)) closed" + (same.isEmpty ? "" : "; a window with the same title is now id \(same.map { String($0.id) }.joined(separator: ", ")) (recreated)") + ". Call get_app_state again; no input was sent.")
            }
            if let previous {
                let age = Date().timeIntervalSince(previous.captured)
                let why = age >= Self.screenshotLifetime ? "it is \(Int(age)) s old" : validationProblem(previous).map { $0.hasPrefix("window geometry differs") ? "the window moved or changed size (\($0))" : $0 } ?? "it no longer matches"
                throw ToolError("The latest screenshot cannot be used: \(why). Call get_app_state again; no input was sent.")
            }
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
        if let zoomed = try zoomPoint(args, x, y, latest: zooms[state.window.pid], screenshot: state.geometry, taken: state.captured,
                                      notDone: "no input was sent") {
            return zoomed
        }
        guard let px = try args.double(x), let py = try args.double(y), px.isFinite, py.isFinite,
              px >= 0, py >= 0, px < Double(state.geometry.pixelWidth), py < Double(state.geometry.pixelHeight) else {
            throw ToolError("\(x)/\(y) must be inside the latest screenshot in pixels.")
        }
        return state.geometry.toScreen(x: px, y: py)
    }

    /// One capture at the display's full resolution serves both: text is
    /// recognized on it (at 1×, OCR splits and misreads words), and the model
    /// gets it resized to the usual point-sized screenshot of the same frame.
    private struct Capture {
        let shot: Screenshot
        let hires: CGImage
    }

    private func capture(_ window: DirectLockedWindow) async throws -> Capture {
        let (hires, hiresGeometry) = try await captureDirectLockedImage(window, maxScale: backingScale(for: window.frame))
        return try prepare(hires, hiresGeometry)
    }

    /// The model's screenshot from a capture at display resolution.
    private func prepare(_ hires: CGImage, _ hiresGeometry: CaptureGeometry) throws -> Capture {
        let scale = captureScale(for: hiresGeometry.rect.size, maxScale: 1)
        let width = max(1, Int((hiresGeometry.rect.width * scale).rounded()))
        let height = max(1, Int((hiresGeometry.rect.height * scale).rounded()))
        guard let image = resized(hires, width: width, height: height) else { throw ToolError("Could not prepare the screenshot.") }
        let geometry = CaptureGeometry(rect: hiresGeometry.rect, pixelWidth: width, pixelHeight: height)
        return Capture(shot: try encodeScreenshot(image, geometry: geometry), hires: hires)
    }

    /// The app's capturable windows, titled ones first, then by size.
    private func windows(of app: NSRunningApplication) async throws -> [DirectLockedWindow] {
        try await directLockedWindows(pid: app.processIdentifier).sorted {
            if $0.title.isEmpty != $1.title.isEmpty { return !$0.title.isEmpty }
            return $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height
        }
    }

    /// The window named by `window` (title or id), the selected one, or the first.
    private func choose(_ windows: [DirectLockedWindow], query: String, selected: DirectLockedWindow?) throws -> DirectLockedWindow {
        if let selected {
            guard let existing = windows.first(where: { $0.id == selected.id }) else {
                throw ToolError("The selected window closed. Call get_app_state to choose a current window.")
            }
            return existing
        }
        if let exact = windows.first(where: { String($0.id) == query }) { return exact }
        if !query.isEmpty {
            let matches = windows.filter { $0.title.localizedCaseInsensitiveContains(query) || String($0.id) == query }
            guard matches.count == 1, let match = matches.first else {
                throw ToolError("Window selection is absent or ambiguous. Available windows: \(windows.map { "\($0.id): \($0.title)" }.joined(separator: "; "))")
            }
            return match
        }
        guard let first = windows.first else { throw ToolError("This app has no capturable window in the locked session.") }
        return first
    }

    /// A capture (at display resolution) and its text that were just taken
    /// of the window, e.g. by the look that ended a wait.
    private struct Fresh {
        let hires: CGImage
        let geometry: CaptureGeometry
        let recognized: [RecognizedText]
    }

    private func snapshot(_ args: Arguments, selected: DirectLockedWindow? = nil, message: String? = nil, fresh: Fresh? = nil) async throws -> ToolResult {
        try check()
        let captureGeneration = generation
        let app = try application(args)
        let pid = app.processIdentifier
        states[pid] = nil
        var windows = try await windows(of: app)
        let query = args.string("window")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var window = try choose(windows, query: query, selected: selected)
        let recognize = args.bool("ocr") ?? true
        let since = nonEmpty(args.string("since")?.trimmingCharacters(in: .whitespaces))
        // After an action, the window's latest look: if nothing changed, the
        // model already has the picture and its text.
        let latest = message != nil && since == nil ? history[pid]?.last : nil
        let base = since.flatMap { version in history[pid]?.last { $0.record.version == version } } ?? latest
        let reusing = fresh.flatMap { $0.geometry.rect == window.frame ? $0 : nil }
        let captured: Capture
        if let reusing {
            captured = try prepare(reusing.hires, reusing.geometry)
        } else {
            captured = try await capture(window)
        }
        let shot = captured.shot
        try check(generation: captureGeneration)
        if shot.geometry.rect != window.frame {
            // It moved between listing and capture (just opened, or placed
            // anew while the display woke): the capture, checked against the
            // window list before and after it, shows where it is now.
            windows = try await self.windows(of: app)
            guard let now = windows.first(where: { $0.id == window.id }), now.frame == shot.geometry.rect else {
                throw ToolError("The selected window changed before capture. Refresh get_app_state.")
            }
            window = now
        }
        // The same window at the same place with the same pixels reads the
        // same: the last recognition is reused instead of running again.
        let windowKey = "\(window.id)@\(window.frame.minX),\(window.frame.minY),\(window.frame.width),\(window.frame.height)"
        let fingerprint = PixelFingerprint(captured.hires, region: nil)
        let comparable = base?.record.window == windowKey
        let pixelsSame: Bool = {
            guard comparable, let then = base?.record.fingerprint, let now = fingerprint else { return false }
            return !now.changed(from: then)
        }()
        var recognized: [RecognizedText]?
        if recognize {
            if let reusing {
                recognized = reusing.recognized
            } else if pixelsSame, let reused = base?.recognized {
                recognized = reused
            } else {
                recognized = TextRecognition.sorted(try await TextRecognition.recognizeBoth(captured.hires, showing: shot.geometry.rect))
            }
            try check(generation: captureGeneration)
        }
        let state = State(app: app, executable: app.executableURL, launched: app.launchDate,
                          window: window, geometry: shot.geometry, captured: Date(), generation: captureGeneration,
                          recognized: recognized ?? [])
        if let problem = validationProblem(state) { throw ToolError("The target window changed while capturing it (\(problem)). Refresh get_app_state.") }
        var header = [message, "App: \(app.localizedName ?? "?") — \(app.bundleIdentifier ?? "") (pid \(pid))",
                      "Direct locked use: macOS remains locked. This is a live window screenshot; use x/y, press_key and type_text. AX element indices and foreground actions are unavailable.",
                      "Window: \(quote(window.title, limit: 100)) (id \(window.id))"].compactMap { $0 }
        let shotLine = "Screenshot: \(shot.geometry.pixelWidth)×\(shot.geometry.pixelHeight) px showing screen region x=\(window.frame.minX) y=\(window.frame.minY) w=\(window.frame.width) h=\(window.frame.height) pt. x/y arguments are pixels in this latest screenshot."
        if windows.count > 1 {
            header.append("Other windows (pass window title or id to get_app_state): " + windows.filter { $0.id != window.id }.map { "\($0.id): \($0.title)" }.joined(separator: "; "))
        }
        var textLines: [String] = []
        if let recognized {
            for text in recognized.prefix(200) {
                let middle = shot.geometry.toPixels(CGPoint(x: text.frame.midX, y: text.frame.midY))
                textLines.append("  \(quote(text.text, limit: 100)) x=\(Int(middle.x.rounded())) y=\(Int(middle.y.rounded()))")
            }
        }
        try check(generation: captureGeneration)
        guard valid(state) else { throw ToolError("The window changed while reading its screenshot. Refresh get_app_state.") }
        states[pid] = state
        shownWindows[pid] = window.id
        let version = StateVersions.next()
        let windowTitles = Dictionary(windows.map { (String($0.id), $0.title) }, uniquingKeysWith: { first, _ in first })
        let record = StateRecord(version: version, epoch: 0, window: windowKey, lines: textLines, textLines: textLines, windows: windowTitles, fingerprint: fingerprint)
        history[pid] = StateRecord.appending((record: record, recognized: recognized ?? []), to: history[pid])
        header.append("State: \(version)" + (since.map { " (compared with \($0))" } ?? "") + ". Pass since: \"\(version)\" next time to get only what changed.")

        let full = { (note: String?) -> ToolResult in
            var lines = header + [shotLine] + (note.map { [$0] } ?? [])
            if recognized != nil { lines += ["Text recognized in the screenshot (use x/y):"] + textLines }
            return ToolResult(text: lines.joined(separator: "\n"), image: shot.data, imageMimeType: shot.mimeType)
        }
        guard let since else {
            if let latest, comparable, pixelsSame, latest.record.windows == windowTitles {
                let lines = header + ["The window looks the same as in its latest screenshot (\(latest.record.version)), so none is attached and its text is not repeated; x/y of that screenshot still hold."]
                return ToolResult(text: lines.joined(separator: "\n"))
            }
            return full(nil)
        }
        guard let base else {
            return full("\(since) is not known for this window (only the last \(StateRecord.kept) looks are kept, and a lock change forgets them); the full state follows.")
        }
        guard comparable else { return full("Cannot compare with \(since): it showed another window, or this one moved or changed size; the full state follows.") }
        let diff = StateDiff.compare(old: base.record.lines, new: textLines, oldWindows: base.record.windows, newWindows: windowTitles)
        if pixelsSame, diff.isEmpty {
            let lines = header + ["Unchanged since \(since): the same window at the same place with the same pixels (and windows), so no screenshot is attached; x/y of its screenshot still hold."]
            return ToolResult(text: lines.joined(separator: "\n"))
        }
        if diff.isLarge(comparedTo: textLines.count) {
            return full("Most of the window changed since \(since) (\(diff.summary)); the full state follows.")
        }
        let lines = header + [pixelsSame ? "The pixels are the same as in \(since); no screenshot is attached, and its x/y still hold." : shotLine,
                              "Changes since \(since) in the recognized text: \(diff.summary)." + (pixelsSame ? "" : " x/y are pixels of the screenshot attached now; text not listed is unchanged.")]
            + diff.render()
        return ToolResult(text: lines.joined(separator: "\n"), image: pixelsSame ? nil : shot.data, imageMimeType: shot.mimeType)
    }

    // MARK: locating

    /// The window of the latest screenshot (or the one window_id or window
    /// names) captured and read again now, for resolving a target. This
    /// capture becomes the latest screenshot.
    func locateView(_ args: Arguments) async throws -> (ComputerUse.LocateView, pid_t) {
        try check()
        let app = try application(args)
        let pid = app.processIdentifier
        var query = (args.string("window_id") ?? args.string("window") ?? "").trimmingCharacters(in: .whitespaces)
        if query.isEmpty, let id = shownWindows[pid] {
            guard try await directLockedWindows(pid: pid).contains(where: { $0.id == id }) else {
                shownWindows[pid] = nil
                states[pid] = nil
                throw ToolError("The window of the latest screenshot (id \(id)) closed. Call get_app_state again; no input was sent.")
            }
            query = String(id)
        }
        var values = args.values
        values["window"] = query
        values["ocr"] = true
        let shot = try await snapshot(Arguments(values))
        guard let state = states[pid] else { throw ToolError("The window could not be read. Call get_app_state again; no input was sent.") }
        let items = state.recognized.map { text in
            ComputerUse.Located(candidate: LocatorCandidate(label: text.text, role: "text", frame: text.frame, roleKnown: false), element: nil,
                                pixel: state.geometry.toPixels(CGPoint(x: text.frame.midX, y: text.frame.midY)))
        }
        let geometry = state.geometry
        return (ComputerUse.LocateView(window: "\(quote(state.window.title, limit: 80)) (id \(state.window.id))", bounds: state.window.frame,
                                       items: ComputerUse.joiningText(items) { geometry.toPixels(CGPoint(x: $0.midX, y: $0.midY)) },
                                       geometry: geometry, recognized: true, screenshot: shot), pid)
    }

    // MARK: verification support

    /// The captured window an action will go to, and the recognized text at
    /// its x/y (what a click there is about), without sending anything.
    func actionTarget(_ args: Arguments, tool: String) -> (pid: pid_t, window: CGWindowID, signature: String, label: String?)? {
        guard let app = try? application(args), let state = states[app.processIdentifier], valid(state) else { return nil }
        var signature = "\(tool)|window \(state.window.id)"
        var label: String?
        if tool == "press_key" {
            signature += "|\(args.string("key")?.lowercased() ?? "")"
        } else if tool == "type_text" {
            signature += "|\(args.string("text") ?? "")"
        } else if let at = try? point(args, tool == "drag" ? "from_x" : "x", tool == "drag" ? "from_y" : "y", state: state) {
            // Within about a button's width, the same target.
            signature += "|\(Int((at.x / 12).rounded())),\(Int((at.y / 12).rounded()))"
            let nearest = state.recognized.min { a, b in
                hypot(a.frame.midX - at.x, a.frame.midY - at.y) < hypot(b.frame.midX - at.x, b.frame.midY - at.y)
            }
            if let nearest, nearest.frame.insetBy(dx: -12, dy: -10).contains(at) { label = nearest.text }
        }
        return (app.processIdentifier, state.window.id, signature, label)
    }

    /// One look at the app for verifying an action: its windows, and the
    /// target window's pixels and (when asked) recognized text. OCR is
    /// repeated only when the pixels changed since `previous`.
    func verificationObservation(pid: pid_t, window: CGWindowID, wantText: Bool,
                                 previous: (PixelFingerprint, String)?) async -> (VerifyObservation, (PixelFingerprint, String)?) {
        var observation = VerifyObservation(text: "", windows: [:], targetPresent: false)
        if ended { observation.interruption = "direct locked use ended"; return (observation, previous) }
        switch sessionLockState() {
        case .unlocked: observation.interruption = "macOS was unlocked, so the locked screenshot no longer applies"; return (observation, previous)
        case .unavailable: observation.interruption = "the lock state became unknown"; return (observation, previous)
        case .locked: break
        }
        guard NSRunningApplication(processIdentifier: pid)?.isTerminated == false else {
            observation.interruption = "the app quit"
            return (observation, previous)
        }
        guard let windows = try? await directLockedWindows(pid: pid) else { return (observation, previous) }
        observation.windows = Dictionary(windows.map { (String($0.id), $0.title) }, uniquingKeysWith: { a, _ in a })
        guard let target = windows.first(where: { $0.id == window }) else { return (observation, previous) }
        observation.targetPresent = true
        guard let (image, geometry) = try? await captureDirectLockedImage(target, maxScale: wantText ? backingScale(for: target.frame) : 1),
              let pixels = PixelFingerprint(image) else { return (observation, previous) }
        observation.pixels = pixels
        var cache = previous
        if wantText {
            if let previous, !pixels.changed(from: previous.0) {
                observation.text = previous.1
            } else if let lines = try? await TextRecognition.recognizeBoth(image, showing: geometry.rect) {
                observation.text = TextRecognition.sorted(lines).map(\.text).joined(separator: "\n")
                cache = (pixels, observation.text)
            }
        }
        return (observation, cache)
    }

    // MARK: zoom

    /// A part of the latest screenshot at the display's full resolution (or
    /// another factor), with how its pixels map back. Refused when the
    /// screenshot is too old or the window moved or changed size since.
    func zoom(_ args: Arguments) async throws -> ToolResult {
        try check()
        let app = try application(args)
        let pid = app.processIdentifier
        guard let state = states[pid] else {
            throw ToolError("There is no screenshot to zoom into. Call get_app_state first.")
        }
        let age = Date().timeIntervalSince(state.captured)
        guard age < Self.screenshotLifetime else {
            states[pid] = nil
            zooms[pid] = nil
            throw ToolError("The latest screenshot is \(Int(age)) s old, too old to zoom into or map coordinates from. Call get_app_state again.")
        }
        if let problem = validationProblem(state) {
            states[pid] = nil
            zooms[pid] = nil
            throw ToolError("The screenshot no longer matches the window (\(problem)). Call get_app_state again; its old coordinates are not used.")
        }
        let region = try zoomRegion(args, geometry: state.geometry)
        let backing = backingScale(for: state.window.frame)
        let native = backing / state.geometry.scale
        let factor = try ZoomMapping.factor(args, native: native, region: region)
        let (capture, captureGeometry) = try await captureDirectLockedImage(state.window, maxScale: backing)
        try check(generation: state.generation)
        guard captureGeometry.rect == state.geometry.rect else {
            states[pid] = nil
            zooms[pid] = nil
            throw ToolError("The window moved or was resized since the latest screenshot (it was \(state.geometry.rect), now \(captureGeometry.rect)). Call get_app_state again; its old coordinates are not used.")
        }
        guard let cut = cutZoom(from: capture, captureGeometry: captureGeometry, screenshot: state.geometry, region: region, factor: factor) else {
            throw ToolError("Could not cut that region from the window.")
        }
        zoomCount += 1
        let mapping = ZoomMapping(id: "z\(zoomCount)", region: cut.shown, zoomWidth: cut.image.width, zoomHeight: cut.image.height,
                                  screenshot: state.geometry, screenshotTaken: state.captured)
        zooms[pid] = mapping
        let shown = cut.shown
        var lines = mapping.lines(factor: factor, native: native, subject: " of window \(state.window.id)",
                                  lasting: "; valid while the latest screenshot is (about \(Int(Self.screenshotLifetime - age)) s more, same window position and size).")
        if args.bool("ocr") ?? true {
            let a = state.geometry.toScreen(x: shown.minX, y: shown.minY), b = state.geometry.toScreen(x: shown.maxX, y: shown.maxY)
            lines += try await mapping.recognizedText(in: cut.image, showing: CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y))
        }
        try check(generation: state.generation)
        return ToolResult(text: lines.joined(separator: "\n"), image: try encode(cut.image, format: "png"), imageMimeType: "image/png")
    }

    // MARK: wait_for

    /// Watches one window without sending anything: until a text shows up
    /// (or goes away) in the recognized text, or its pixels (optionally a
    /// region of the latest screenshot) stop changing. Stops at once, with
    /// the reason, when the lock state, the app process or the window changes.
    func waitFor(_ args: Arguments) async throws -> ToolResult {
        try check()
        let startGeneration = generation
        let app = try application(args)
        let pid = app.processIdentifier
        let executable = app.executableURL, launched = app.launchDate
        let timeout = try args.double("timeout") ?? 10
        guard timeout.isFinite, (0.5...60).contains(timeout) else { throw ToolError("timeout must be between 0.5 and 60 seconds.") }
        let stableFor = try args.double("stable_for") ?? 1
        guard stableFor.isFinite, (0.3...10).contains(stableFor) else { throw ToolError("stable_for must be between 0.3 and 10 seconds.") }
        let text = args.string("text")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gone = args.bool("gone") ?? false
        if gone, text.isEmpty { throw ToolError("gone needs a text to wait for the disappearance of.") }
        let query = args.string("window")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let previous = states[pid].flatMap { valid($0) ? $0 : nil }
        let window = try choose(try await windows(of: app), query: query, selected: query.isEmpty ? previous?.window : nil)

        // A region is given in pixels of the latest screenshot of this window.
        var region: CGRect?
        if args.values["region"] != nil {
            guard let previous, previous.window.id == window.id else {
                throw ToolError("region needs a current get_app_state screenshot of this window (its pixels define the region). Call get_app_state first.")
            }
            region = try pixelRegion(args, geometry: previous.geometry)
        }
        var lastPixels: PixelFingerprint?
        var lastText: String?
        var lastFresh: Fresh?
        var engine = WaitEngine(text: text.isEmpty ? nil : text, gone: gone, stableFor: stableFor, timeout: timeout)
        // Controlled screenshot differences: a small capture each look, more
        // seldom while nothing changes, and text recognized (on a full
        // resolution capture) only after the pixels changed.
        // SKFIY_WAIT_EVENTS=0 keeps the earlier fixed pace, with every look
        // at full resolution when waiting for a text (for comparison).
        let paced = ProcessInfo.processInfo.environment["SKFIY_WAIT_EVENTS"] != "0"
        engine.interval = paced || text.isEmpty ? 0.25 : 0.4
        // A text should be seen soon after it appears; stability is judged
        // at the end anyway, so stable waits may slow down more.
        engine.maxInterval = paced ? (text.isEmpty ? 1 : 0.6) : nil
        var looks = 0, recognitions = 0
        let clock = ContinuousClock()
        let origin = clock.now
        let result = await engine.run(
            now: { let d = clock.now - origin; return Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18 },
            sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
            check: { [self] in try self.waitCheck(startGeneration, pid: pid, executable: executable, launched: launched) },
            observe: { [self] in
                let current = try await directLockedWindows(pid: pid)
                guard let now = current.first(where: { $0.id == window.id }) else {
                    throw WaitStopped("the window closed.")
                }
                if region != nil, now.frame != window.frame {
                    throw WaitStopped("the window moved or was resized, so the region no longer covers the same content.")
                }
                looks += 1
                let image: CGImage, geometry: CaptureGeometry
                do {
                    (image, geometry) = try await captureDirectLockedImage(now, maxScale: paced || text.isEmpty ? 1 : backingScale(for: now.frame))
                } catch let error as ToolError {
                    // Say what happened to the window rather than how the capture
                    // failed. A closed window stays listed for up to about a second.
                    for attempt in 0..<6 {
                        if attempt > 0 { try await Task.sleep(nanoseconds: 250_000_000) }
                        if let after = try? await directLockedWindows(pid: pid), !after.contains(where: { $0.id == window.id }) {
                            throw WaitStopped("the window closed.")
                        }
                    }
                    throw WaitStopped("the window could not be captured (\(error.description))")
                }
                let pixelRegion = region.map { rect -> CGRect in
                    let scale = Double(geometry.pixelWidth) / Double(previous?.geometry.pixelWidth ?? geometry.pixelWidth)
                    return CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale)
                }
                let pixels = PixelFingerprint(image, region: pixelRegion)
                var observation = WaitObservation(fingerprint: pixels)
                if !text.isEmpty {
                    // Recognize again only when the pixels changed: controlled, not constant, OCR.
                    if let lastPixels, let pixels, !pixels.changed(from: lastPixels), let lastText {
                        observation.text = lastText
                    } else {
                        recognitions += 1
                        let full = paced ? (try? await captureDirectLockedImage(now, maxScale: backingScale(for: now.frame))) ?? (image, geometry) : (image, geometry)
                        let lines = try await TextRecognition.recognizeBoth(full.0, showing: geometry.rect)
                        if paced { lastFresh = Fresh(hires: full.0, geometry: full.1, recognized: TextRecognition.sorted(lines)) }
                        var inside = lines
                        if let region {
                            inside = lines.filter { self.regionContains($0.frame, region: region, geometry: previous!.geometry) }
                        }
                        observation.text = TextRecognition.sorted(inside).map(\.text).joined(separator: "\n")
                        lastText = observation.text
                    }
                }
                lastPixels = pixels
                return observation
            })
        if case .cancelled = result { throw CancellationError() }
        let outcome = engine.describe(result) + " (\(looks) look\(looks == 1 ? "" : "s")" + (text.isEmpty ? "" : ", text recognized \(recognitions) time\(recognitions == 1 ? "" : "s")") + ")"
        if case .stopped = result {
            states[pid] = nil
            throw ToolError(outcome + " Call get_app_state again before acting.")
        }
        // The look that found the text was just taken: it is the state now.
        let fresh: Fresh? = { if case .met = result, !text.isEmpty { return lastFresh } else { return nil } }()
        var state = try await snapshot(args, selected: window, message: outcome, fresh: fresh)
        if case .timedOut = result { state.isError = true }
        return state
    }

    private func waitCheck(_ expected: UInt64, pid: pid_t, executable: URL?, launched: Date?) throws {
        if EmergencyStop.isStopped { throw WaitStopped("emergency stop is on.") }
        if ended { throw WaitStopped("direct locked use ended for this MCP session.") }
        switch sessionLockState() {
        case .unlocked: throw WaitStopped("macOS was unlocked, so direct screenshots no longer apply (get_app_state now reads the accessibility tree).")
        case .unavailable: throw WaitStopped("the lock state became unknown (another session or the login window).")
        case .locked: break
        }
        if expected != generation { throw WaitStopped("the lock state changed (unlocked and locked again).") }
        guard let current = NSRunningApplication(processIdentifier: pid), !current.isTerminated,
              current.executableURL == executable, current.launchDate == launched else {
            throw WaitStopped("the app quit or was restarted.")
        }
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw WaitStopped("Accessibility or Screen Recording permission was withdrawn.")
        }
    }

    /// region [x, y, width, height] in pixels of the latest screenshot.
    private func pixelRegion(_ args: Arguments, geometry: CaptureGeometry) throws -> CGRect {
        let values = (args.values["region"] as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } ?? []
        guard values.count == 4, values.allSatisfy(\.isFinite) else {
            throw ToolError("region is [x, y, width, height] in pixels of the latest screenshot.")
        }
        let rect = CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
        try checkRegion(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height, in: geometry)
        return rect
    }

    private func regionContains(_ frame: CGRect, region: CGRect, geometry: CaptureGeometry) -> Bool {
        let middle = geometry.toPixels(CGPoint(x: frame.midX, y: frame.midY))
        return region.contains(middle)
    }

    func perform(_ name: String, _ args: Arguments) async throws -> ToolResult {
        try check()
        if name == "get_app_state" { return try await snapshot(args) }
        if name == "wait_for" { return try await waitFor(args) }
        if name == "zoom" { return try await zoom(args) }
        guard Self.lockedTools.contains(name) else {
            throw ToolError("\(name) is unavailable while macOS remains locked. Use get_app_state and screenshot coordinates with click, scroll, drag, press_key or type_text; unlock manually for AX or foreground actions.")
        }
        guard try args.elementIndex() == nil, args.bool("focus") != true else {
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
        case "type_text":
            let text = try args.requiredText("text")
            guard text.count <= 100_000 else { throw ToolError("Text is too long for one operation.") }
            let count = await Input.type(text, to: pid)
            guard count == text.count else { throw ToolError("Text input was interrupted after \(count) characters.") }
            message = "Sent \(count) characters to the app while macOS remained locked."
        default:
            throw ToolError("\(name) does not send input; nothing was sent.")
        }
        guard !Input.directLockedAborted else { states[pid] = nil; throw ToolError("Direct input stopped because the lock state or target window changed. Refresh get_app_state.") }
        try check(generation: state.generation)
        await Input.pause(settle)
        try check(generation: state.generation)
        // The input may close the window it went to (a dialog's Done): then
        // show what is left rather than failing an action that happened.
        if let current = try? await directLockedWindows(pid: pid), !current.contains(where: { $0.id == state.window.id }) {
            var rest = args.values
            rest["window"] = nil
            guard !current.isEmpty else {
                states[pid] = nil
                return ToolResult(text: message + " The window it went to closed, and the app has no other capturable window.")
            }
            return try await snapshot(Arguments(rest), message: message + " The window it went to closed; showing the app's remaining window.")
        }
        return try await snapshot(args, selected: state.window, message: message)
    }
}
