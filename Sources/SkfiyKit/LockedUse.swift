import Foundation
import LockedUseCore

/// Private pipes bind a grant to this MCP process. No unlock token or password
/// is exposed as a tool argument, environment variable, file or log entry.
@MainActor
final class LockedUseClient {
    private var process: Process?
    private var input: FileHandle?
    private var heartbeat: Timer?
    private var pending: (UUID, CheckedContinuation<String, Error>)?
    private(set) var failure: String?
    private(set) var protected = false

    func start() async throws {
        guard skfiy_guardian_installed() else {
            throw ToolError("Locked use is not installed or its signature/ownership is invalid. See locked-use/GUARDIAN.md; normal computer use remains available without --locked-use.")
        }
        let task = Process(), stdin = Pipe(), stdout = Pipe()
        task.executableURL = URL(fileURLWithPath: SKFIY_GUARDIAN)
        task.arguments = []
        // Do not pass DYLD injection variables or arbitrary agent configuration.
        task.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        task.standardInput = stdin
        task.standardOutput = stdout
        task.standardError = FileHandle.standardError
        process = task
        input = stdin.fileHandleForWriting
        do { try task.run() } catch {
            invalidate("Could not start locked-use guardian: \(error.localizedDescription)")
            throw error
        }
        stdin.fileHandleForReading.closeFile()
        stdout.fileHandleForWriting.closeFile()
        let reader = stdout.fileHandleForReading
        Thread {
            var buffer = Data()
            while true {
                let data = reader.availableData
                if data.isEmpty { break }
                buffer.append(data)
                if buffer.count > 4096 { break }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = String(decoding: buffer[..<newline], as: UTF8.self)
                    buffer.removeSubrange(...newline)
                    Task { @MainActor in self.receive(line) }
                }
            }
            reader.closeFile()
            Task { @MainActor in self.invalidate("Locked-use guardian disconnected; unlock manually and restart this MCP server.") }
        }.start()
        // No main-actor receive callback can run until request installs its continuation.
        guard try await request(nil, timeout: 90) == "ARMED" else { throw ToolError("Locked-use approval was not granted.") }
        heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if EmergencyStop.isStopped { self.invalidate("Emergency stop ended the locked-use grant.") }
                else { self.send("PING") }
            }
        }
    }

    func begin() async throws {
        if let failure { throw ToolError(failure) }
        let answer = try await request("BEGIN", timeout: 12)
        guard answer == "READY" || answer == "READY_LOCKED" else { throw ToolError(answer) }
        protected = answer == "READY_LOCKED"
    }

    func end() async throws {
        if let failure { throw ToolError(failure) }
        let answer = try await request("END", timeout: 8)
        guard answer == "DONE" else { throw ToolError(answer) }
        protected = false
    }

    func check() throws {
        if let failure { throw ToolError(failure) }
    }

    func disconnect() {
        invalidate("MCP client disconnected; the locked-use grant was revoked.")
    }

    var status: String {
        if let failure { return "revoked: \(failure)" }
        return protected ? "active under screen protection" : "armed for this MCP process (up to one hour)"
    }

    private func request(_ command: String?, timeout: TimeInterval) async throws -> String {
        if let failure { throw ToolError(failure) }
        guard pending == nil else { throw ToolError("Locked-use requests must not overlap.") }
        let id = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            pending = (id, continuation)
            if let command { send(command) }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                if self.pending?.0 == id { self.invalidate("Locked-use guardian timed out; no automatic retry. Unlock manually before continuing.") }
            }
        }
    }

    private func send(_ line: String) {
        guard failure == nil else { return }
        do { try input?.write(contentsOf: Data((line + "\n").utf8)) }
        catch { invalidate("Could not contact locked-use guardian.") }
    }

    private func receive(_ line: String) {
        if line.hasPrefix("ERROR ") { invalidate(String(line.dropFirst(6))); return }
        guard let waiting = pending else {
            invalidate("Unexpected locked-use guardian response.")
            return
        }
        pending = nil
        waiting.1.resume(returning: line)
    }

    private func invalidate(_ message: String) {
        guard failure == nil else { return }
        failure = message
        heartbeat?.invalidate()
        heartbeat = nil
        // EOF tells the independent guardian to revoke, relock, and only then
        // remove the display covers. Never kill a guardian holding the covers.
        try? input?.close()
        input = nil
        let waiting = pending
        pending = nil
        waiting?.1.resume(throwing: ToolError(message))
    }
}
