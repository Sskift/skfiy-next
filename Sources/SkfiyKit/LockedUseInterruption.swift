import Foundation
import CoreGraphics

/// Shared with the guardian pipe reader and every input loop. Interruption is
/// sticky until a new begin response establishes a valid session generation.
/// Regular MCP sessions never set this gate, so their behavior is unchanged.
enum LockedUseInterruption {
    private static let lock = NSLock()
    private static var stopped = false
    private static var message = ""
    private static var revisionValue: UInt64 = 0

    static var revision: UInt64 {
        lock.lock(); defer { lock.unlock() }
        return revisionValue
    }

    static var interrupted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    static var isInterrupted: Bool { interrupted }

    static var blocksInput: Bool {
        if interrupted { return true }
        guard ProcessInfo.processInfo.environment["SKFIY_LOCKED_USE"] == "1" else { return false }
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        return session["CGSSessionScreenIsLocked"] as? Bool == true
    }

    static var reason: String {
        lock.lock()
        defer { lock.unlock() }
        return message
    }

    static func interrupt(_ reason: String) {
        lock.lock()
        defer { lock.unlock() }
        stopped = true
        revisionValue &+= 1
        message = reason.isEmpty ? "Locked computer use was interrupted; no further input was sent." : reason
    }

    static func reset(ifRevision expected: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard revisionValue == expected else { return false }
        stopped = false
        message = ""
        return true
    }

    static func check() throws {
        lock.lock()
        let current = stopped ? message : nil
        lock.unlock()
        if let current { throw ToolError(current) }
    }
}
