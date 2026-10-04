import AppKit
import Foundation
import LockedUseKit
import LockedUseSupport

func clockNow() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
}
func diagnostic(_ event: String, _ details: [String: Any] = [:]) {
    var value = details
    value["event"] = event
    value["uptime"] = clockNow()
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    try? FileHandle.standardError.write(contentsOf: Data("skfiy-locked-use ".utf8) + data + Data([10]))
}
func fatal(_ message: String) -> Never { emit(["fatal": message]); exit(1) }

/// A second process never authorizes unlocks. It watches the process that
/// owns the display shields and locks immediately on pipe loss/stalled pulses.
final class WatchdogLink: @unchecked Sendable {
    private let condition = NSCondition()
    private var responses: [[String: Any]] = []
    private var failure: String?
    var error: String? { condition.lock(); defer { condition.unlock() }; return failure }
    init(_ reader: FileHandle) {
        Thread.detachNewThread { [self] in
            var buffer = Data()
            while true {
                let chunk = reader.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                    guard let reply = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    condition.lock()
                    if reply["event"] as? String == "interrupted" {
                        failure = reply["reason"] as? String ?? "The independent guard was interrupted."
                    }
                    responses.append(reply)
                    condition.broadcast(); condition.unlock()
                }
                if buffer.count > 65536 { break }
            }
            condition.lock(); failure = failure ?? "The independent guard exited."; condition.broadcast(); condition.unlock()
        }
    }
    func wait(for key: String, seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        condition.lock(); defer { condition.unlock() }
        while failure == nil {
            if let index = responses.firstIndex(where: { $0[key] as? Bool == true }) {
                responses.remove(at: index); return true
            }
            if !condition.wait(until: deadline) { break }
        }
        return false
    }
}

@MainActor
final class Guardian {
    let uid = getuid()
    let parent = getppid()
    var policy: LockedUseLease
    var listener: Int32 = -1
    var guardUI: LockedScreenGuard!
    var watchdog: Process?
    var watchdogInput: FileHandle?
    var watchdogOutput: FileHandle?
    var watchdogLink: WatchdogLink?
    var watchdogArmed = false
    var stopping = false
    var shutdownNeedsRelock = false
    var pendingID: Int?
    var lastWatchdogPulse: TimeInterval = 0
    var lockedSince: TimeInterval?
    var tick: Timer?

    init() throws {
        guard sklu_parent_matches_pinned_mcp() == 1 else { throw LeaseError("The guardian must be launched by the installed skfiy MCP binary.") }
        guard sklu_console_uid() == uid else { throw LeaseError("Locked use requires the current console owner.") }
        guard LockScreenDriver.sessionLockState == false else { throw LeaseError("Start this MCP session while the Mac is unlocked to arm locked use.") }
        guard AXIsProcessTrusted() else { throw LeaseError("The guardian needs Accessibility access before it can protect a locked-use session.") }
        let duration = Double(ProcessInfo.processInfo.environment["SKFIY_LOCKED_USE_SECONDS"] ?? "") ?? 3600
        policy = LockedUseLease(now: clockNow(), duration: duration)
        listener = sklu_create_listener(uid)
        guard listener >= 0 else { throw LeaseError("Could not bind the locked-use authorization socket (another guardian may be running, or installation is missing).") }
        guardUI = LockedScreenGuard { [weak self] reason in self?.interrupt(reason) }
        try launchWatchdog()
        startAuthorizationServer()
        tick = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
    }

    func launchWatchdog() throws {
        let child = Process(), pipe = Pipe(), response = Pipe()
        child.executableURL = URL(fileURLWithPath: "/Library/PrivilegedHelperTools/com.skfiy.LockedUseGuardian")
        child.arguments = ["--watchdog"]
        child.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        child.standardInput = pipe
        child.standardOutput = response
        child.standardError = FileHandle.standardError
        try child.run()
        watchdog = child
        watchdogInput = pipe.fileHandleForWriting
        watchdogOutput = response.fileHandleForReading
        watchdogLink = WatchdogLink(response.fileHandleForReading)
        watchdogArmed = false
        guard watchdogLink?.wait(for: "ready", seconds: 2) == true else {
            throw LeaseError("The independent relock watchdog failed its startup handshake.")
        }
    }

    func pulse(_ word: String) throws {
        guard watchdog?.isRunning == true, let watchdogInput else { throw LeaseError("The independent relock watchdog is unavailable.") }
        if let failure = watchdogLink?.error { throw LeaseError(failure) }
        if word == "armed", !watchdogArmed {
            try watchdogInput.write(contentsOf: Data("arm\n".utf8))
            guard watchdogLink?.wait(for: "armed", seconds: 2) == true else {
                throw LeaseError("The independent display/input guard did not confirm protection.")
            }
            watchdogArmed = true
        } else if word == "safe", watchdogArmed {
            try watchdogInput.write(contentsOf: Data("safe\n".utf8))
            guard watchdogLink?.wait(for: "safe", seconds: 3) == true else {
                throw LeaseError("The independent guard has not confirmed safe relock.")
            }
            watchdogArmed = false
        } else if word == "armed" {
            try watchdogInput.write(contentsOf: Data("pulse\n".utf8))
        }
        lastWatchdogPulse = clockNow()
    }

    func reply(_ id: Int, error: String? = nil) {
        var response: [String: Any] = ["id": id, "ok": error == nil, "phase": policy.phase.rawValue,
            "generation": policy.generation, "protected": policy.phase == .protected && guardUI.isCovering,
            "osLocked": LockScreenDriver.isLocked, "displays": guardUI.displayCount]
        if !policy.reason.isEmpty { response["reason"] = policy.reason }
        if let error { response["error"] = error }
        emit(response)
    }

    func command(_ object: [String: Any]) async {
        let name = object["command"] as? String ?? ""
        let id = object["id"] as? Int ?? 0
        switch name {
        case "heartbeat": policy.heartbeat(now: clockNow())
        case "begin":
            guard !stopping, pendingID == nil else { reply(id, error: "A locked-use transition is already in progress."); return }
            pendingID = id
            defer { pendingID = nil }
            do {
                guard sklu_console_uid() == uid else { throw LeaseError("Console owner changed.") }
                guard let locked = LockScreenDriver.sessionLockState else { throw LeaseError("The console lock state is unavailable.") }
                let needsUnlock = try policy.begin(now: clockNow(), locked: locked)
                if needsUnlock {
                    if watchdog?.isRunning != true { try launchWatchdog() }
                    try pulse("armed")
                    try guardUI.cover()
                    guard guardUI.isCovering else { throw LeaseError("Could not cover every display and block physical input.") }
                    try await LockScreenDriver.requestUnlockAttempt()
                    let deadline = clockNow() + 5
                    while LockScreenDriver.isLocked && clockNow() < deadline && policy.phase == .authorizing {
                        try await Task.sleep(nanoseconds: 50_000_000)
                    }
                    guard LockScreenDriver.sessionLockState == false else { throw LeaseError("macOS did not authorize the guarded unlock. Unlock manually; no application input was sent.") }
                    try policy.didUnlock(now: clockNow())
                }
                reply(id)
            } catch {
                diagnostic("begin_failed", ["error": String(describing: error), "phase": policy.phase.rawValue,
                                             "reason": policy.reason, "osLocked": LockScreenDriver.isLocked])
                if guardUI.hasCover || policy.phase == .authorizing { interrupt(String(describing: error)) }
                reply(id, error: String(describing: error))
            }
        case "end":
            policy.end(now: clockNow())
            reply(id)
        case "status": reply(id)
        case "release":
            if guardUI.hasCover {
                interrupt("The task finished.", manual: false)
                let deadline = clockNow() + 5
                while guardUI.hasCover && clockNow() < deadline {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                reply(id, error: guardUI.hasCover ? "The OS has not confirmed relock; display protection remains active." : nil)
            } else { reply(id) }
        case "shutdown": shutdown()
        default: if id != 0 { reply(id, error: "Unknown guardian command.") }
        }
    }

    func interrupt(_ reason: String, manual: Bool = true) {
        guard policy.phase != .relocking else { return }
        diagnostic("interrupted", ["reason": reason, "phase": policy.phase.rawValue,
                                    "osLocked": LockScreenDriver.isLocked])
        policy.interrupt(reason, manual: manual)
        lockedSince = nil
        // Keep covers and the HID tap until the OS confirms the lock.
        try? LockScreenDriver.requestLock()
        emit(["event": "interrupted", "reason": reason])
    }

    func poll() {
        let now = clockNow()
        let lockState = LockScreenDriver.sessionLockState
        let locked = lockState == true
        if stopping || getppid() != parent || kill(parent, 0) != 0 { shutdown(); return }
        if guardUI.hasCover {
            if let failure = watchdogLink?.error { interrupt(failure) }
            if lockState == nil { interrupt("The console lock state became unavailable.") }
            if let stop = ProcessInfo.processInfo.environment["SKFIY_STOP_FILE"], FileManager.default.fileExists(atPath: stop) {
                interrupt("Emergency stop was requested; unlock manually before continuing.")
            }
            if watchdog?.isRunning != true { interrupt("The relock watchdog exited.") }
            if now - lastWatchdogPulse >= 0.25 { do { try pulse("armed") } catch { interrupt(String(describing: error)) } }
            if sklu_console_uid() != uid { interrupt("The console session changed.") }
            if policy.mustRelock(now: now) { interrupt("The locked-use lease ended.", manual: false) }
            if policy.phase == .protected, locked { interrupt("The Mac was locked again; unlock manually before continuing.") }
        }
        if policy.phase == .relocking {
            if locked {
                if lockedSince == nil { lockedSince = now }
                guard now - (lockedSince ?? now) >= 0.3, LockScreenDriver.lockUIIsVisible else { return }
                // A failed removal leaves the shield in place, rather than
                // exposing the desktop during an ambiguous OS transition.
                do {
                    try guardUI.removeAfterRelock()
                    if watchdog?.isRunning == true && watchdogLink?.error == nil { try pulse("safe") }
                } catch { return }
            } else { lockedSince = nil; try? LockScreenDriver.requestLock() }
        }
        if let lockState { policy.observe(locked: lockState, now: now) }
    }

    func shutdown() {
        if !stopping {
            shutdownNeedsRelock = guardUI.hasCover || policy.phase == .protected || policy.phase == .authorizing || policy.phase == .relocking
            policy.interrupt("The controlling MCP session ended.")
        }
        stopping = true
        if shutdownNeedsRelock {
            try? LockScreenDriver.requestLock()
            guard LockScreenDriver.isLocked else { return }
            if lockedSince == nil { lockedSince = clockNow(); return }
            guard clockNow() - (lockedSince ?? clockNow()) >= 0.3, LockScreenDriver.lockUIIsVisible else { return }
            do { try guardUI.removeAfterRelock() } catch { return }
        }
        try? pulse("safe")
        try? watchdogInput?.close()
        if listener >= 0 { sklu_remove_listener(uid); close(listener) }
        exit(0)
    }

    func startAuthorizationServer() {
        let descriptor = listener, owner = uid
        Thread.detachNewThread { [weak self] in
            while true {
                let peer = sklu_accept_peer(descriptor)
                if peer < 0 { usleep(20_000); continue }
                var bytes = [UInt8](repeating: 0, count: 32)
                if sklu_peer_is_security_agent(peer, owner) == 1,
                   sklu_read_packet(peer, &bytes) == 1,
                   bytes[0..<8].elementsEqual([0x53, 0x4b, 0x4c, 0x55, 0, 1, 0, 1]),
                   bytes[12..<16].allSatisfy({ $0 == 0 }),
                   bytes[8..<12].reduce(UInt32(0), { ($0 << 8) | UInt32($1) }) == owner {
                    let answer = AuthorizationAnswer()
                    Task { @MainActor [weak self] in
                        answer.resolve { [weak self] in
                            guard let self else { return false }
                            let allowed = !self.stopping && self.watchdogArmed && self.watchdogLink?.error == nil &&
                                self.guardUI.isCovering && sklu_console_uid() == owner &&
                                LockScreenDriver.isLocked && self.policy.consumeAuthorization(now: clockNow())
                            diagnostic("authorization_decision", ["allowed": allowed, "phase": self.policy.phase.rawValue,
                                "reason": self.policy.reason, "osLocked": LockScreenDriver.isLocked,
                                "watchdogError": self.watchdogLink?.error ?? ""])
                            return allowed
                        }
                    }
                    let allowed = answer.wait()
                    bytes[7] = allowed ? 2 : 3
                    _ = sklu_write_packet(peer, &bytes)
                }
                close(peer)
            }
        }
    }
}

/// If the UI actor stalls, the socket times out denied. A late callback must
/// not consume the authorization for a request whose client already left.
final class AuthorizationAnswer: @unchecked Sendable {
    let semaphore = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var allowed = false
    var expired = false
    func resolve(_ result: () -> Bool) {
        lock.lock(); defer { lock.unlock() }
        if !expired { allowed = result(); semaphore.signal() }
    }
    func wait() -> Bool {
        let success = semaphore.wait(timeout: .now() + 0.8) == .success
        lock.lock(); defer { lock.unlock() }
        expired = true
        return success && allowed
    }
}

signal(SIGPIPE, SIG_IGN)
let mode = CommandLine.arguments.dropFirst().first
if mode == "--preflight" || mode == "--request-permissions" {
    MainActor.assumeIsolated {
        if mode == "--request-permissions" {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        }
        emit(["accessibility": LockScreenDriver.accessibilityAvailable,
              "screenCapture": CGPreflightScreenCaptureAccess(),
              "lockAPI": LockScreenDriver.lockAPIAvailable,
              "sessionKnown": LockScreenDriver.sessionLockState != nil,
              "osLocked": LockScreenDriver.isLocked,
              "consoleOwner": sklu_console_uid() == getuid()])
    }
} else if mode == "--watchdog" {
    guard sklu_parent_matches_pinned_guardian() == 1 else { fatal("Watchdog must be started by the installed guardian.") }
    MainActor.assumeIsolated { LockedUseWatchdog.run() }
} else if mode == "--serve" {
    NSApplication.shared.setActivationPolicy(.accessory)
    MainActor.assumeIsolated {
        do {
            let guardian = try Guardian()
            // Strong lifetime is owned by this reader and its pending tasks.
            Thread.detachNewThread {
                while let line = readLine() {
                    guard line.utf8.count <= 4096,
                          let data = line.data(using: .utf8),
                          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    Task { @MainActor in await guardian.command(object) }
                }
                Task { @MainActor in guardian.shutdown() }
            }
            emit(["ready": true, "phase": guardian.policy.phase.rawValue])
        } catch { fatal(String(describing: error)) }
    }
    NSApplication.shared.run()
} else { fatal("Internal helper: use skfiy MCP with locked use enabled.") }
