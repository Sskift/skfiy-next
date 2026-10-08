import Foundation
import Testing
@testable import SkfiyKit

@MainActor
final class FakeExecutor: ToolExecutor {
    var calls: [(String, [String: Any])] = []
    var result = ToolResult(text: "ok")
    var disconnected = false
    func disconnect() { disconnected = true }

    func call(_ name: String, _ arguments: [String: Any]) async -> ToolResult {
        calls.append((name, arguments))
        return result
    }
}

@MainActor
struct MCPServerTests {
    @Test func disconnectRevokesExecutorWhileConfirmationIsPending() async {
        let executor = FakeExecutor()
        var sent = false
        let server = MCPServer(executor: executor, write: { _ in sent = true })
        _ = await server.respond(to: ["id": 1, "method": "initialize",
            "params": ["capabilities": ["elicitation": ["form": [:]]]]])
        sent = false
        let confirmation = Task { await server.confirm("Continue?", timeout: 60) }
        while !sent { await Task.yield() }
        server.disconnect()
        #expect(executor.disconnected)
        #expect(await confirmation.value == nil)
    }
    @Test func initializeNegotiatesVersion() async throws {
        let server = MCPServer(executor: FakeExecutor(), write: { _ in })
        let response = try #require(await server.respond(to: [
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": ["protocolVersion": "2025-06-18", "capabilities": [:], "clientInfo": ["name": "t", "version": "0"]]
        ]))
        let result = try #require(response["result"] as? [String: Any])
        #expect(result["protocolVersion"] as? String == "2025-06-18")
        #expect((result["serverInfo"] as? [String: Any])?["name"] as? String == "skfiy")
        #expect(result["instructions"] is String)

        let fallback = try #require(await server.respond(to: [
            "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": ["protocolVersion": "1999-01-01"]
        ]))
        #expect((fallback["result"] as? [String: Any])?["protocolVersion"] as? String == MCPServer.supportedProtocolVersions[0])
    }

    @Test func asksTheUserThroughElicitation() async throws {
        final class Outbox: @unchecked Sendable { var messages: [[String: Any]] = [] }
        let outbox = Outbox()
        let server = MCPServer(executor: FakeExecutor(), write: { data in
            outbox.messages.append((try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
        })
        // Without elicitation support the server cannot ask.
        #expect(await server.confirm("?", timeout: 1) == nil)

        _ = await server.respond(to: [
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": ["protocolVersion": "2025-11-25", "capabilities": ["elicitation": ["form": [:]]]]
        ])
        for (answer, expected) in [(["action": "accept", "content": ["allow": true]], true),
                                   (["action": "decline"], false)] as [([String: Any], Bool)] {
            let asking = Task { await server.confirm("Bring TextEdit forward?", timeout: 5) }
            while outbox.messages.last?["method"] as? String != "elicitation/create" {
                await Task.yield()
            }
            let request = outbox.messages.removeLast()
            #expect((request["params"] as? [String: Any])?["message"] as? String == "Bring TextEdit forward?")
            let reply = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": request["id"]!, "result": answer])
            await server.handle(line: String(decoding: reply, as: UTF8.self))
            #expect(await asking.value == expected)
        }
    }

    @Test func listsEveryToolWithAnObjectSchema() async throws {
        let server = MCPServer(executor: FakeExecutor(), write: { _ in })
        let response = try #require(await server.respond(to: ["jsonrpc": "2.0", "id": "a", "method": "tools/list"]))
        let tools = try #require((response["result"] as? [String: Any])?["tools"] as? [[String: Any]])
        let names = tools.compactMap { $0["name"] as? String }
        #expect(names == ComputerUse.toolNames)
        for tool in tools {
            let schema = try #require(tool["inputSchema"] as? [String: Any])
            #expect(schema["type"] as? String == "object")
            // Every tool definition must serialize as JSON.
            #expect(JSONSerialization.isValidJSONObject(tool))
        }
    }

    /// The lists the dispatch, the action log and the capability report use
    /// come from the tool definitions' traits; they must not drift.
    @Test func toolListsDerivedFromTraits() {
        #expect(ComputerUse.toolNames == [
            "list_apps", "get_desktop_status", "get_app_state", "get_app_capabilities", "click", "perform_secondary_action", "set_value",
            "select_text", "scroll", "drag", "press_key", "type_text", "open_file", "save_document", "zoom", "run_in_front",
            "file_dialog", "read_clipboard", "wait_for", "locate", "flow_start", "flow_record", "flow_status", "hand_over",
            "locked_use_status", "locked_use_end",
            "browser_tabs", "browser_open", "browser_state", "browser_locate", "browser_click", "browser_type",
            "browser_select", "browser_press_key", "browser_scroll", "browser_close_tab",
            "browser_upload", "browser_hover", "browser_downloads", "browser_wait"
        ])
        #expect(Set(ComputerUse.inputTools) == ["click", "perform_secondary_action", "set_value", "select_text", "drag", "press_key",
                                                "type_text", "open_file", "save_document", "run_in_front", "file_dialog"])
        #expect(Set(ComputerUse.verifiableTools) == ["click", "type_text", "press_key", "set_value", "scroll", "drag",
                                                     "perform_secondary_action", "select_text"])
        #expect(Set(ComputerUse.targetTools) == ["click", "scroll", "set_value", "perform_secondary_action", "select_text"])
        #expect(Set(ToolSchemas.names(.target, in: ToolSchemas.browser)) == ["browser_click", "browser_type", "browser_select",
                                                                             "browser_press_key", "browser_scroll", "browser_hover", "browser_upload"])
        #expect(Set(DirectLockedUse.lockedTools) == ["get_app_state", "click", "scroll", "drag", "press_key", "type_text", "wait_for", "zoom", "locate"])
        #expect(Set(ToolSchemas.names([.whileLocked, .refusedWhileLocked])) == [
            "get_app_state", "click", "perform_secondary_action", "set_value", "select_text", "scroll", "drag", "press_key", "type_text",
            "open_file", "save_document", "zoom", "run_in_front", "file_dialog", "wait_for", "locate", "read_clipboard"
        ])
        #expect(Set(ToolSchemas.names(.whileStopped)) == ["list_apps", "get_desktop_status", "get_app_capabilities"])
        #expect(ActionLog.recordedTools == [
            "click", "perform_secondary_action", "set_value", "select_text", "scroll", "drag", "press_key", "type_text",
            "open_file", "save_document", "run_in_front", "file_dialog", "read_clipboard", "hand_over",
            "browser_open", "browser_click", "browser_type", "browser_select", "browser_press_key", "browser_scroll",
            "browser_close_tab", "browser_upload", "browser_hover", "browser_downloads"
        ])
    }

    @Test func instructionsAndToolsStayWithinWhatClientsCarry() throws {
        // Claude Code shows the first 2048 characters of a server's
        // instructions; the rest would be dropped without a word.
        #expect(ToolSchemas.instructions.count <= 2048)
        // Each tool's definition enters the model's context when it is used.
        for tool in ToolSchemas.all {
            let size = try JSONSerialization.data(withJSONObject: tool.definition).count
            #expect(size <= 4096, "\(tool.name) is \(size) bytes")
        }
    }

    @Test func toolCallReturnsTextAndImageContent() async throws {
        let executor = FakeExecutor()
        executor.result = ToolResult(text: "clicked", image: Data([1, 2, 3]), imageMimeType: "image/png")
        let server = MCPServer(executor: executor, write: { _ in })
        let response = try #require(await server.respond(to: [
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": ["name": "click", "arguments": ["app": "TextEdit", "element_index": "3"]]
        ]))
        let result = try #require(response["result"] as? [String: Any])
        let content = try #require(result["content"] as? [[String: Any]])
        #expect(content[0]["text"] as? String == "clicked")
        #expect(content[1]["type"] as? String == "image")
        #expect(content[1]["data"] as? String == Data([1, 2, 3]).base64EncodedString())
        #expect(content[1]["mimeType"] as? String == "image/png")
        #expect(result["isError"] as? Bool == false)
        #expect(executor.calls.first?.0 == "click")
        #expect(executor.calls.first?.1["element_index"] as? String == "3")
    }

    @Test func unknownToolAndMethodAreProtocolErrors() async throws {
        let server = MCPServer(executor: FakeExecutor(), write: { _ in })
        let tool = try #require(await server.respond(to: [
            "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": "rm_rf"]
        ]))
        #expect((tool["error"] as? [String: Any])?["code"] as? Int == -32602)
        let method = try #require(await server.respond(to: ["jsonrpc": "2.0", "id": 2, "method": "nope"]))
        #expect((method["error"] as? [String: Any])?["code"] as? Int == -32601)
    }

    @Test func notificationsGetNoResponse() async {
        let server = MCPServer(executor: FakeExecutor(), write: { _ in })
        let response = await server.respond(to: ["jsonrpc": "2.0", "method": "notifications/initialized"])
        #expect(response == nil)
    }

    @Test func handleLineWritesOneJSONLinePerRequest() async throws {
        var written: [Data] = []
        let server = MCPServer(executor: FakeExecutor(), write: { written.append($0) })
        await server.handle(line: "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}")
        await server.handle(line: "not json")
        await server.handle(line: "   ")
        #expect(written.count == 2)
        let ping = try #require(try JSONSerialization.jsonObject(with: written[0]) as? [String: Any])
        #expect(ping["id"] as? Int == 1)
        let parseError = try #require(try JSONSerialization.jsonObject(with: written[1]) as? [String: Any])
        #expect((parseError["error"] as? [String: Any])?["code"] as? Int == -32700)
        #expect(!String(decoding: written[0], as: UTF8.self).contains("\n"))
    }
}

struct ArgumentsTests {
    @Test func elementIndexAcceptsStringsNumbersAndBrackets() throws {
        #expect(try Arguments(["element_index": "12"]).elementIndex() == 12)
        #expect(try Arguments(["element_index": 12]).elementIndex() == 12)
        #expect(try Arguments(["element_index": "[12]"]).elementIndex() == 12)
        #expect(try Arguments([:]).elementIndex() == nil)
        #expect(throws: ToolError.self) { try Arguments(["element_index": "abc"]).elementIndex() }
    }

    @Test func numbersAcceptNumericStringsButNotBooleans() throws {
        #expect(try Arguments(["x": 10.5]).double("x") == 10.5)
        #expect(try Arguments(["x": "7"]).double("x") == 7)
        #expect(throws: ToolError.self) { try Arguments(["x": true]).double("x") }
        #expect(throws: ToolError.self) { try Arguments(["n": 1.5]).int("n") }
    }

    @Test func textKeepsWhitespace() throws {
        #expect(try Arguments(["text": "  a\n"]).requiredText("text") == "  a\n")
        #expect(throws: ToolError.self) { try Arguments(["app": "  "]).requiredString("app") }
    }
}

@MainActor
final class SlowExecutor: ToolExecutor {
    var sawCancellation = false
    func call(_ name: String, _ arguments: [String: Any]) async -> ToolResult {
        for _ in 0..<500 {
            if Task.isCancelled { sawCancellation = true; return ToolResult(text: "cancelled", isError: true) }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return ToolResult(text: "finished")
    }
}

@MainActor
struct MCPCancellationTests {
    @Test func cancelledCallStopsAndGetsNoResponse() async throws {
        let executor = SlowExecutor()
        let server = MCPServer(executor: executor, write: { _ in })
        let started = Date()
        let call = Task { await server.respond(to: ["jsonrpc": "2.0", "id": 7, "method": "tools/call",
                                                    "params": ["name": "wait_for", "arguments": ["app": "X"]]]) }
        try await Task.sleep(nanoseconds: 100_000_000)
        let line = #"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"user"}}"#
        let id = try #require(MCPServer.cancellation(line))
        server.cancel(id)
        let response = await call.value
        #expect(response == nil)
        #expect(executor.sawCancellation)
        #expect(Date().timeIntervalSince(started) < 2)
        // Other lines are not cancellations; unknown ids are ignored.
        #expect(MCPServer.cancellation(#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#) == nil)
        server.cancel("12345")
    }
}
