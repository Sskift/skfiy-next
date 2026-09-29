import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics

public enum MouseButton: String, Sendable {
    case left, right, middle
}

/// SkyLight (WindowServer) entry points resolved at runtime. All optional:
/// when a symbol is missing, delivery falls back to the public API.
enum SkyLight {
    typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    typealias SetWindowLocation = @convention(c) (CGEvent, Double, Double) -> Void
    typealias SetIntegerField = @convention(c) (CGEvent, UInt32, Int64) -> Void
    typealias PostEventRecord = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
    typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
    typealias AXGetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    typealias FrontProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
    typealias ProcessPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32

    private static let loaded: Bool = {
        dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY) != nil
    }()

    private static func symbol<T>(_ name: String, as type: T.Type) -> T? {
        _ = loaded
        guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
        return unsafeBitCast(pointer, to: type)
    }

    static let postToPid = symbol("SLEventPostToPid", as: PostToPid.self)
    static let setWindowLocation = symbol("CGEventSetWindowLocation", as: SetWindowLocation.self)
    static let setIntegerField = symbol("SLEventSetIntegerValueField", as: SetIntegerField.self)
    static let postEventRecord = symbol("SLPSPostEventRecordTo", as: PostEventRecord.self)
    static let processForPID = symbol("GetProcessForPID", as: ProcessForPID.self)
    static let axGetWindow = symbol("_AXUIElementGetWindow", as: AXGetWindow.self)
    static let frontProcess = symbol("_SLPSGetFrontProcess", as: FrontProcess.self)
    static let processPID = symbol("GetProcessPID", as: ProcessPID.self)

    /// The front app straight from the window server. Unlike the accessibility
    /// query it does not wait behind an accessibility call in flight.
    static func frontProcessID() -> pid_t? {
        guard let frontProcess, let processPID else { return nil }
        var psn = [UInt32](repeating: 0, count: 2)
        var pid: pid_t = 0
        let found = psn.withUnsafeMutableBytes { raw -> Bool in
            frontProcess(raw.baseAddress!) == 0 && processPID(raw.baseAddress!, &pid) == 0
        }
        return found && pid > 0 ? pid : nil
    }
}

/// Input delivered straight to one process: nothing is activated, raised, or
/// focused, the user's cursor never moves, and the user's own typing keeps
/// going to whatever app they are in.
@MainActor
enum Input {
    /// A private source, so the user's physically held modifiers never leak in.
    private static let keySource = CGEventSource(stateID: .privateState)
    private static let mouseSource = CGEventSource(stateID: .hidSystemState)

    static func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }

    // MARK: Keyboard

    private static func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, to pid: pid_t) {
        guard let event = CGEvent(keyboardEventSource: keySource, virtualKey: code, keyDown: down) else { return }
        event.flags = flags
        event.postToPid(pid)
    }

    /// Keys that carry the fn (and, for arrows, numeric-pad) flag on real keyboards.
    private static func intrinsicFlags(_ code: CGKeyCode) -> CGEventFlags {
        switch Int(code) {
        case kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow:
            return [.maskNumericPad, .maskSecondaryFn]
        case kVK_Home, kVK_End, kVK_PageUp, kVK_PageDown, kVK_ForwardDelete, kVK_Help,
             kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
             kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20:
            return [.maskSecondaryFn]
        default:
            return []
        }
    }

    static func press(_ chord: KeyChord, repeat count: Int = 1, to pid: pid_t) async {
        switch chord.key {
        case .character(let text):
            await type(String(repeating: text, count: max(1, count)), to: pid)
        case .code(let code):
            let flags = chord.modifiers.eventFlags.union(intrinsicFlags(code))
            for index in 0..<max(1, count) {
                postKey(code, down: true, flags: flags, to: pid)
                await pause(0.012)
                postKey(code, down: false, flags: flags, to: pid)
                if index < count - 1 {
                    await pause(0.02)
                }
            }
        }
    }

    /// Presses a chord as the keyboard does, for the frontmost app. Only
    /// run_in_front uses it, once the user approved and the app is in front.
    static func pressToFrontApp(_ chord: KeyChord) async {
        let source = CGEventSource(stateID: .hidSystemState)
        switch chord.key {
        case .code(let code):
            let flags = chord.modifiers.eventFlags.union(intrinsicFlags(code))
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
                event.flags = flags
                event.post(tap: .cghidEventTap)
                await pause(0.02)
            }
        case .character(let text):
            let units = Array(text.utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                event.flags = chord.modifiers.eventFlags
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event.post(tap: .cghidEventTap)
                await pause(0.02)
            }
        }
    }

    /// Holds a key down for `seconds` (games, press-and-hold controls): the app
    /// gets one key down and one key up, like a physical key held without
    /// auto-repeat. The emergency stop releases it early.
    static func hold(_ chord: KeyChord, seconds: Double, to pid: pid_t) async {
        let post: (Bool) -> Void
        switch chord.key {
        case .code(let code):
            let flags = chord.modifiers.eventFlags.union(intrinsicFlags(code))
            post = { down in postKey(code, down: down, flags: flags, to: pid) }
        case .character(let text):
            let units = Array(text.utf16)
            post = { down in
                guard let event = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: down) else { return }
                event.flags = chord.modifiers.eventFlags
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event.postToPid(pid)
            }
        }
        post(true)
        let until = Date().addingTimeInterval(seconds)
        while Date() < until, !EmergencyStop.isStopped {
            await pause(min(0.05, until.timeIntervalSinceNow))
        }
        post(false)
    }

    /// Types text as Unicode key events, one character per event (Chromium
    /// drops the tail of multi-character events). Newlines and tabs are real
    /// keys. Returns how many characters went out before the user's emergency
    /// stop, if they pressed it meanwhile.
    @discardableResult
    static func type(_ text: String, to pid: pid_t) async -> Int {
        var typed = 0
        for character in text {
            if EmergencyStop.isStopped { return typed }
            typed += 1
            switch character {
            case "\n", "\r", "\r\n":
                await press(KeyChord(key: .code(CGKeyCode(kVK_Return))), to: pid)
            case "\t":
                await press(KeyChord(key: .code(CGKeyCode(kVK_Tab))), to: pid)
            default:
                let units = Array(String(character).utf16)
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: down) else { continue }
                    event.flags = []
                    event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    event.postToPid(pid)
                }
                await pause(0.003)
            }
        }
        return typed
    }

    /// True when the active input source is an input method (e.g. Pinyin). It
    /// only intercepts keys delivered to the frontmost app.
    static func inputMethodActive() -> Bool {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else {
            return false
        }
        let type = Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
        return type != (kTISTypeKeyboardLayout as String)
    }

    // MARK: Mouse

    /// Stamps the window-routing fields a backgrounded window needs to accept a
    /// synthetic event, then posts it to the process: through SkyLight (which
    /// also reaches Chromium and Catalyst windows), or the public call when
    /// SkyLight is unavailable. Never both, which would double every click.
    private static func post(
        _ event: CGEvent,
        at point: CGPoint,
        pid: pid_t,
        windowID: CGWindowID,
        clickState: Int64,
        buttonNumber: Int64,
        subtype: Int64,
        group: Int64,
        eventNumber: Int64 = 0
    ) {
        let fields: [(UInt32, Int64)] = [
            (0, eventNumber), (1, clickState), (3, buttonNumber), (7, subtype), (40, Int64(pid)),
            (51, Int64(windowID)), (58, group), (91, Int64(windowID)), (92, Int64(windowID))
        ]
        SkyLight.setWindowLocation?(event, point.x, point.y)
        for (field, value) in fields {
            if let setIntegerField = SkyLight.setIntegerField {
                setIntegerField(event, field, value)
            } else if let field = CGEventField(rawValue: field) {
                event.setIntegerValueField(field, value: value)
            }
        }
        if let postToPid = SkyLight.postToPid {
            postToPid(pid, event)
        } else {
            event.postToPid(pid)
        }
    }

    private static func mouseEvent(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, _ flags: CGEventFlags) -> CGEvent? {
        let event = CGEvent(mouseEventSource: mouseSource, mouseType: type, mouseCursorPosition: point, mouseButton: button)
        event?.flags = flags
        return event
    }

    /// `chromium` adds the gesture Chromium needs before it accepts a synthetic
    /// click: an off-screen press/release (user-activation primer), then the
    /// target press/release sharing one mouse event number.
    static func click(at point: CGPoint, pid: pid_t, windowID: CGWindowID, button: MouseButton, count: Int, modifiers: Modifiers, chromium: Bool = false) async {
        let (downType, upType, cgButton, number): (CGEventType, CGEventType, CGMouseButton, Int64) = switch button {
        case .left: (.leftMouseDown, .leftMouseUp, .left, 0)
        case .right: (.rightMouseDown, .rightMouseUp, .right, 1)
        case .middle: (.otherMouseDown, .otherMouseUp, .center, 2)
        }
        let flags = modifiers.eventFlags
        let group = Int64.random(in: 1...Int64(Int32.max))
        // A leading move primes the window's cursor tracking; without it AppKit
        // controls ignore a synthetic down.
        if let move = mouseEvent(.mouseMoved, point, .left, flags) {
            post(move, at: point, pid: pid, windowID: windowID, clickState: 0, buttonNumber: 0, subtype: 3, group: group, eventNumber: 2)
        }
        await pause(0.015)
        if chromium {
            let offscreen = CGPoint(x: -1, y: -1)
            if let down = mouseEvent(.leftMouseDown, offscreen, .left, []) {
                post(down, at: offscreen, pid: pid, windowID: windowID, clickState: 1, buttonNumber: 0, subtype: 3, group: group, eventNumber: 1)
            }
            if let up = mouseEvent(.leftMouseUp, offscreen, .left, []) {
                post(up, at: offscreen, pid: pid, windowID: windowID, clickState: 1, buttonNumber: 0, subtype: 3, group: group, eventNumber: 2)
            }
            await pause(0.1)
        }
        for clickState in 1...Int64(max(1, count)) {
            let eventNumber = 2 + clickState
            if let down = mouseEvent(downType, point, cgButton, flags) {
                post(down, at: point, pid: pid, windowID: windowID, clickState: clickState, buttonNumber: number, subtype: 3, group: group, eventNumber: eventNumber)
            }
            // Controls run a tracking loop on mouse-down; give it time to poll.
            await pause(chromium ? 0.001 : 0.028)
            if let up = mouseEvent(upType, point, cgButton, flags) {
                post(up, at: point, pid: pid, windowID: windowID, clickState: clickState, buttonNumber: number, subtype: 3, group: group, eventNumber: eventNumber)
            }
            if clickState < count {
                await pause(0.08)
            }
        }
    }

    static func drag(from start: CGPoint, to end: CGPoint, pid: pid_t, windowID: CGWindowID) async {
        let group = Int64.random(in: 1...Int64(Int32.max))
        if let move = mouseEvent(.mouseMoved, start, .left, []) {
            post(move, at: start, pid: pid, windowID: windowID, clickState: 0, buttonNumber: 0, subtype: 0, group: group)
        }
        await pause(0.015)
        if let down = mouseEvent(.leftMouseDown, start, .left, []) {
            post(down, at: start, pid: pid, windowID: windowID, clickState: 1, buttonNumber: 0, subtype: 0, group: group)
        }
        await pause(0.08)
        let steps = 20
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
            if let dragged = mouseEvent(.leftMouseDragged, point, .left, []) {
                post(dragged, at: point, pid: pid, windowID: windowID, clickState: 1, buttonNumber: 0, subtype: 0, group: group)
            }
            await pause(0.012)
        }
        await pause(0.08)
        if let up = mouseEvent(.leftMouseUp, end, .left, []) {
            post(up, at: end, pid: pid, windowID: windowID, clickState: 1, buttonNumber: 0, subtype: 0, group: group)
        }
    }

    /// Scrolls by `dx`/`dy` points at `point`. Positive `dy` reveals content
    /// further down, positive `dx` content further right.
    static func scroll(at point: CGPoint, dx: Double, dy: Double, pid: pid_t, windowID: CGWindowID) async {
        let steps = max(1, Int((max(abs(dx), abs(dy)) / 60).rounded(.up)))
        let group = Int64.random(in: 1...Int64(Int32.max))
        for _ in 0..<steps {
            // Wheel deltas are the opposite sign: positive wheel1 scrolls up.
            guard let event = CGEvent(
                scrollWheelEvent2Source: mouseSource,
                units: .pixel,
                wheelCount: 2,
                wheel1: Int32((-dy / Double(steps)).rounded()),
                wheel2: Int32((-dx / Double(steps)).rounded()),
                wheel3: 0
            ) else { continue }
            event.location = point
            event.flags = []
            post(event, at: point, pid: pid, windowID: windowID, clickState: 0, buttonNumber: 0, subtype: 0, group: group)
            await pause(0.015)
        }
    }

    // MARK: Brief focus (opt-in)

    /// Seconds since the user last pressed a key or touched the mouse.
    static func userIdleSeconds() -> Double {
        let kinds: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel]
        return kinds
            .map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }
            .min() ?? .infinity
    }

    private static func focusRecord(_ windowID: CGWindowID, focus: Bool) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 0xF8)
        bytes[0x04] = 0xF8
        bytes[0x08] = 0x0D
        withUnsafeBytes(of: windowID.littleEndian) { raw in
            for index in 0..<4 { bytes[0x3C + index] = raw[index] }
        }
        bytes[0x8A] = focus ? 0x01 : 0x02
        return bytes
    }

    private static func psn(for pid: pid_t) -> [UInt8]? {
        var psn = [UInt8](repeating: 0, count: 8)
        guard let processForPID = SkyLight.processForPID, processForPID(pid, &psn) == 0 else { return nil }
        return psn
    }

    /// Makes `windowID` key inside its app without activating it or raising any
    /// window, runs `body`, then hands key focus back to the user's window.
    /// For pointer input nothing else can deliver (e.g. text views, canvases).
    static func withBriefFocus(pid: pid_t, windowID: CGWindowID, _ body: () async -> Void) async -> Bool {
        guard let postRecord = SkyLight.postEventRecord,
              let frontPID = frontmostProcessID(), frontPID != pid,
              let frontPSN = psn(for: frontPID), let targetPSN = psn(for: pid),
              let frontWindow = focusedWindowID(of: frontPID) else {
            return false
        }
        _ = postRecord(frontPSN, focusRecord(frontWindow, focus: false))
        _ = postRecord(targetPSN, focusRecord(windowID, focus: true))
        await pause(0.05)
        await body()
        await pause(0.05)
        _ = postRecord(targetPSN, focusRecord(windowID, focus: false))
        _ = postRecord(frontPSN, focusRecord(frontWindow, focus: true))
        return true
    }
}

/// The WindowServer id of a window element.
func windowID(of window: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    guard let getWindow = SkyLight.axGetWindow, getWindow(window, &id) == .success, id != 0 else { return nil }
    return id
}

func focusedWindowID(of pid: pid_t) -> CGWindowID? {
    AXUIElementCreateApplication(pid).element(kAXFocusedWindowAttribute).flatMap(windowID(of:))
}

/// A click or a modifier press (cmd-tab, a launcher hotkey) since `date`
/// means the user may have switched apps or windows themselves; typing does not.
func userMayHaveSwitched(since date: Date) -> Bool {
    let kinds: [CGEventType] = [.flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
    let idle = kinds.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    return idle < Date().timeIntervalSince(date)
}

/// Menus and panels of `pid` floating above normal windows.
func overlayWindows(of pid: pid_t) -> [CGWindowID] {
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
    return windows.compactMap { window in
        guard (window[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
              let layer = window[kCGWindowLayer as String] as? Int, layer > 0, layer < 1000,
              let number = window[kCGWindowNumber as String] as? Int else { return nil }
        return CGWindowID(number)
    }
}

/// The topmost normal window on screen, whoever owns it.
func topWindow() -> (id: CGWindowID, pid: pid_t)? {
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
    for window in windows {
        guard (window[kCGWindowLayer as String] as? Int) == 0,
              ((window[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01,
              let dictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary), bounds.width > 80, bounds.height > 80,
              let number = window[kCGWindowNumber as String] as? Int,
              let owner = window[kCGWindowOwnerPID as String] as? Int else {
            continue
        }
        return (CGWindowID(number), pid_t(owner))
    }
    return nil
}

/// The topmost on-screen window of `pid` containing `point` (menus included).
func windowID(of pid: pid_t, at point: CGPoint) -> CGWindowID? {
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
    for window in windows {
        guard (window[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
              let dictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary),
              bounds.contains(point),
              let number = window[kCGWindowNumber as String] as? Int else {
            continue
        }
        return CGWindowID(number)
    }
    return nil
}

/// Watches the front app on its own thread while a tool runs, so an app that
/// comes forward inside a blocking accessibility call is sent back at once
/// rather than when the call returns.
final class FrontGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var deadline = Date.distantFuture
    private var handBacks = 0
    private var taker: pid_t?
    private let userApp: pid_t
    private let target: pid_t?
    private let started = Date()

    /// `target` is the app being operated: it never gets to keep the front,
    /// since the user is not working in it.
    init(userApp: pid_t, target: pid_t?) {
        self.userApp = userApp
        self.target = target
        Thread.detachNewThread { [self] in
            while isActive {
                poll()
                usleep(20_000)
            }
        }
    }

    /// Reports the app that had to be sent back, if any, and keeps watching a
    /// little longer: some apps activate themselves well after the action.
    @discardableResult
    func stop(lingering seconds: TimeInterval = 0) -> pid_t? {
        lock.lock()
        defer { lock.unlock() }
        deadline = Date().addingTimeInterval(seconds)
        return taker
    }

    private var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return Date() < deadline
    }

    /// While run_in_front has the user's approval to bring an app forward,
    /// guards still lingering from earlier calls must not send it back.
    nonisolated(unsafe) private static var suspended = false
    private static let suspension = NSLock()

    static func suspendAll(_ value: Bool) {
        suspension.lock()
        suspended = value
        suspension.unlock()
    }

    private static var isSuspended: Bool {
        suspension.lock()
        defer { suspension.unlock() }
        return suspended
    }

    private func poll() {
        guard !Self.isSuspended else { return }
        guard let front = SkyLight.frontProcessID() ?? frontmostProcessID(), front != userApp else { return }
        // Another app may be the user's own choice; the target app never is.
        guard front == target || !userMayHaveSwitched(since: started),
              let app = NSRunningApplication(processIdentifier: userApp), !app.isTerminated else { return }
        lock.lock()
        let allowed = handBacks < 3  // never fight an app that keeps activating
        if allowed {
            handBacks += 1
            taker = front
        }
        lock.unlock()
        guard allowed else { return }
        _ = try? AXUIElementCreateApplication(userApp).set(kAXFrontmostAttribute, kCFBooleanTrue)
        app.activate(options: [])
    }
}
