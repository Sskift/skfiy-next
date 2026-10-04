import AppKit
import Foundation

/// Independent backup protection. This process owns its own opaque windows and
/// HID tap before acknowledging an arm request, so death of the primary
/// guardian does not remove the last screen/input guard.
@MainActor
public enum LockedUseWatchdog {
    public static func run() -> Never {
        NSApplication.shared.setActivationPolicy(.accessory)
        let service = WatchdogService()
        service.start()
        NSApplication.shared.run()
        // Termination must normally go through service.relockAndFinish().
        // If AppKit unexpectedly returns, retain the process and its covers
        // while retrying the actual OS lock.
        service.interrupt("watchdog_application_loop_ended")
        RunLoop.main.run()
        exit(1)
    }
}

@MainActor
private final class WatchdogService {
    private enum Phase { case idle, arming, armed, releasing, failing }
    private enum Command: Sendable { case line(String), eof }
    private var phase: Phase = .idle
    private var screenGuard: LockedScreenGuard!
    private var timer: Timer?
    private var reader: Task<Void, Never>?
    private var lastPulse = ProcessInfo.processInfo.systemUptime
    private var lockedSince: TimeInterval?
    private var interruptionEmitted = false

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func start() {
        screenGuard = LockedScreenGuard { [weak self] reason in
            self?.interrupt("watchdog_" + reason)
        }
        let commands = AsyncStream<Command> { continuation in
            Thread.detachNewThread {
                while let line = readLine() {
                    // Unknown/oversized input is a protocol failure, never an
                    // implicit safe/release instruction.
                    continuation.yield(.line(line.utf8.count <= 64 ? line : "invalid"))
                }
                continuation.yield(.eof)
                continuation.finish()
            }
        }
        // One consuming task preserves stdin command order. In particular, a
        // queued safe command cannot asynchronously remove a newer arm's cover.
        reader = Task { @MainActor [self] in
            for await command in commands { handle(command) }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
        emit(["ready": true])
    }

    private func handle(_ command: Command) {
        switch command {
        case .eof:
            if phase == .idle, !screenGuard.hasCover { exit(0) }
            interrupt("watchdog_parent_pipe_closed")
        case .line("arm"):
            guard phase == .idle, !screenGuard.hasCover else {
                interrupt("watchdog_arm_out_of_sequence")
                return
            }
            guard LockScreenDriver.sessionLockState == true else {
                interrupt("watchdog_arm_requires_known_locked_session")
                return
            }
            phase = .arming
            lastPulse = now
            lockedSince = nil
            do {
                try screenGuard.cover()
                guard phase == .arming, screenGuard.isCovering,
                      LockScreenDriver.sessionLockState == true else {
                    throw LeaseError("The backup protection was interrupted while arming.")
                }
                phase = .armed
                lastPulse = now
                // This is the only positive arm response. The primary must
                // wait for it before granting any OS-unlock authorization.
                emit(["armed": true, "displays": screenGuard.displayCount])
            } catch {
                emit(["armed": false, "error": String(describing: error)])
                interrupt("watchdog_could_not_establish_protection")
            }
        case .line("pulse"):
            // Pulses cannot cancel a pending release or failed protection.
            if phase == .armed { lastPulse = now }
        case .line("safe"):
            if phase == .idle { emit(["safe": true]); return }
            guard phase == .armed else {
                // A safe message following a failure does not rehabilitate the
                // session. We finish the relock and terminate independently.
                return
            }
            phase = .releasing
            lockedSince = nil
            if LockScreenDriver.sessionLockState != true {
                interrupt("watchdog_safe_received_before_os_relock")
            }
        case .line:
            interrupt("watchdog_invalid_command")
        }
    }

    func interrupt(_ reason: String) {
        phase = .failing
        lockedSince = nil
        // Never stop the pulse timer or remove windows before the real lock is
        // both observed and visually settled.
        try? LockScreenDriver.requestLock()
        if !interruptionEmitted {
            interruptionEmitted = true
            emit(["event": "interrupted", "reason": reason])
        }
    }

    private func poll() {
        switch phase {
        case .idle:
            return
        case .arming, .armed:
            if !screenGuard.isCovering {
                interrupt("watchdog_protection_lost")
            } else if LockScreenDriver.sessionLockState == nil {
                interrupt("watchdog_session_state_unknown")
            } else if now - lastPulse > 1.5 {
                interrupt("watchdog_parent_heartbeat_expired")
            }
        case .releasing, .failing:
            relockAndFinish()
        }
    }

    private func relockAndFinish() {
        guard LockScreenDriver.sessionLockState == true else {
            lockedSince = nil
            try? LockScreenDriver.requestLock()
            return
        }
        if lockedSince == nil { lockedSince = now }
        guard now - (lockedSince ?? now) >= 0.3, LockScreenDriver.lockUIIsVisible else { return }
        do { try screenGuard.removeAfterRelock() } catch { return }
        if phase == .failing { exit(0) }
        phase = .idle
        lockedSince = nil
        interruptionEmitted = false
        emit(["safe": true])
    }

    private func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
        catch {
            if phase == .idle, !screenGuard.hasCover { exit(0) }
            // A failed response is equivalent to losing the primary. Do not
            // recursively emit another response on the broken pipe.
            phase = .failing
            lockedSince = nil
            interruptionEmitted = true
            try? LockScreenDriver.requestLock()
        }
    }
}
