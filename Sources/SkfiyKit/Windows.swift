import AppKit
import ApplicationServices
import CoreGraphics

/// A window's top-left corner in screen points, for the few events a call
/// posts (cheap enough to look up per event).
func windowOrigin(_ windowID: CGWindowID) -> CGPoint {
    guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
          let dictionary = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: dictionary) else {
        return .zero
    }
    return bounds.origin
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

/// A key, modifier or click in the last `seconds`: an app that came forward
/// right then was most likely brought there by the user (cmd-tab, Spotlight,
/// a launcher, the Dock), not by a tool that sends no input.
func userActed(within seconds: TimeInterval) -> Bool {
    let kinds: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
    let idle = kinds.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? .infinity
    return idle < seconds
}

/// A mouse click since `date` with the pointer now on a window of `pid`:
/// the user clicked into that app themselves.
func userClicked(into pid: pid_t, since date: Date) -> Bool {
    let kinds: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    let idle = kinds.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? .infinity
    guard idle < Date().timeIntervalSince(date), let mouse = CGEvent(source: nil)?.location else { return false }
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for window in windows {
        guard ((window[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01,
              let dictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary), bounds.contains(mouse),
              let owner = (window[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) else { continue }
        if owner == pid { return true }
        // Overlays (the Dock's full-display canvas, menus) are looked through.
        if (window[kCGWindowLayer as String] as? Int ?? 0) == 0 { return false }
    }
    return false
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
    /// The user brought the target forward themselves during a tool that
    /// sends no input; it stays where they put it.
    private var userTookTarget = false

    private let onlyTarget: Bool

    /// `target` is the app being operated: it never gets to keep the front,
    /// since the user is not working in it. With `onlyTarget` (a tool that
    /// sends no input, so nothing it does activates another app) any other
    /// app coming forward is the user's doing, and is left there.
    init(userApp: pid_t, target: pid_t?, onlyTarget: Bool = false) {
        self.userApp = userApp
        self.target = target
        self.onlyTarget = onlyTarget
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

    private func poll() {
        guard !isScreenLocked(), !EmergencyStop.isStopped else { return }
        guard let front = SkyLight.frontProcessID() ?? frontmostProcessID(), front != userApp,
              front != FrontGrant.granted() else { return }
        // Another app may be the user's own choice. The target app is not,
        // since skfiy acts on it, unless the user clicked into it during a
        // tool that sends no input (they were working in it: RustDesk).
        if front == target, onlyTarget, !userTookTarget,
           userClicked(into: front, since: started) || userActed(within: 0.6) {
            userTookTarget = true
        }
        let restore = front == target ? !(onlyTarget && userTookTarget)
                                      : !onlyTarget && !userMayHaveSwitched(since: started)
        guard restore,
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
        guard !isScreenLocked(), !EmergencyStop.isStopped else { return }
        app.activate(options: [])
    }
}

/// An app run_in_front may keep in front, with the user's approval. It is a
/// file, so guards of every skfiy process (other sessions included) leave that
/// app alone instead of sending it straight back.
enum FrontGrant {
    static var file: URL {
        if let path = ProcessInfo.processInfo.environment["SKFIY_FRONT_GRANT_FILE"] {
            return URL(fileURLWithPath: path)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/skfiy/front-grant")
    }

    static func grant(_ pid: pid_t, seconds: Double) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? "\(pid) \(Date().timeIntervalSince1970 + seconds)".write(to: file, atomically: true, encoding: .utf8)
    }

    static func revoke() {
        try? FileManager.default.removeItem(at: file)
    }

    /// The granted app, while the grant lasts.
    static func granted() -> pid_t? {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        let fields = text.split(separator: " ")
        guard fields.count == 2, let pid = pid_t(fields[0]), let until = Double(fields[1]),
              Date().timeIntervalSince1970 < until else { return nil }
        return pid
    }
}
