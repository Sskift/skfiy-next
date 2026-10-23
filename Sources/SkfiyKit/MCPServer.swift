import ApplicationServices
import Foundation

public let skfiyVersion = "0.9.0"

/// Executes tools for the MCP server; the real one is `ComputerUse`.
@MainActor
public protocol ToolExecutor: AnyObject {
    func call(_ name: String, _ arguments: [String: Any]) async -> ToolResult
    func disconnect()
}

extension ToolExecutor { public func disconnect() {} }

extension ComputerUse: ToolExecutor {}

/// A Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0.
/// Requests are handled one at a time, in order, so actions never interleave.
@MainActor
public final class MCPServer {
    static let supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

    private let executor: ToolExecutor
    private let tools: [[String: Any]]
    private let write: (Data) -> Void
    /// What the client announced in initialize (e.g. elicitation support).
    private var clientCapabilities: [String: Any] = [:]
    /// Requests this server sent to the client, waiting for their responses.
    private var pending: [String: CheckedContinuation<[String: Any]?, Never>] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]
    private var nextRequest = 0
    /// Tool calls in progress, by request id, so the client can cancel them.
    private var running: [String: Task<ToolResult, Never>] = [:]
    private var cancelled: Set<String> = []
    private var queued: Set<String> = []
    private var lines: [String] = []
    private var draining: Task<Void, Never>?
    private var disconnected = false

    /// The browser tools are left out when no browser can connect: users
    /// without the extension do not carry their definitions in every request.
    public init(executor: ToolExecutor, write: @escaping (Data) -> Void = MCPServer.writeToStdout,
                browserTools: Bool = BrowserBridge.isRegistered) {
        self.executor = executor
        self.tools = (ToolSchemas.all + (browserTools ? ToolSchemas.browser : [])).map(\.definition)
        self.write = write
    }

    /// Put before the instructions when a permission is missing, so the
    /// model tells the user before the first tool fails mid-task.
    static func setupNote(accessibility: Bool = AXIsProcessTrusted(), screenRecording: Bool = CGPreflightScreenCaptureAccess(),
                          host: @autoclosure () -> String = hostApplicationName()) -> String {
        let missing = (accessibility ? [] : ["Accessibility"]) + (screenRecording ? [] : ["Screen Recording"])
        guard !missing.isEmpty else { return "" }
        let host = host()
        return "Setup incomplete: macOS has not granted \(missing.joined(separator: " and ")) to \(host), the app running skfiy. Before using the tools, ask the user to enable it in System Settings → Privacy & Security (or run `skfiy doctor` in \(host)), then quit and reopen \(host) and Claude Code.\n\n"
    }

    nonisolated public static func writeToStdout(_ data: Data) {
        FileHandle.standardOutput.write(data + Data([0x0A]))
    }

    /// Reads stdin until EOF, then exits. Call from the main thread, which
    /// must keep running its run loop (AppKit state and main-actor work need it).
    public func start() {
        Thread {
            while let line = readLine(strippingNewline: true) {
                // One FIFO admission path: a cancellation cannot overtake the
                // registration of the request it cancels, even before execution.
                DispatchQueue.main.async { self.receive(line: line) }
            }
            DispatchQueue.main.async {
                self.disconnect()
                Task { @MainActor in
                    await self.draining?.value
                    exit(0)
                }
            }
        }.start()
    }

    /// Admit requests in wire order, while replies and cancellations bypass
    /// the execution queue. Also used by protocol lifecycle tests.
    func receive(line: String) {
        guard !disconnected else { return }
        if let response = Self.clientResponse(line) { deliver(response); return }
        if let id = Self.cancellation(line) { cancel(id); return }
        if let data = line.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) {
            let messages = (json as? [[String: Any]]) ?? (json as? [String: Any]).map { [$0] } ?? []
            for message in messages where message["method"] as? String == "tools/call" {
                if let id = message["id"], !(id is NSNull) { queued.insert("\(id)") }
            }
        }
        lines.append(line)
        guard draining == nil else { return }
        draining = Task { @MainActor in
            while !disconnected, !lines.isEmpty {
                await self.handle(line: lines.removeFirst())
            }
            draining = nil
        }
    }

    func disconnect() {
        guard !disconnected else { return }
        disconnected = true
        for task in running.values { task.cancel() }
        lines.removeAll()
        queued.removeAll()
        cancelled.removeAll()
        executor.disconnect()
        for id in Array(pending.keys) { finishRequest(id, response: nil) }
    }

    public func handle(line: String) async {
        guard !disconnected else { return }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let data = trimmed.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) else {
            send(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "Parse error"]])
            return
        }
        if let batch = message as? [[String: Any]] {
            for item in batch {
                if let response = await respond(to: item) {
                    send(response)
                }
            }
        } else if let object = message as? [String: Any] {
            if object["method"] == nil, object["result"] != nil || object["error"] != nil {
                deliver(object)
            } else if let response = await respond(to: object) {
                send(response)
            }
        } else {
            send(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32600, "message": "Invalid Request"]])
        }
    }

    /// Returns the response for a request, or nil for notifications.
    public func respond(to message: [String: Any]) async -> [String: Any]? {
        guard !disconnected else { return nil }
        let id = message["id"]
        let method = message["method"] as? String ?? ""
        let params = message["params"] as? [String: Any] ?? [:]

        guard let id, !(id is NSNull) else {
            return nil // notifications: initialized, cancelled, ...
        }

        func result(_ value: [String: Any]) -> [String: Any] {
            ["jsonrpc": "2.0", "id": id, "result": value]
        }
        func failure(_ code: Int, _ text: String) -> [String: Any] {
            ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": text]]
        }

        switch method {
        case "initialize":
            clientCapabilities = params["capabilities"] as? [String: Any] ?? [:]
            let requested = params["protocolVersion"] as? String ?? ""
            let version = Self.supportedProtocolVersions.contains(requested)
                ? requested
                : Self.supportedProtocolVersions[0]
            return result([
                "protocolVersion": version,
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "skfiy", "title": "skfiy computer use", "version": skfiyVersion],
                "instructions": Self.setupNote() + ToolSchemas.instructions
            ])
        case "ping":
            return result([:])
        case "tools/list":
            return result(["tools": tools])
        case "tools/call":
            let key = "\(id)"
            queued.remove(key)
            if cancelled.remove(key) != nil { return nil }
            guard let name = params["name"] as? String else {
                return failure(-32602, "tools/call needs a tool name.")
            }
            guard tools.contains(where: { $0["name"] as? String == name }) else {
                return failure(-32602, "Unknown tool: \(name)")
            }
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            let executor = self.executor
            let task = Task { @MainActor in
                guard !Task.isCancelled else { return ToolResult(text: "Cancelled.", isError: true) }
                return await executor.call(name, arguments)
            }
            running[key] = task
            let outcome = await task.value
            running[key] = nil
            // A cancelled request gets no response (MCP cancellation).
            if cancelled.remove(key) != nil || disconnected { return nil }
            var content: [[String: Any]] = [["type": "text", "text": outcome.text]]
            if let image = outcome.image {
                content.append([
                    "type": "image",
                    "data": image.base64EncodedString(),
                    "mimeType": outcome.imageMimeType
                ])
            }
            var response: [String: Any] = ["content": content, "isError": outcome.isError]
            if let structured = outcome.structuredContent { response["structuredContent"] = structured }
            return result(response)
        case "resources/list":
            return result(["resources": []])
        case "prompts/list":
            return result(["prompts": []])
        default:
            return failure(-32601, "Method not found: \(method)")
        }
    }

    // MARK: Asking the user

    /// Whether the client announced that it can ask the user (MCP elicitation).
    public var clientCanAsk: Bool { clientCapabilities["elicitation"] != nil }

    /// Asks the user a yes/no question through the client (MCP elicitation).
    /// nil when the client cannot ask or no answer came in time.
    public func confirm(_ message: String, field: String = "Allow", timeout: TimeInterval = 180) async -> Bool? {
        guard clientCanAsk else { return nil }
        guard let response = await request("elicitation/create", ["message": message, "requestedSchema": Self.approvalSchema(field: field)], timeout: timeout),
              !Task.isCancelled, let result = response["result"] as? [String: Any] else {
            return nil
        }
        return Self.approval(result)
    }

    /// One switch, on by default: Claude Code submits a field's default when the user just accepts the
    /// form, so with a default of off every accept read as a refusal.
    nonisolated static func approvalSchema(field: String) -> [String: Any] {
        [
            "type": "object",
            "properties": ["allow": ["type": "boolean", "title": field, "default": true]],
            "required": ["allow"]
        ]
    }

    /// Accepting the form is the approval; switching the field off inside it, declining or
    /// cancelling refuses.
    nonisolated static func approval(_ result: [String: Any]) -> Bool {
        guard result["action"] as? String == "accept" else { return false }
        return (result["content"] as? [String: Any])?["allow"] as? Bool ?? true
    }

    /// Sends a request to the client and waits for its response.
    func request(_ method: String, _ params: [String: Any], timeout: TimeInterval) async -> [String: Any]? {
        guard !disconnected, !Task.isCancelled else { return nil }
        nextRequest += 1
        let id = "skfiy-\(nextRequest)"
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !disconnected, !Task.isCancelled else { continuation.resume(returning: nil); return }
                pending[id] = continuation
                send(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
                timeouts[id] = Task { @MainActor in
                    do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) } catch { return }
                    self.finishRequest(id, response: nil, notifyCancellation: true)
                }
            }
        } onCancel: {
            Task { @MainActor in self.finishRequest(id, response: nil, notifyCancellation: true) }
        }
    }

    private func finishRequest(_ id: String, response: [String: Any]?, notifyCancellation: Bool = false) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        timeouts.removeValue(forKey: id)?.cancel()
        if notifyCancellation {
            send(["jsonrpc": "2.0", "method": "notifications/cancelled", "params": ["requestId": id]])
        }
        continuation.resume(returning: response)
    }

    private func deliver(_ response: [String: Any]) {
        guard let id = response["id"].map({ "\($0)" }) else { return }
        finishRequest(id, response: response)
    }

    /// Stops a tool call the client no longer wants: waits end at once, and
    /// input stops before its next event.
    func cancel(_ requestID: String) {
        guard running[requestID] != nil || queued.contains(requestID) else { return }
        cancelled.insert(requestID)
        running[requestID]?.cancel()
    }

    /// The request id of a notifications/cancelled line, if it is one.
    nonisolated static func cancellation(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["method"] as? String == "notifications/cancelled", object["id"] == nil,
              let params = object["params"] as? [String: Any], let id = params["requestId"] else { return nil }
        return "\(id)"
    }

    nonisolated static func clientResponse(_ line: String) -> [String: Any]? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["method"] == nil, object["id"] != nil, object["result"] != nil || object["error"] != nil else {
            return nil
        }
        return object
    }

    private func send(_ object: [String: Any]) {
        guard !disconnected else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else {
            return
        }
        write(data)
    }
}
