import AppKit
import ApplicationServices

/// Visual and physical-input protection for an OS session temporarily unlocked
/// by the companion authorization mechanism. Its owner must live in a separate
/// guardian process and relock if the controlling process disappears.
@MainActor
public final class LockedScreenGuard {
    public enum Failure: LocalizedError {
        case noDisplays
        case inputProtectionUnavailable
        case displayProtectionUnavailable
        case notRelocked
        case interrupted

        public var errorDescription: String? {
            switch self {
            case .noDisplays: return "没有可保护的显示器。"
            case .inputProtectionUnavailable: return "无法建立物理输入保护，不能在锁屏下继续。"
            case .displayProtectionUnavailable: return "无法覆盖全部显示器，不能在锁屏下继续。"
            case .notRelocked: return "尚未确认系统重新锁屏，屏幕保护将保持显示。"
            case .interrupted: return "锁屏保护已中断，需要重新锁屏后建立新的会话。"
            }
        }
    }

    private var windows: [GuardWindow] = []
    private var eventTap: CFMachPort?
    private var eventSource: CFRunLoopSource?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var healthTimer: Timer?
    private var interruptionSent = false
    private let onInterruption: (String) -> Void
    private let tapContext = TapContext()
    private var coverInstalled = false
    /// Evaluate the protection again at every authorization decision. A stale
    /// successful cover() call cannot vouch for a tap that has since failed.
    public var isCovering: Bool {
        guard coverInstalled, !interruptionSent, let eventTap,
              CGEvent.tapIsEnabled(tap: eventTap), !windows.isEmpty,
              windows.allSatisfy(\.isVisible) else { return false }
        return displayCoversAreComplete
    }
    /// Kept separate from the live authorization check for teardown/watchdogs.
    public var hasCover: Bool { coverInstalled || !windows.isEmpty || eventTap != nil }
    public var displayCount: Int { windows.count }

    public init(onInterruption: @escaping (String) -> Void) {
        self.onInterruption = onInterruption
        tapContext.guardOwner = self
    }

    public func cover() throws {
        guard !interruptionSent else { throw Failure.interrupted }
        if isCovering { return }
        guard !hasCover else { throw Failure.interrupted }
        guard !NSScreen.screens.isEmpty else { throw Failure.noDisplays }
        // A single event from the physical HID stream is enough to revoke the
        // lease. Per-process automation uses postToPid and does not enter this
        // tap. No public CGEvent PID/user-data field is trusted as an exemption.
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                   .mouseMoved, .leftMouseDragged, .rightMouseDragged,
                                   .keyDown, .keyUp, .flagsChanged, .scrollWheel,
                                   .otherMouseDown, .otherMouseUp, .otherMouseDragged,
                                   CGEventType(rawValue: 14)!]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap,
                                         options: .defaultTap, eventsOfInterest: mask,
                                         callback: Self.handleEvent,
                                         userInfo: Unmanaged.passUnretained(tapContext).toOpaque()),
              let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            throw Failure.inputProtectionUnavailable
        }
        eventTap = tap
        eventSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else {
            invalidateTap()
            throw Failure.inputProtectionUnavailable
        }
        addMissingDisplayCovers()
        guard displayCoversAreComplete else {
            // Keep any successful covers and the input tap. The owner must
            // establish an OS lock before calling removeAfterRelock.
            coverInstalled = !windows.isEmpty
            diagnose("initial_display_cover_incomplete")
            throw Failure.displayProtectionUnavailable
        }
        coverInstalled = true
        diagnose("cover_installed")
        observe(NotificationCenter.default, NSApplication.didChangeScreenParametersNotification) { owner in
            let changed = !owner.appKitFramesMatchDisplays
            owner.addMissingDisplayCovers()
            owner.diagnose("screen_parameters_changed")
            // Menu bar/Dock availability can change at unlock without any
            // display changing. A real topology or frame change still revokes.
            if changed { owner.interrupt("display_configuration_changed") }
            else { owner.checkProtection() }
        }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.activeSpaceDidChangeNotification) { owner in
            owner.windows.forEach { $0.orderFrontRegardless() }
            // macOS itself changes Space when leaving loginwindow. An all-Space
            // shield remains valid across that transition; revoke on an actual
            // loss of coverage, not on the notification alone. Physical input
            // already revokes synchronously at the HID tap.
            owner.diagnose("active_space_changed")
            owner.checkProtection()
        }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.sessionDidResignActiveNotification) { owner in
            owner.interrupt("console_session_changed")
        }
        observe(NotificationCenter.default, NSWindow.didBecomeKeyNotification) { owner in
            // Our panels never become key. Background AX work may change the
            // target application's focus; that does not remove this shield.
            if owner.windows.contains(where: \.isKeyWindow) { owner.interrupt("guard_window_became_key") }
        }
        healthTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkProtection() }
        }
        if let healthTimer { RunLoop.main.add(healthTimer, forMode: .common) }
    }

    /// Call only after authorization is revoked and the OS reports locked.
    /// Unknown state is deliberately insufficient to remove the protection.
    public func removeAfterRelock() throws {
        guard LockScreenDriver.sessionLockState == true else { throw Failure.notRelocked }
        healthTimer?.invalidate()
        healthTimer = nil
        for (center, token) in observers { center.removeObserver(token) }
        observers.removeAll()
        for window in windows { window.orderOut(nil); window.close() }
        windows.removeAll()
        invalidateTap()
        coverInstalled = false
        interruptionSent = false
        diagnose("cover_removed_after_relock")
    }

    private func invalidateTap() {
        if let source = eventSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        eventSource = nil
        eventTap = nil
    }

    private func observe(_ center: NotificationCenter, _ name: Notification.Name,
                         callback: @escaping (LockedScreenGuard) -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if let self { callback(self) } }
        }
        observers.append((center, token))
    }

    private func addMissingDisplayCovers() {
        for screen in NSScreen.screens {
            guard let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { continue }
            if let window = windows.first(where: { $0.displayID == displayID }) {
                if window.frame != screen.frame { window.setFrame(screen.frame, display: true) }
                window.orderFrontRegardless()
                continue
            }
            let window = GuardWindow(contentRect: screen.frame,
                                     styleMask: [.borderless, .nonactivatingPanel],
                                     backing: .buffered, defer: false, screen: screen)
            window.displayID = displayID
            window.title = "Skfiy Locked Computer Use"
            window.backgroundColor = .black
            window.isOpaque = true
            window.hasShadow = false
            window.animationBehavior = .none
            window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()) + 1)
            window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
            window.hidesOnDeactivate = false
            window.isReleasedWhenClosed = false
            window.ignoresMouseEvents = false
            let content = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
            content.wantsLayer = true
            content.layer?.backgroundColor = NSColor.black.cgColor
            let title = NSTextField(labelWithString: "Skfiy 正在使用此 Mac")
            title.font = .systemFont(ofSize: 28, weight: .semibold)
            title.textColor = .white
            let subtitle = NSTextField(labelWithString: "按任意键或移动鼠标可停止操作并回到系统锁屏")
            subtitle.font = .systemFont(ofSize: 15)
            subtitle.textColor = .lightGray
            let stack = NSStackView(views: [title, subtitle])
            stack.orientation = .vertical
            stack.alignment = .centerX
            stack.spacing = 16
            stack.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(stack)
            NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
                                         stack.centerYAnchor.constraint(equalTo: content.centerYAnchor)])
            window.contentView = content
            window.setFrame(screen.frame, display: true)
            window.orderFrontRegardless()
            windows.append(window)
        }
    }

    private func checkProtection() {
        guard coverInstalled else { return }
        guard let tap = eventTap, CGEvent.tapIsEnabled(tap: tap) else {
            interrupt("physical_input_tap_disabled")
            return
        }
        guard LockScreenDriver.sessionLockState != nil else {
            interrupt("console_session_unknown")
            return
        }
        if !displayCoversAreComplete {
            diagnose("display_cover_lost")
            addMissingDisplayCovers()
            windows.forEach { $0.orderFrontRegardless() }
            interrupt("display_cover_lost")
        }
    }

    /// Validate the actual WindowServer rectangles as well as AppKit's frames.
    /// AppKit can still report an old frame during a screen/Space transition.
    private var appKitFramesMatchDisplays: Bool {
        let screens = NSScreen.screens
        return !screens.isEmpty && windows.count == screens.count && screens.allSatisfy { screen in
            guard let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { return false }
            return windows.contains { $0.displayID == displayID && $0.frame == screen.frame }
        }
    }

    private var displayCoversAreComplete: Bool {
        let screens = NSScreen.screens
        guard appKitFramesMatchDisplays,
              windows.allSatisfy(\.isVisible) else { return false }
        let rows = serverWindows()
        return screens.allSatisfy { screen in
            guard let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
                  let window = windows.first(where: { $0.displayID == displayID }),
                  window.frame == screen.frame,
                  let row = rows.first(where: { ($0[kCGWindowNumber as String] as? Int) == window.windowNumber }),
                  let dictionary = row[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dictionary),
                  (row[kCGWindowLayer as String] as? Int ?? 0) >= Int(CGShieldingWindowLevel()),
                  (row[kCGWindowAlpha as String] as? Double ?? 0) >= 0.99 else { return false }
            return bounds.insetBy(dx: -0.5, dy: -0.5).contains(CGDisplayBounds(displayID))
        }
    }

    private func serverWindows() -> [[String: Any]] {
        (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []).filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(getpid()) }
    }

    /// Geometry and state only: no application titles, pixels, or input data.
    private func diagnose(_ event: String) {
        let rows = serverWindows()
        let covers: [[String: Any]] = windows.map { window in
            let row = rows.first { ($0[kCGWindowNumber as String] as? Int) == window.windowNumber }
            return ["windowID": window.windowNumber, "displayID": window.displayID,
                    "frame": NSStringFromRect(window.frame), "visible": window.isVisible,
                    "serverBounds": row?[kCGWindowBounds as String] ?? NSNull(),
                    "displayBounds": NSStringFromRect(CGDisplayBounds(window.displayID))]
        }
        let value: [String: Any] = ["component": "screen_guard", "event": event, "pid": getpid(),
                                    "uptime": ProcessInfo.processInfo.systemUptime,
                                    "osLocked": LockScreenDriver.sessionLockState.map { $0 as Any } ?? NSNull(),
                                    "covers": covers]
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            try? FileHandle.standardError.write(contentsOf: data + Data([10]))
        }
    }

    private func interrupt(_ reason: String) {
        guard !interruptionSent else { return }
        interruptionSent = true
        diagnose(reason)
        onInterruption(reason)
    }

    private final class TapContext: @unchecked Sendable {
        weak var guardOwner: LockedScreenGuard?
    }

    nonisolated private static let handleEvent: CGEventTapCallBack = { _, type, _, userInfo in
        guard let userInfo else { return nil }
        let context = Unmanaged<TapContext>.fromOpaque(userInfo).takeUnretainedValue()
        let reason = (type == .tapDisabledByTimeout || type == .tapDisabledByUserInput)
            ? "physical_input_tap_disabled" : "physical_input_detected"
        // The source is installed only on CFRunLoopGetMain(). Re-enable a
        // disabled tap immediately while revocation/relocking runs, so queued
        // physical events cannot slip through a deliberately disabled tap.
        MainActor.assumeIsolated {
            if let owner = context.guardOwner {
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput,
                   let tap = owner.eventTap {
                    CGEvent.tapEnable(tap: tap, enable: true)
                }
                owner.interrupt(reason)
            }
        }
        // Swallow the triggering event as well as subsequent input while the
        // owner revokes authorization and re-establishes the actual OS lock.
        return nil
    }
}

@MainActor
private final class GuardWindow: NSPanel {
    var displayID: CGDirectDisplayID = 0
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    // The shield must include the menu bar and Dock. AppKit's default
    // constraining can move panels into the visibleFrame when loginwindow
    // hands the display back to the user's desktop.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}
