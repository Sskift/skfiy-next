import Foundation
import Testing
@testable import SkfiyKit

struct ActionLogTests {
    @Test func recordsActionsNotLooksAndMasksPasswords() throws {
        let path = "/tmp/skfiy-log-test-\(getpid())-\(UUID().uuidString).jsonl"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let log = ActionLog(file: URL(fileURLWithPath: path))
        log.record(tool: "get_app_state", arguments: ["app": "TextEdit"], result: ToolResult(text: "App: TextEdit"), secret: false)
        log.record(tool: "type_text", arguments: ["app": "TextEdit", "text": "hello"], result: ToolResult(text: "Typed 5 character(s)\nScreenshot…"), secret: false)
        log.record(tool: "type_text", arguments: ["app": "Safari", "text": "hunter2"], result: ToolResult(text: "Typed 7 character(s)"), secret: true)
        log.record(tool: "click", arguments: ["app": "Finder", "element_index": "4"], result: ToolResult(text: "No such element", isError: true), secret: false)
        let text = try String(contentsOfFile: path, encoding: .utf8)
        #expect(!text.contains("get_app_state"))
        #expect(!text.contains("hunter2"))
        #expect(text.contains("(7 characters, password field)"))
        #expect(!text.contains("Screenshot"))
        let lines = log.recent(10)
        #expect(lines.count == 3)
        #expect(lines[0].contains("✔ type_text  app=TextEdit text=hello"))
        #expect(lines[2].contains("✘ click"))
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
}
