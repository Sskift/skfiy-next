import Foundation
import Testing
@testable import SkfiyKit

struct RemoteDesktopTests {
    let frame = String(repeating: "a", count: 32)

    @Test func sshHasNoInteractiveFallbackOrShellInterpolation() throws {
        let arguments = try RemoteDesktop.sshArguments(host: "lil-win")
        #expect(arguments.contains("BatchMode=yes"))
        #expect(arguments.contains("StrictHostKeyChecking=yes"))
        #expect(arguments[arguments.count - 2] == "lil-win")
        for bad in ["-oProxyCommand=x", "host;touch x", "a\nb", "$(hostname)", "host x"] {
            #expect(throws: ToolError.self) { try RemoteDesktop.validateHost(bad) }
        }
    }

    @Test func inputsRequireFreshFrameAndValidateBeforeTransport() throws {
        let state = try RemoteDesktop.request(Arguments(["host": "test", "action": "state"]))
        #expect(state["frame_id"] == nil)
        let click = try RemoteDesktop.request(Arguments(["host": "test", "action": "click", "frame_id": frame, "x": 12, "y": 34]))
        #expect(click["button"] as? String == "left")
        #expect(click["count"] as? Int == 1)
        for bad: [String: Any] in [
            ["action": "click", "x": 1, "y": 1],
            ["action": "click", "frame_id": frame, "x": -1, "y": 1],
            ["action": "click", "frame_id": frame, "x": 1.5, "y": 1],
            ["action": "click", "frame_id": frame, "x": 1, "y": 1, "count": 3],
            ["action": "scroll", "frame_id": frame, "x": 1, "y": 1, "direction": "down", "amount": 99],
            ["action": "type", "frame_id": frame, "text": "x", "key": "enter"],
            ["action": "type", "frame_id": frame, "text": "\0"],
            ["action": "state", "text": "accidental input"],
            ["action": "exec", "command": "whoami"]
        ] { #expect(throws: ToolError.self) { try RemoteDesktop.request(Arguments(bad)) } }
        let text = "中文 A!9 😀"
        #expect(try RemoteDesktop.request(Arguments(["action": "type", "frame_id": frame, "text": text]))["text"] as? String == text)
    }

    @Test func embeddedScriptsMatchReviewedSources() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        for (name, script) in [("worker", RemoteDesktopScripts.worker), ("transport", RemoteDesktopScripts.transport)] {
            #expect(try String(contentsOf: root.appendingPathComponent("remote-windows/\(name).ps1"), encoding: .utf8) == script)
        }
    }

    @Test func remoteContentIsRedactedAndStateIsNotLogged() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let log = ActionLog(file: directory.appendingPathComponent("actions.jsonl"))
        log.record(tool: "remote_desktop", arguments: ["action": "state"], result: ToolResult(text: "private screen"), secret: true)
        #expect(!FileManager.default.fileExists(atPath: log.file.path))
        log.record(tool: "remote_desktop", arguments: ["action": "type", "text": "private text"], result: ToolResult(text: "private screen"), secret: true)
        let recorded = try String(contentsOf: log.file, encoding: .utf8)
        #expect(!recorded.contains("private text") && !recorded.contains("private screen"))
    }
}
