import AppKit
import ApplicationServices
import Darwin

/// The OS lock remains the authority. An overlay is never used as proof of a lock.
@MainActor
public enum LockScreenDriver {
    public enum Failure: LocalizedError {
        case unavailableSession
        case unavailableLockAPI
        case lockRequestFailed(Int32)
        case accessibilityUnavailable
        case loginWindowUnavailable
        case passwordFieldUnavailable
        case keyboardEventUnavailable
        case accessibilityActionFailed(String, AXError)
        case unlockDidNotComplete

        public var errorDescription: String? {
            switch self {
            case .unavailableSession: return "无法确认当前 macOS 登录会话。"
            case .unavailableLockAPI: return "当前 macOS 不提供可用的锁屏接口。"
            case .lockRequestFailed(let code): return "系统拒绝锁屏请求（\(code)）。"
            case .accessibilityUnavailable: return "锁屏守护进程尚未获得辅助功能权限。"
            case .loginWindowUnavailable: return "没有找到当前系统的 loginwindow 进程。"
            case .passwordFieldUnavailable: return "没有找到系统锁屏的密码输入框。"
            case .keyboardEventUnavailable: return "无法创建发送给系统锁屏的确认按键。"
            case .accessibilityActionFailed(let action, let error):
                return "系统锁屏操作 \(action) 失败（\(error.rawValue)）。"
            case .unlockDidNotComplete: return "本次已授权的系统解锁请求没有完成。"
            }
        }
    }

    /// `nil` means unknown and must not authorize either input or uncovering.
    public static var sessionLockState: Bool? {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool,
              let loggedIn = session["kCGSessionLoginDoneKey"] as? Bool,
              onConsole, loggedIn else { return nil }
        // WindowServer omits this key on some unlocked sessions.
        return session["CGSSessionScreenIsLocked"] as? Bool ?? false
    }

    public static var isLocked: Bool { sessionLockState == true }

    /// A locked WindowServer flag can arrive before loginwindow has drawn its
    /// authentication UI. Teardown waits for both this evidence and a short
    /// stable-lock interval, keeping the cover up through that transition.
    public static var lockUIIsVisible: Bool {
        guard isLocked, AXIsProcessTrusted(), let pid = loginWindowPID() else { return false }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        guard let field = findPasswordField(in: app) else { return false }
        var hidden: CFTypeRef?
        if AXUIElementCopyAttributeValue(field, "AXHidden" as CFString, &hidden) == .success,
           hidden as? Bool == true { return false }
        return isLocked
    }

    /// These checks request no permissions and issue no lock/input operation.
    public static var accessibilityAvailable: Bool { AXIsProcessTrusted() }
    public static var lockAPIAvailable: Bool {
        guard let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_NOW) else { return false }
        defer { dlclose(handle) }
        return dlsym(handle, "SACLockScreenImmediate") != nil
    }

    /// Request an actual OS lock without injecting a shortcut into an application.
    public static func requestLock() throws {
        guard sessionLockState != nil else { throw Failure.unavailableSession }
        if isLocked { return }
        guard let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_NOW),
              let symbol = dlsym(handle, "SACLockScreenImmediate") else {
            throw Failure.unavailableLockAPI
        }
        defer { dlclose(handle) }
        typealias LockFunction = @convention(c) () -> Int32
        let result = unsafeBitCast(symbol, to: LockFunction.self)()
        guard result == 0 else { throw Failure.lockRequestFailed(result) }
    }

    /// Submit an empty lock-screen authentication attempt. The independently
    /// installed authorization mechanism decides whether this attempt may pass.
    /// The caller must establish its guardian and short-lived approval first.
    /// This method never reads, stores, or types a password.
    public static func requestUnlockAttempt() async throws {
        guard let locked = sessionLockState else { throw Failure.unavailableSession }
        if !locked { return }
        guard AXIsProcessTrusted() else { throw Failure.accessibilityUnavailable }
        guard let pid = loginWindowPID() else { throw Failure.loginWindowUnavailable }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        var passwordField: AXUIElement?
        // The lock UI can settle after WindowServer reports a locked session.
        for _ in 0..<12 {
            try Task.checkCancellation()
            if !isLocked { return }
            passwordField = findPasswordField(in: app)
            if passwordField != nil { break }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        guard let passwordField else { throw Failure.passwordFieldUnavailable }
        let focusResult = AXUIElementSetAttributeValue(passwordField, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard focusResult == .success else {
            throw Failure.accessibilityActionFailed("focus", focusResult)
        }
        // Do not submit text the owner left in the field. Clear this single
        // known password control before sending Return to loginwindow only.
        let clearResult = AXUIElementSetAttributeValue(passwordField, kAXValueAttribute as CFString, "" as CFString)
        guard clearResult == .success else {
            throw Failure.accessibilityActionFailed("clear", clearResult)
        }
        try Task.checkCancellation()
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) else {
            throw Failure.keyboardEventUnavailable
        }
        down.postToPid(pid)
        up.postToPid(pid)
        for _ in 0..<30 {
            try Task.checkCancellation()
            guard let state = sessionLockState else { throw Failure.unavailableSession }
            if !state { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw Failure.unlockDidNotComplete
    }

    private static var cachedLoginWindowPID: pid_t?

    private static func loginWindowPID() -> pid_t? {
        if let cachedLoginWindowPID, kill(cachedLoginWindowPID, 0) == 0 || errno == EPERM {
            return cachedLoginWindowPID
        }
        // loginwindow has no regular NSRunningApplication entry on some macOS
        // releases. Query only process names; no UI or launch side effects.
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        task.arguments = ["-x", "loginwindow"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0,
              let text = String(data: data, encoding: .utf8) else { return nil }
        let pids = text.split(whereSeparator: \.isWhitespace).compactMap { pid_t($0) }
        // Ambiguous sessions must not send an authentication event elsewhere.
        let found = pids.count == 1 ? pids.first : nil
        cachedLoginWindowPID = found
        return found
    }

    private static func findPasswordField(in app: AXUIElement) -> AXUIElement? {
        var queue = [app]
        var index = 0
        while index < queue.count, index < 1_024 {
            let element = queue[index]
            index += 1
            var identifier: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &identifier) == .success,
               identifier as? String == "UserPasswordTextField" {
                return element
            }
            var children: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
               let values = children as? [AXUIElement] {
                queue.append(contentsOf: values.prefix(max(0, 1_024 - queue.count)))
            }
        }
        return nil
    }
}
