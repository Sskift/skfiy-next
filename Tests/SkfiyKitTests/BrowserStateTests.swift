import Foundation
import Testing
@testable import SkfiyKit

struct BrowserStateTests {
    private var geometry: [String: Any] {
        ["document": "doc-a", "url": "https://fixture.invalid/", "width": 2000, "height": 1000, "x": 0, "y": 0, "scale": 2, "revision": 1]
    }

    @Test func tabIdentityIncludesBrowserAndAmbiguityIsRefused() throws {
        let a = ConnectedBrowser(socketPath: "/a", name: "Chrome", pid: 10)
        let b = ConnectedBrowser(socketPath: "/b", name: "Chrome", pid: 11)
        #expect(BrowserTab(a, 7) != BrowserTab(b, 7))
        #expect(throws: ToolError.self) { try BrowserTools.uniqueBrowser([a, b]) }
        #expect(try BrowserTools.uniqueBrowser([b]).pid == 11)
    }

    @Test func screenshotMappingExpiresForDocumentGeometryContentAndTime() throws {
        let original = try #require(BrowserGeometry(geometry))
        let captured = Date(timeIntervalSince1970: 10)
        let shot = BrowserScreenshot(geometry: original, width: 1000, height: 500, captured: captured)
        #expect(shot.matches(original, now: captured.addingTimeInterval(29)))
        #expect(!shot.matches(original, now: captured.addingTimeInterval(30)))
        let point = try shot.point(x: 450, y: 112)
        #expect(point.0 == 900 && point.1 == 224)
        for (key, value): (String, Any) in [("document", "doc-b"), ("url", "https://next.invalid/"), ("width", 1000), ("height", 700), ("y", 100), ("scale", 1), ("revision", 2)] {
            var changed = geometry; changed[key] = value
            #expect(!shot.matches(BrowserGeometry(changed), now: captured))
        }
        #expect(throws: ToolError.self) { try shot.point(x: -1, y: 1) }
        #expect(throws: ToolError.self) { try shot.point(x: 1000, y: 1) }
        #expect(throws: ToolError.self) { try shot.point(x: .nan, y: 1) }
    }

    @Test @MainActor func duplicateTabIDsNeverChooseTheFirstBrowser() async throws {
        let browsers = [10, 11].map { ConnectedBrowser(socketPath: "/fixture/\($0)", name: "Chrome", pid: $0, snapshotProtocol: 2) }
        var sent = 0
        let tools = BrowserTools(discover: { browsers }, request: { _, method, _, _ in
            if method == "tabs" { return [["tabs": [["id": 7]]]] }
            sent += 1
            throw ToolError("must not dispatch")
        })
        let result = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
        #expect(result.isError && result.text.contains("ambiguous") && sent == 0)
        #expect((result.structuredContent?["action"] as? [String: String])?["status"] == "not_sent")
        let unavailable = BrowserTools(discover: { browsers }, request: { browser, method, _, _ in
            guard method == "tabs" else { sent += 1; throw ToolError("must not dispatch") }
            if browser.pid == 11 { throw ToolError("connection lost") }
            return [["tabs": [["id": 7]]]]
        })
        let uncertain = try await unavailable.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
        #expect(uncertain.isError && uncertain.text.contains("Specify browser explicitly") && sent == 0)
    }

    @Test @MainActor func lostAcknowledgementAndFailedStateNeverInviteAnotherSubmit() async throws {
        for loseReply in [true, false] {
            let browser = ConnectedBrowser(socketPath: "/fixture", name: "Fixture", pid: 10, snapshotProtocol: 2)
            var sent = 0
            var failState = false
            let tools = BrowserTools(discover: { [browser] }, request: { _, method, _, _ in
                switch method {
                case "state":
                    if failState { failState = false; throw ToolError("state unavailable") }
                    return ["snapshot_id": "snapshot", "tabId": 7, "lines": ["[0] button Submit"], "viewport": ["width": 800, "height": 600]]
                case "observe": return ["text": "Ready", "treeText": "Ready", "label": "Submit", "identity": "submit-button"]
                case "act":
                    sent += 1
                    if loseReply { throw ToolError("connection lost") }
                    failState = true
                    return ["action_status": "sent", "message": "Clicked Submit"]
                default: throw ToolError("unexpected method")
                }
            })
            _ = try await tools.call("browser_state", Arguments(["tab_id": 7, "screenshot": false]))
            let first = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
            #expect(first.isError && sent == 1)
            #expect((first.structuredContent?["action"] as? [String: String])?["status"] == (loseReply ? "unknown" : "sent"))
            let repeatCall = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
            #expect(repeatCall.isError && repeatCall.text.contains("browser_state or browser_wait") && sent == 1)
            _ = try await tools.call("browser_state", Arguments(["tab_id": 7, "screenshot": false]))
            _ = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
            #expect(sent == 2)
        }
    }

    @Test @MainActor func metadataAndLoadingCannotProveAnEffect() async throws {
        for loading in [false, true] {
            let browser = ConnectedBrowser(socketPath: "/fixture", name: "Fixture", pid: 10, snapshotProtocol: 2)
            var sent = false
            let tools = BrowserTools(discover: { [browser] }, request: { _, method, params, _ in
                switch method {
                case "state": return ["snapshot_id": "snapshot", "tabId": 7, "lines": ["[0] button Noop"]]
                case "observe":
                    var raw: [String: Any] = ["text": "Ready", "treeText": "Ready", "label": "Noop", "identity": "noop",
                        "loading": loading && sent]
                    if loading && sent { raw["text"] = ""; raw["treeText"] = "" }
                    if params["include_target"] as? Bool == true { raw["value"] = "" }
                    return raw
                case "act": sent = true; return ["action_status": "sent"]
                default: throw ToolError("unexpected method")
                }
            })
            _ = try await tools.call("browser_state", Arguments(["tab_id": 7, "screenshot": false]))
            let expectation: [String: Any] = loading ? ["text_gone": "Ready", "timeout": 0.2] : ["changed": true, "timeout": 0.2]
            let result = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0, "expect": expectation]))
            #expect(result.isError && sent)
            #expect((result.structuredContent?["verification"] as? [String: String])?["status"] == (loading ? "timeout" : "no_effect"))
        }
    }
}
