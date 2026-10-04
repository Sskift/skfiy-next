import AppKit
import Foundation

/// Private inherited pipes bind the guard to one MCP process. There is no
/// public unlock RPC or password. Only the pinned installed binary can arm it.
@MainActor
final class LockedUseClient {
    static let installedMCP = "/Library/Application Support/skfiy/locked-use/skfiy"
    static let guardianPath = "/Library/PrivilegedHelperTools/com.skfiy.LockedUseGuardian"
    static var enabled: Bool { ProcessInfo.processInfo.environment["SKFIY_LOCKED_USE"] == "1" }
    private var process: Process?
    private var input: FileHandle?
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var sequence = 0
    private var generation = 0
    private var startupError: String?
    private var heartbeat: Task<Void, Never>?
    private(set) var protecting = false

    init() {
        guard Self.enabled else { return }
        guard FileManager.default.isExecutableFile(atPath: Self.guardianPath) else {
            startupError = "Locked use is enabled but its guardian is not installed. Install the locked-use package first."
            return
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: Self.guardianPath)
        child.arguments = ["--serve"]
        // Never propagate DYLD injection or arbitrary helper configuration.
        child.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(),
                             "SKFIY_STOP_FILE": EmergencyStop.flag.path,
                             "SKFIY_LOCKED_USE_SECONDS": ProcessInfo.processInfo.environment["SKFIY_LOCKED_USE_SECONDS"] ?? "3600"]
        let stdin = Pipe(), stdout = Pipe()
        child.standardInput = stdin
        child.standardOutput = stdout
        child.standardError = FileHandle.standardError
        do {
            try child.run()
            process = child
            input = stdin.fileHandleForWriting
            let reader = stdout.fileHandleForReading
            Thread.detachNewThread { [weak self] in
                var buffer = Data()
                while true {
                    let chunk = reader.availableData
                    if chunk.isEmpty { break }
                    buffer.append(chunk)
                    while let newline = buffer.firstIndex(of: 10) {
                        let line = buffer[..<newline]
                        buffer.removeSubrange(...newline)
                        guard let reply = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                        if reply["event"] as? String == "interrupted" {
                            LockedUseInterruption.interrupt(reply["reason"] as? String ?? "Locked use was interrupted.")
                        }
                        Task { @MainActor [weak self] in self?.receive(reply) }
                    }
                    if buffer.count > 65536 { break }
                }
                Task { @MainActor [weak self] in self?.disconnected() }
            }
        } catch { startupError = "Could not start the locked-use guardian: \(error.localizedDescription)" }
    }

    private func receive(_ reply: [String: Any]) {
        if let message = reply["fatal"] as? String { startupError = message }
        if reply["event"] as? String == "interrupted" { protecting = false }
        guard let id = reply["id"] as? Int, let continuation = pending.removeValue(forKey: id) else { return }
        if reply["ok"] as? Bool == true { continuation.resume(returning: reply) }
        else { continuation.resume(throwing: ToolError(reply["error"] as? String ?? "Locked-use guardian refused the operation.")) }
    }

    private func disconnected() {
        LockedUseInterruption.interrupt("The locked-use guardian disconnected.")
        heartbeat?.cancel()
        protecting = false
        startupError = startupError ?? "The locked-use guardian exited; its watchdog relocks the Mac. Restart this MCP session after unlocking manually."
        let calls = pending.values
        pending.removeAll()
        calls.forEach { $0.resume(throwing: ToolError(startupError!)) }
    }

    private func send(_ object: [String: Any]) throws {
        guard let input, process?.isRunning == true else { throw ToolError(startupError ?? "Locked-use guardian is not running.") }
        try input.write(contentsOf: JSONSerialization.data(withJSONObject: object) + Data([10]))
    }

    private func request(_ command: String) async throws -> [String: Any] {
        if let startupError { throw ToolError(startupError) }
        sequence += 1
        let id = sequence
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do { try send(["id": id, "command": command]) }
            catch { pending.removeValue(forKey: id)?.resume(throwing: error) }
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                self?.pending.removeValue(forKey: id)?.resume(throwing: ToolError("Locked-use guardian did not answer within 12 seconds; no tool action was started."))
            }
        }
    }

    /// Returns true when old AX elements and screenshot coordinates must be refreshed.
    func begin() async throws -> Bool {
        guard Self.enabled else { return false }
        heartbeat?.cancel()
        heartbeat = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? self?.send(["command": "heartbeat"])
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { break }
            }
        }
        do {
            let revision = LockedUseInterruption.revision
            let reply = try await request("begin")
            guard LockedUseInterruption.reset(ifRevision: revision) else {
                throw ToolError("Locked use was interrupted while starting the operation; no application input was sent.")
            }
            protecting = reply["protected"] as? Bool ?? false
            let next = reply["generation"] as? Int ?? generation
            let changed = next != generation
            generation = next
            return changed
        } catch { heartbeat?.cancel(); throw error }
    }

    func end() async {
        guard Self.enabled else { return }
        _ = try? await request("end")
        heartbeat?.cancel()
    }

    func status(release: Bool = false) async -> ToolResult {
        guard Self.enabled else { return ToolResult(text: "{\"enabled\":false,\"protected\":false}") }
        do {
            let value = try await request(release ? "release" : "status")
            if release { protecting = false }
            let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
            return ToolResult(text: String(decoding: data, as: UTF8.self))
        } catch { return ToolResult(text: String(describing: error), isError: true) }
    }
}

public enum LockedUse {
    /// Arming only works from the immutable installed MCP binary. Normal MCP
    /// operation and the optional browser extension remain independent.
    public static func runInstalledMCPIfEnabled() throws {
        guard ProcessInfo.processInfo.environment["SKFIY_LOCKED_USE"] == "1" else { return }
        let expected = "/Library/Application Support/skfiy/locked-use/skfiy"
        let current = Bundle.main.executableURL?.resolvingSymlinksInPath().path
        if current == expected || ProcessInfo.processInfo.environment["SKFIY_INSTANCE"] != nil { return }
        guard FileManager.default.isExecutableFile(atPath: expected) else {
            throw ToolError("Install the locked-use package before enabling SKFIY_LOCKED_USE=1.")
        }
        let args = [expected, "mcp"].map { strdup($0) } + [nil]
        defer { args.forEach { free($0) } }
        execv(expected, args)
        throw ToolError("Could not run installed locked-use MCP: \(String(cString: strerror(errno)))")
    }
}
