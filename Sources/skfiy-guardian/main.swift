import AppKit
import ApplicationServices
import Foundation
import IOKit.pwr_mgt
import LocalAuthentication
import LockedUseCore

func reply(_ line: String) {
    try? FileHandle.standardOutput.write(contentsOf: Data((line + "\n").utf8))
}

func consoleIsOurs() -> Bool {
    var uid: UInt32 = 0
    return skfiy_console_user(&uid) && uid == getuid()
}

func readCommands(_ receive: @escaping @MainActor (String?) -> Void) {
    Thread {
        var line = [UInt8]()
        var byte: UInt8 = 0
        while read(STDIN_FILENO, &byte, 1) == 1 {
            if byte == 10 {
                let command = String(decoding: line, as: UTF8.self)
                line.removeAll(keepingCapacity: true)
                Task { @MainActor in receive(command) }
            } else {
                line.append(byte)
                if line.count > 64 { break }
            }
        }
        Task { @MainActor in receive(nil) }
    }.start()
}

/// The same protection runs in two independent processes. The watchdog has no
/// authorization socket and can only cover/relock. SIGKILL or a wedged AX call
/// in the broker cannot leave an unattended, uncovered desktop indefinitely.
@MainActor
final class ScreenProtection {
    var onInterruption: ((String) -> Void)?
    private(set) var active = false
    private var windows: [NSWindow] = []
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    var allowAgentInput = true
    private var displays: NSObjectProtocol?
    private let allowedPID: pid_t

    init(allowedPID: pid_t) { self.allowedPID = allowedPID }

    func installInputMonitor() throws {
        let kinds: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
        let mask = kinds.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard let monitor = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
                guard let pointer else { return Unmanaged.passUnretained(event) }
                return MainActor.assumeIsolated {
                    let owner = Unmanaged<ScreenProtection>.fromOpaque(pointer).takeUnretainedValue()
                    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                        if owner.active { owner.onInterruption?("Input protection was disabled.") }
                        if let tap = owner.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                        return Unmanaged.passUnretained(event)
                    }
                    guard owner.active else { return Unmanaged.passUnretained(event) }
                    let sourcePID = pid_t(event.getIntegerValueField(.eventSourceUnixProcessID))
                    if sourcePID == owner.allowedPID {
                        return owner.allowAgentInput ? Unmanaged.passUnretained(event) : nil
                    }
                    owner.allowAgentInput = false
                    owner.onInterruption?("Local input detected; manual unlock and a new grant are required.")
                    return nil // Swallow the triggering event, including its key-up.
                }
            }, userInfo: context) else {
            throw GuardianError("Grant Accessibility to Skfiy Locked Use in System Settings, then restart the MCP server.")
        }
        tap = monitor
        source = CFMachPortCreateRunLoopSource(nil, monitor, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: monitor, enable: true)
        displays = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.active else { return }
                    self.onInterruption?("Display configuration changed.")
                    self.coverScreens() // Also cover a newly attached display while relocking.
                }
            }
    }

    func cover() throws {
        guard let tap, CGEvent.tapIsEnabled(tap: tap), !NSScreen.screens.isEmpty else {
            throw GuardianError("Display/input protection is unavailable.")
        }
        active = true
        allowAgentInput = true
        coverScreens()
        guard windows.count == NSScreen.screens.count, windows.allSatisfy(\.isVisible) else {
            throw GuardianError("Could not cover every display.")
        }
    }

    private func coverScreens() {
        let previous = windows
        windows = NSScreen.screens.map { screen in
            let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.backgroundColor = .black
            window.isOpaque = true
            window.hasShadow = false
            window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)) + 1)
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            window.sharingType = .none
            window.canBecomeVisibleWithoutLogin = true
            window.isReleasedWhenClosed = false
            let label = NSTextField(labelWithString: "skfiy is working\nTouch the keyboard or mouse to stop and lock.")
            label.textColor = .white
            label.alignment = .center
            label.frame = CGRect(x: 20, y: screen.frame.height / 2 - 30, width: screen.frame.width - 40, height: 60)
            window.contentView?.addSubview(label)
            window.orderFrontRegardless()
            window.displayIfNeeded()
            return window
        }
        previous.forEach { $0.orderOut(nil) }
    }

    func removeAfterConfirmedLock() -> Bool {
        guard skfiy_screen_confirmed_locked() else { return false }
        windows.forEach { $0.orderOut(nil) }
        windows.removeAll()
        active = false
        return true
    }
}

struct GuardianError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

final class Authority: @unchecked Sendable {
    private var lease = SkfiyLockedLease()
    private let lock = NSLock()
    func access<T>(_ body: (inout SkfiyLockedLease) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&lease)
    }
}

@MainActor
final class Watchdog {
    let protection: ScreenProtection
    private var lastHeartbeat = skfiy_monotonic_time()
    private var stopping = false
    private var drainUntil = 0.0
    private var timer: Timer?
    init(allowedPID: pid_t) { protection = ScreenProtection(allowedPID: allowedPID) }
    func start() throws {
        try protection.installInputMonitor()
        protection.onInterruption = { [weak self] reason in self?.stop(reason) }
        readCommands { [weak self] command in self?.command(command) }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if skfiy_monotonic_time() - self.lastHeartbeat >= 3 { self.stop("Guardian heartbeat expired.") }
                if self.stopping { self.finishStop() }
            }
        }
        reply("WATCHDOG")
    }
    private func command(_ command: String?) {
        guard !stopping else { return }
        switch command {
        case "PING": lastHeartbeat = skfiy_monotonic_time()
        case "COVER":
            do { try protection.cover(); reply("COVERED") }
            catch { stop("\(error)") }
        case "RELEASE":
            guard protection.removeAfterConfirmedLock() else { stop("Relock was not confirmed."); return }
            reply("RELEASED")
        default: stop("Guardian disconnected or sent an invalid command.")
        }
    }
    private func stop(_ reason: String) {
        guard !stopping else { return }
        stopping = true
        protection.allowAgentInput = false
        drainUntil = skfiy_monotonic_time() + 5
        reply("ERROR \(reason)")
        finishStop()
    }
    private func finishStop() {
        guard protection.active else { exit(0) }
        if skfiy_monotonic_time() < drainUntil { _ = skfiy_lock_screen(); return }
        if protection.removeAfterConfirmedLock() { exit(0) }
        _ = skfiy_lock_screen() // Keep covers and retry if the OS has not locked yet.
    }
}

@MainActor
final class Guardian {
    private let authority = Authority()
    private let protection = ScreenProtection(allowedPID: getppid())
    private var listener: Int32 = -1
    private var socketSource: DispatchSourceRead?
    private var timer: Timer?
    private var watchdog: Process?
    private var watchdogInput: FileHandle?
    private var watchdogReply: CheckedContinuation<String, Error>?
    private var watchdogGeneration = UUID()
    private var stopping = false
    private var drainUntil = 0.0
    private var busy = false
    private var protectedCall = false
    private var assertion: IOPMAssertionID = 0
    private var displayAssertion: IOPMAssertionID = 0
    private var wakeAssertion: IOPMAssertionID = 0
    private var signals: [DispatchSourceSignal] = []

    func start() async throws {
        guard consoleIsOurs(), !skfiy_screen_locked(), skfiy_can_lock_screen(), skfiy_guardian_installed() else {
            throw GuardianError("Start locked use from your unlocked local Mac with the installed, signed helper.")
        }
        guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else {
            throw GuardianError("Grant Accessibility to Skfiy Locked Use, then restart skfiy mcp --locked-use.")
        }
        NSApp.activate(ignoringOtherApps: true)
        let prompt = NSAlert()
        prompt.messageText = "Allow this skfiy agent to work after you lock your Mac?"
        prompt.informativeText = "Experimental: for up to one hour, this MCP process can temporarily unlock this Mac for desktop tools. Displays will be covered. Local input, disconnect, or expiry revokes the grant and locks the Mac. No login password is stored. Validate on a test Mac before using personal data."
        prompt.addButton(withTitle: "Cancel")
        prompt.addButton(withTitle: "Allow for one hour")
        guard prompt.runModal() == .alertSecondButtonReturn else { throw GuardianError("Local approval declined.") }
        let context = LAContext()
        let approved = await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Authorize one skfiy locked-use session") { ok, _ in
                continuation.resume(returning: ok)
            }
        }
        guard consoleIsOurs(), authority.access({ skfiy_lease_arm(&$0, getuid(), skfiy_monotonic_time(), 3600,
                                                                  !skfiy_screen_locked(), approved) }) else {
            throw GuardianError("Local authentication failed or the desktop session changed.")
        }
        try protection.installInputMonitor()
        protection.onInterruption = { [weak self] reason in self?.stop(reason) }
        listener = skfiy_authorization_listen(getuid())
        guard listener >= 0 else { throw GuardianError("Locked-use socket is unavailable; install for this user, or stop the existing locked-use session.") }
        let fd = listener, state = authority, uid = getuid()
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "skfiy.authorization"))
        source.setEventHandler {
            let client = skfiy_authorization_accept(fd)
            guard client >= 0 else { return }
            var current: UInt32 = 0
            let pending = skfiy_console_user(&current) && current == uid &&
                state.access { skfiy_lease_pending(&$0, uid, skfiy_monotonic_time()) }
            let ready = skfiy_authorization_ready(client, pending)
            let allow = ready && skfiy_console_user(&current) && current == uid &&
                state.access { skfiy_lease_authorize(&$0, uid, skfiy_monotonic_time()) }
            skfiy_authorization_reply(client, allow)
        }
        source.resume()
        socketSource = source
        try await startWatchdog()
        // Start the lease clock after setup, so the startup dialog/watchdog
        // cannot accidentally use up its initial heartbeat budget.
        guard authority.access({ skfiy_lease_arm(&$0, getuid(), skfiy_monotonic_time(), 3600, !skfiy_screen_locked(), approved) }) else {
            throw GuardianError("The Mac locked during setup; approve again while unlocked.")
        }
        let power = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn), "skfiy locked-use session" as CFString, &assertion)
        guard power == kIOReturnSuccess else { throw GuardianError("Could not keep the host awake.") }
        readCommands { [weak self] command in self?.command(command) }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.stop("Guardian was stopped.") } }
            source.resume()
            signals.append(source)
        }
        reply("ARMED")
    }

    private func command(_ command: String?) {
        guard !stopping else { return }
        if command == "PING" {
            authority.access { skfiy_lease_heartbeat(&$0, skfiy_monotonic_time()) }
            return
        }
        guard !busy else { stop("Overlapping locked-use commands."); return }
        busy = true
        Task { @MainActor in
            defer { self.busy = false }
            do {
                switch command {
                case "BEGIN": try await self.begin()
                case "END": try await self.end()
                default: throw GuardianError("MCP process disconnected or sent an invalid command.")
                }
            } catch { self.stop("\(error)") }
        }
    }

    private func tick() {
        if stopping { finishStop(); return }
        watchdogSend("PING")
        guard consoleIsOurs(), authority.access({ skfiy_lease_valid(&$0, skfiy_monotonic_time()) }) else {
            stop("Approval expired, MCP heartbeat stopped, or the console user changed."); return
        }
        if authority.access({ $0.active }), !protectedCall, skfiy_screen_locked() {
            stop("The Mac locked during an action; it may be partial. Unlock manually before retrying.")
        }
    }

    private func begin() async throws {
        guard authority.access({ skfiy_lease_begin(&$0, skfiy_monotonic_time()) }) else {
            throw GuardianError("No current locked-use grant, or a desktop call is already active.")
        }
        guard skfiy_screen_locked() else { reply("READY"); return }
        protectedCall = true // Set before any await so a lock cannot be mistaken for an interruption.
        try protection.cover()
        guard try await watchdogRequest("COVER") == "COVERED" else { throw GuardianError("Watchdog did not cover every display.") }
        guard IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn), "skfiy protected desktop call" as CFString,
            &displayAssertion) == kIOReturnSuccess else { throw GuardianError("Could not keep the display available.") }
        guard IOPMAssertionDeclareUserActivity("skfiy protected desktop call" as CFString,
            kIOPMUserActiveLocal, &wakeAssertion) == kIOReturnSuccess else { throw GuardianError("Could not wake the locked display.") }
        let unlockField = try findUnlockField()
        try ensureLive()
        guard authority.access({ skfiy_lease_prepare_unlock(&$0, skfiy_monotonic_time(), true, true) }) else {
            throw GuardianError("Unlock permit could not be issued.")
        }
        guard AXUIElementPerformAction(unlockField, kAXConfirmAction as CFString) == .success else {
            throw GuardianError("The system rejected the unlock request.")
        }
        let deadline = skfiy_monotonic_time() + 4
        while skfiy_screen_locked(), skfiy_monotonic_time() < deadline {
            try ensureLive()
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try ensureLive()
        guard !skfiy_screen_locked(), authority.access({ $0.consumed }) else {
            throw GuardianError("Automatic unlock was not verified. No app input was sent; unlock manually. There is no password or keystroke fallback.")
        }
        reply("READY_LOCKED")
    }

    private func end() async throws {
        try ensureLive()
        guard authority.access({ $0.active }) else { throw GuardianError("No active desktop call.") }
        // Revoke the authorization window before attempting to relock.
        authority.access { skfiy_lease_end(&$0) }
        if protectedCall {
            _ = skfiy_lock_screen()
            let deadline = skfiy_monotonic_time() + 5
            while !skfiy_screen_confirmed_locked(), skfiy_monotonic_time() < deadline {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            guard skfiy_screen_confirmed_locked() else { throw GuardianError("Relock did not complete; display covers will stay in place.") }
            guard try await watchdogRequest("RELEASE") == "RELEASED",
                  protection.removeAfterConfirmedLock() else { throw GuardianError("Could not verify protected cleanup.") }
            protectedCall = false
            releaseDisplayAssertions()
        }
        reply("DONE")
    }

    private func ensureLive() throws {
        guard !stopping, consoleIsOurs(), authority.access({ skfiy_lease_valid(&$0, skfiy_monotonic_time()) }) else {
            throw GuardianError("Locked-use grant was revoked.")
        }
    }

    /// Request only the empty lock-screen field's advertised Confirm action.
    /// No typing, password collection, coordinate guessing or action retries.
    /// A macOS version that does not expose this action fails closed.
    private func findUnlockField() throws -> AXUIElement {
        guard let login = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.loginwindow" && skfiy_is_loginwindow($0.processIdentifier)
        }) else { throw GuardianError("Could not identify the signed loginwindow process.") }
        let root = AXUIElementCreateApplication(login.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.2)
        var queue = [root], candidates: [AXUIElement] = [], visited = 0
        func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
            return value
        }
        while !queue.isEmpty, visited < 100 {
            try ensureLive()
            let element = queue.removeFirst()
            visited += 1
            if attribute(element, kAXRoleAttribute) as? String == kAXTextFieldRole,
               attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole {
                // Require a known-empty field. Do not submit somebody's partially typed password.
                if let text = attribute(element, kAXValueAttribute) as? String, text.isEmpty { candidates.append(element) }
            }
            queue.append(contentsOf: (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(100 - visited))
        }
        guard candidates.count == 1 else { throw GuardianError("No unique empty unlock field; manual unlock is required.") }
        var actions: CFArray?
        guard AXUIElementCopyActionNames(candidates[0], &actions) == .success,
              (actions as? [String])?.contains(kAXConfirmAction) == true else {
            throw GuardianError("This macOS lock screen does not expose a supported unlock action.")
        }
        try ensureLive()
        return candidates[0]
    }

    private func startWatchdog() async throws {
        let task = Process(), input = Pipe(), output = Pipe()
        task.executableURL = URL(fileURLWithPath: SKFIY_GUARDIAN)
        task.arguments = ["--watchdog", String(getppid())]
        task.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        task.standardInput = input
        task.standardOutput = output
        task.standardError = FileHandle.standardError
        watchdog = task
        watchdogInput = input.fileHandleForWriting
        try task.run()
        input.fileHandleForReading.closeFile()
        output.fileHandleForWriting.closeFile()
        let handle = output.fileHandleForReading
        Thread {
            var line = [UInt8](), byte: UInt8 = 0
            while read(handle.fileDescriptor, &byte, 1) == 1 {
                if byte == 10 {
                    let text = String(decoding: line, as: UTF8.self)
                    line.removeAll(keepingCapacity: true)
                    Task { @MainActor in self.watchdogReceived(text) }
                } else { line.append(byte); if line.count > 1024 { break } }
            }
            handle.closeFile()
            Task { @MainActor in self.stop("Independent watchdog disconnected.") }
        }.start()
        guard try await watchdogRequest(nil) == "WATCHDOG" else { throw GuardianError("Could not start watchdog.") }
    }

    private func watchdogRequest(_ command: String?) async throws -> String {
        guard watchdogReply == nil, !stopping else { throw GuardianError("Watchdog is unavailable.") }
        let generation = UUID()
        watchdogGeneration = generation
        return try await withCheckedThrowingContinuation { continuation in
            watchdogReply = continuation
            if let command { watchdogSend(command) }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if self.watchdogGeneration == generation, self.watchdogReply != nil {
                    self.stop("Independent watchdog timed out.")
                }
            }
        }
    }

    private func watchdogSend(_ line: String) {
        do { try watchdogInput?.write(contentsOf: Data((line + "\n").utf8)) }
        catch { stop("Could not contact watchdog.") }
    }

    private func watchdogReceived(_ text: String) {
        if text.hasPrefix("ERROR ") { stop(String(text.dropFirst(6))); return }
        let waiting = watchdogReply
        watchdogReply = nil
        waiting?.resume(returning: text)
    }

    func stop(_ reason: String) {
        guard !stopping else { return }
        stopping = true
        protection.allowAgentInput = false
        drainUntil = skfiy_monotonic_time() + 5
        authority.access { skfiy_lease_revoke(&$0) }
        reply("ERROR \(reason)")
        let waiting = watchdogReply
        watchdogReply = nil
        waiting?.resume(throwing: GuardianError(reason))
        try? watchdogInput?.close()
        watchdogInput = nil
        finishStop()
    }

    private func finishStop() {
        if protection.active {
            if skfiy_monotonic_time() < drainUntil { _ = skfiy_lock_screen(); return }
            guard protection.removeAfterConfirmedLock() else { _ = skfiy_lock_screen(); return }
        }
        socketSource?.cancel()
        skfiy_authorization_close(listener, getuid())
        if assertion != 0 { IOPMAssertionRelease(assertion) }
        releaseDisplayAssertions()
        exit(0)
    }

    private func releaseDisplayAssertions() {
        if displayAssertion != 0 { IOPMAssertionRelease(displayAssertion); displayAssertion = 0 }
        if wakeAssertion != 0 { IOPMAssertionRelease(wakeAssertion); wakeAssertion = 0 }
    }
}

signal(SIGPIPE, SIG_IGN)
NSApplication.shared.setActivationPolicy(.accessory)
var guardian: Guardian?
var watchdog: Watchdog?
Task { @MainActor in
    do {
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--watchdog",
           let pid = pid_t(CommandLine.arguments[2]), pid > 1 {
            let instance = Watchdog(allowedPID: pid)
            watchdog = instance
            try instance.start()
        } else if CommandLine.arguments.count == 1 {
            let instance = Guardian()
            guardian = instance
            do { try await instance.start() } catch { instance.stop("\(error)") }
        } else { throw GuardianError("Invalid guardian invocation.") }
    } catch { reply("ERROR \(error)"); exit(1) }
}
NSApplication.shared.run()
