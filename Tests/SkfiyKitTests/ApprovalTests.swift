import Testing
@testable import SkfiyKit

@Suite struct ApprovalTests {
    @Test func acceptingTheFormApproves() {
        #expect(MCPServer.approval(["action": "accept", "content": ["allow": true]]))
        // Clients that send no content for an accepted form.
        #expect(MCPServer.approval(["action": "accept"]))
        #expect(MCPServer.approval(["action": "accept", "content": [String: Any]()]))
    }

    @Test func refusing() {
        #expect(!MCPServer.approval(["action": "accept", "content": ["allow": false]]))
        #expect(!MCPServer.approval(["action": "decline"]))
        #expect(!MCPServer.approval(["action": "cancel"]))
        #expect(!MCPServer.approval([:]))
    }

    /// Claude Code submits the field's default when the user just accepts; a default of false turned
    /// every accept into a refusal.
    @Test func theSwitchStartsOn() {
        let schema = MCPServer.approvalSchema(field: "Done")
        let field = (schema["properties"] as? [String: Any])?["allow"] as? [String: Any]
        #expect(field?["default"] as? Bool == true)
        #expect(field?["title"] as? String == "Done")
    }

    @Test func mode() {
        #expect(ApprovalMode("all") == .all)
        #expect(ApprovalMode("bypass") == .all)
        #expect(ApprovalMode(nil) == .ask)
        #expect(ApprovalMode("ask") == .ask)
        #expect(ApprovalMode("1") == .ask)
    }

    @Test func doctorKnowsTheSetting() {
        #expect(Setup.settingWarnings(environment: ["SKFIY_APPROVE": "all"]).isEmpty)
        #expect(Setup.settingWarnings(environment: ["SKFIY_APPROVE": "bypass"]).isEmpty)
        #expect(Setup.settingWarnings(environment: ["SKFIY_APPROVE": "yes"]).first?.text.contains("SKFIY_APPROVE=yes") == true)
    }

    @MainActor @Test(arguments: [ApprovalMode.ask, .all])
    func sessionUsesItsApprovalMode(_ mode: ApprovalMode) async throws {
        let computer = ComputerUse(approvalMode: mode)
        var prompts = 0
        computer.askUser = { _ in prompts += 1; return false }
        computer.waitForUser = { _ in prompts += 1; return true }
        var written = 0
        let server = MCPServer(executor: computer, write: { _ in written += 1 })
        let reply = try #require(await server.respond(to: ["id": 1, "method": "initialize",
            "params": ["capabilities": ["elicitation": ["form": [:]]]]]))
        let instructions = try #require((reply["result"] as? [String: Any])?["instructions"] as? String)
        #expect(instructions.contains("Ask the user before purchases") == (mode == .ask))
        #expect(instructions.contains("SKFIY_APPROVE=all") == (mode == .all))

        #expect(await computer.approve("Use brief focus?") == (mode == .all))
        let step = "Scan the sign-in QR code."
        let handoff = try await computer.handOver(Arguments(["message": step]))
        if mode == .all {
            #expect(handoff.isError && handoff.structuredContent?["status"] as? String == "manual_input_required")
            #expect(handoff.structuredContent?["message"] as? String == step && handoff.text.contains(step))
            #expect(prompts == 0)
            // Even a direct call to the transport cannot open a form in this mode.
            #expect(await server.confirm("Continue?", timeout: 0.01) == nil)
            #expect(written == 0)
        } else {
            #expect(!handoff.isError && handoff.text == "The user says it is done.")
            #expect(prompts == 2)
        }
    }

    @MainActor @Test func clipboardWithoutAnInteractiveClient() async throws {
        let contents = ClipboardContents.text("fixture text")
        let args = Arguments(["reason": "test"])
        let preapproved = ComputerUse(approvalMode: .all)
        let read = try await preapproved.readClipboard(args, contents: contents)
        #expect(preapproved.clipboard == contents && read.text.contains("fixture text"))

        let interactive = ComputerUse(approvalMode: .ask)
        await #expect(throws: ToolError.self) { try await interactive.readClipboard(args, contents: contents) }
        #expect(interactive.clipboard == nil)
    }
}
