import Foundation

struct BrowserDeadlineExceeded: Error, CustomStringConvertible {
    var description: String { "The browser operation exhausted its time budget. Inspect browser_state before retrying an action." }
}

/// Monotonic, shared by discovery, transport, observations and capture. User
/// approval is not execution time. Access also occurs on detached socket tasks.
final class BrowserDeadline: @unchecked Sendable {
    private let lock = NSLock()
    private var end: Double
    init(seconds: TimeInterval) { end = ProcessInfo.processInfo.systemUptime + max(0, seconds) }
    var remaining: TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return max(0, end - ProcessInfo.processInfo.systemUptime)
    }
    func exclude(_ seconds: TimeInterval) {
        lock.lock(); end += max(0, seconds); lock.unlock()
    }
    func check() throws {
        try Task.checkCancellation()
        if remaining <= 0 { throw BrowserDeadlineExceeded() }
    }
}

enum BrowserOperation {
    @TaskLocal static var deadline: BrowserDeadline?
    @TaskLocal static var traceID: String?
    private static let traceLock = NSLock()

    static func phase<T>(_ phase: String, requireTimelyResult: Bool = true, body: () async throws -> T) async throws -> T {
        let started = ProcessInfo.processInfo.systemUptime
        var outcome = "ok"
        defer { record(phase, started: started, outcome: outcome) }
        do {
            try deadline?.check()
            let result = try await body()
            if requireTimelyResult { try deadline?.check() }
            return result
        } catch {
            outcome = error is BrowserDeadlineExceeded ? "timeout" : error is CancellationError ? "cancelled" : "error"
            throw error
        }
    }

    static func record(_ phase: String, started: Double, outcome: String) {
        guard let traceID else { return }
        // Metadata only: never URLs, page text, file paths, or typed input.
        let row: [String: Any] = ["event": "browser_phase", "request": traceID, "phase": phase, "outcome": outcome,
            "elapsed_ms": (ProcessInfo.processInfo.systemUptime - started) * 1000,
            "remaining_ms": (deadline?.remaining ?? 0) * 1000]
        guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
        traceLock.lock(); defer { traceLock.unlock() }
        FileHandle.standardError.write(data + Data([10]))
    }
}
