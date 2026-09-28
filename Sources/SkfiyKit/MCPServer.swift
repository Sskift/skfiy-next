import Foundation

public let skfiyVersion = "0.2.0"

/// Executes tools for the MCP server; the real one is `ComputerUse`.
@MainActor
public protocol ToolExecutor: AnyObject {
    func call(_ name: String, _ arguments: [String: Any]) async -> ToolResult
}

extension ComputerUse: ToolExecutor {}

/// A Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0.
/// Requests are handled one at a time, in order, so actions never interleave.
@MainActor
public final class MCPServer {
    static let supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

    private let executor: ToolExecutor
    private let tools: [[String: Any]]
    private let write: (Data) -> Void

    public init(executor: ToolExecutor, write: @escaping (Data) -> Void = MCPServer.writeToStdout) {
        self.executor = executor
        self.tools = ToolSchemas.all + ToolSchemas.browser
        self.write = write
    }

    nonisolated public static func writeToStdout(_ data: Data) {
        FileHandle.standardOutput.write(data + Data([0x0A]))
    }

    /// Reads stdin until EOF, then exits. Call from the main thread, which
    /// must keep running its run loop (AppKit state and main-actor work need it).
    public func start() {
        let lines = AsyncStream<String> { continuation in
            let thread = Thread {
                while let line = readLine(strippingNewline: true) {
                    continuation.yield(line)
                }
                continuation.finish()
            }
            thread.start()
        }
        Task { @MainActor in
            for await line in lines {
                await self.handle(line: line)
            }
            exit(0)
        }
    }

    public func handle(line: String) async {
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
            if let response = await respond(to: object) {
                send(response)
            }
        } else {
            send(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32600, "message": "Invalid Request"]])
        }
    }

    /// Returns the response for a request, or nil for notifications.
    public func respond(to message: [String: Any]) async -> [String: Any]? {
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
            let requested = params["protocolVersion"] as? String ?? ""
            let version = Self.supportedProtocolVersions.contains(requested)
                ? requested
                : Self.supportedProtocolVersions[0]
            return result([
                "protocolVersion": version,
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "skfiy", "title": "skfiy computer use", "version": skfiyVersion],
                "instructions": ToolSchemas.instructions
            ])
        case "ping":
            return result([:])
        case "tools/list":
            return result(["tools": tools])
        case "tools/call":
            guard let name = params["name"] as? String else {
                return failure(-32602, "tools/call needs a tool name.")
            }
            guard tools.contains(where: { $0["name"] as? String == name }) else {
                return failure(-32602, "Unknown tool: \(name)")
            }
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            let outcome = await executor.call(name, arguments)
            var content: [[String: Any]] = [["type": "text", "text": outcome.text]]
            if let image = outcome.image {
                content.append([
                    "type": "image",
                    "data": image.base64EncodedString(),
                    "mimeType": outcome.imageMimeType
                ])
            }
            return result(["content": content, "isError": outcome.isError])
        case "resources/list":
            return result(["resources": []])
        case "prompts/list":
            return result(["prompts": []])
        default:
            return failure(-32601, "Method not found: \(method)")
        }
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else {
            return
        }
        write(data)
    }
}
