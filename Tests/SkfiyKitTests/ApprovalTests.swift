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
        #expect(ApprovalMode(nil) == .ask)
        #expect(ApprovalMode("ask") == .ask)
        #expect(ApprovalMode("1") == .ask)
    }

    @Test func doctorKnowsTheSetting() {
        #expect(Setup.settingWarnings(environment: ["SKFIY_APPROVE": "all"]).isEmpty)
        #expect(Setup.settingWarnings(environment: ["SKFIY_APPROVE": "yes"]).first?.text.contains("SKFIY_APPROVE=yes") == true)
    }
}
