import Foundation

/// A lease starts while the owner is present, and only an in-flight native
/// tool can open a one-shot authorization window. No wall-clock deadlines.
public struct LockedUseLease {
    public enum Phase: String { case armed, authorizing, protected, relocking, suspended, expired }
    public private(set) var phase: Phase = .armed
    public private(set) var generation = 0
    public private(set) var toolActive = false
    public private(set) var reason = ""
    public let expiresAt: TimeInterval
    private var authorizationUntil: TimeInterval = 0
    private var heartbeatUntil: TimeInterval = 0
    private var idleUntil: TimeInterval = 0
    private var sawRelock = false
    private var requiresManualUnlock = true

    public init(now: TimeInterval, duration: TimeInterval) {
        expiresAt = now + min(max(duration, 30), 3600)
    }

    public mutating func begin(now: TimeInterval, locked: Bool) throws -> Bool {
        guard now < expiresAt else { phase = .expired; throw LeaseError("Locked-use session expired; restart the MCP session while the Mac is unlocked.") }
        guard phase == .armed || phase == .protected else {
            throw LeaseError(reason.isEmpty ? "Locked use is \(phase.rawValue); unlock the Mac manually before continuing." : reason)
        }
        toolActive = true
        heartbeatUntil = now + 5
        if locked {
            phase = .authorizing
            authorizationUntil = now + 5
            return true
        }
        return false
    }

    /// Called only after kernel peer identity and display/input guard checks.
    public mutating func consumeAuthorization(now: TimeInterval) -> Bool {
        guard phase == .authorizing, toolActive, now < expiresAt,
              now < authorizationUntil, now < heartbeatUntil else { return false }
        authorizationUntil = 0
        return true
    }

    public mutating func didUnlock(now: TimeInterval) throws {
        guard phase == .authorizing, authorizationUntil == 0, now < expiresAt,
              toolActive, now < heartbeatUntil else {
            throw LeaseError("The guarded unlock did not complete inside its authorization window.")
        }
        phase = .protected
        generation += 1
    }

    public mutating func heartbeat(now: TimeInterval) {
        if toolActive { heartbeatUntil = now + 5 }
    }
    public mutating func end(now: TimeInterval) {
        toolActive = false
        authorizationUntil = 0
        idleUntil = now + 30
    }
    public func mustRelock(now: TimeInterval) -> Bool {
        guard phase == .protected || phase == .authorizing else { return false }
        return now >= expiresAt || (toolActive ? now >= heartbeatUntil : now >= idleUntil)
    }
    public mutating func interrupt(_ message: String, manual: Bool = true) {
        phase = .relocking
        toolActive = false
        authorizationUntil = 0
        reason = message
        requiresManualUnlock = manual
        sawRelock = false
        generation += 1
    }
    public mutating func observe(locked: Bool, now: TimeInterval) {
        if phase == .relocking, locked {
            phase = now >= expiresAt ? .expired : (requiresManualUnlock ? .suspended : .armed)
            sawRelock = true
        } else if phase == .suspended, sawRelock, !locked, now < expiresAt {
            phase = .armed
            reason = ""
            sawRelock = false
            generation += 1
        }
    }
}

public struct LeaseError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}
