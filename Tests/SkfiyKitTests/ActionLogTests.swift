import Foundation
import Testing
@testable import SkfiyKit

struct ActionLogTests {
    @Test func failedReadsAndMissingScreenshotsAreDiagnosableWithoutLoggingSuccessfulLooks() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-log-reads-\(UUID().uuidString).jsonl")
        defer { try? FileManager.default.removeItem(at: file) }
        let log = ActionLog(file: file)
        log.record(tool: "get_app_state", arguments: ["app": "Fixture"], result: ToolResult(text: "private UI tree"), secret: false)
        for tool in ["get_app_state", "zoom", "browser_wait"] {
            log.record(tool: tool, arguments: ["app": "Fixture"], result: ToolResult(text: "capture unavailable", isError: true), secret: false, duration: 1.25)
        }
        log.record(tool: "get_app_state", arguments: ["app": "Fixture", "window": "42"],
                   result: ToolResult(text: "App: Fixture\nprivate UI tree", structuredContent: ["capture_error": "independent capture timed out", "capture": false]), secret: false)
        let text = try String(contentsOf: file, encoding: .utf8)
        let entries = try text.split(separator: "\n").map { try #require(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
        #expect(entries.count == 4)
        #expect(!text.contains("private UI tree"))
        #expect(entries[0]["duration_ms"] as? Int == 1250)
        #expect(entries[0]["build"] as? String == ActionLog.buildID)
        #expect(entries[3]["capture_error"] as? String == "independent capture timed out")
        #expect(log.recent(1)[0].contains("⚠ get_app_state"))
    }

    @Test func structuredExpectationsAndTargetsSurviveLoggingWithinBounds() throws {
        let recorded = ActionLog.recordedArguments([
            "expect": ["changed": true, "timeout": 8],
            "target": ["name": "Apply", "region": [10, 20, 30, 40]],
            "text": String(repeating: "x", count: 600),
        ], secret: false)
        #expect((recorded["expect"] as? [String: Any])?["timeout"] as? Int == 8)
        #expect((recorded["target"] as? [String: Any])?["region"] as? [Int] == [10, 20, 30, 40])
        #expect((recorded["text"] as? String)?.count == 500)
        #expect(JSONSerialization.isValidJSONObject(recorded))
        let privateArguments = ActionLog.recordedArguments(["app": "Screen Sharing", "expect": ["value": "secret-marker"], "text": "secret-marker"], secret: true)
        #expect(!String(decoding: try JSONSerialization.data(withJSONObject: privateArguments), as: UTF8.self).contains("secret-marker"))
    }

    @Test(arguments: ["com.apple.ScreenSharing", "Screen Sharing", "屏幕共享"]) @MainActor
    func remoteInputIsRedactedWhenExpectationParsingFailsBeforeDispatch(app: String) async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-log-preflight-\(UUID().uuidString).jsonl")
        defer { try? FileManager.default.removeItem(at: file) }
        let computer = ComputerUse()
        computer.actionLog = ActionLog(file: file)
        let result = await computer.call("type_text", ["app": app, "text": "preflight-secret-marker", "expect": ["timeout": 2]])
        #expect(result.isError && result.text.contains("expect needs at least one condition"))
        let text = try String(contentsOf: file, encoding: .utf8)
        #expect(!text.contains("preflight-secret-marker"))
        #expect(text.contains("redacted"))
        #expect(text.contains("\"validation_error\":\"expect\""))
    }

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
        #expect(text.contains("(7 characters, redacted)"))
        #expect(!text.contains("Screenshot"))
        let lines = log.recent(10)
        #expect(lines.count == 3)
        #expect(lines[0].contains("✔ type_text  app=TextEdit text=hello"))
        #expect(lines[2].contains("✘ click"))
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func secretKeyboardArgumentsAreRedactedEvenWhenRefused() {
        let recorded = ActionLog.recordedArguments(["app": "Test", "key": "private-key-text"], secret: true)
        #expect(recorded["key"] as? String == "(16 characters, redacted)")
        #expect(recorded["app"] as? String == "Test")
    }

    @Test(arguments: [false, true]) func secretResultsCannotEchoInput(isError: Bool) throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-log-secret-\(UUID().uuidString).jsonl")
        defer { try? FileManager.default.removeItem(at: file) }
        let log = ActionLog(file: file)
        let secretKey = "private-malformed-key-marker"
        log.record(tool: "press_key", arguments: ["app": "Test", "key": secretKey],
                   result: ToolResult(text: "Invalid key: \(secretKey)", isError: isError), secret: true)

        let data = try Data(contentsOf: file)
        #expect(!String(decoding: data, as: UTF8.self).contains(secretKey))
        let entry = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(entry["result"] as? String == "(redacted)")
        #expect(entry["error"] as? Bool == isError)
    }
}
