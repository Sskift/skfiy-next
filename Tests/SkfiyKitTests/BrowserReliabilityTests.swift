import Foundation
import Testing
@testable import SkfiyKit

struct BrowserReliabilityTests {
    private var browser: ConnectedBrowser { ConnectedBrowser(socketPath: "/fixture", name: "Fixture", pid: 10, snapshotProtocol: 2) }
    private var page: [String: Any] { ["snapshot_id": "snapshot", "tabId": 7, "lines": ["Processing", "[0] button Submit"]] }

    @Test @MainActor func navigationReceiptSurvivesUnreadableDestinationWithoutRepeatingNavigation() async throws {
        let cases: [[String: Any]] = [["url": "https://fixture.invalid/"],
                                      ["url": "https://fixture.invalid/", "tab_id": 7],
                                      ["action": "reload", "tab_id": 7]]
        for arguments in cases {
            var navigations = 0
            let tools = BrowserTools(discover: { [browser] }, request: { _, method, _, _ in
                if method == "open" || method == "navigate" { navigations += 1; return ["tabId": 7] }
                if method == "state" { throw ToolError("Frame with ID 0 is showing error page") }
                throw ToolError("unexpected method")
            })
            let result = try await tools.call("browser_open", Arguments(arguments))
            #expect(result.isError && navigations == 1)
            #expect((result.structuredContent?["action"] as? [String: String])?["status"] == "sent")
            #expect(result.structuredContent?["tab_id"] as? Int == 7)
            #expect(result.structuredContent?["state_error"] as? String == "Frame with ID 0 is showing error page")
            #expect(result.text.contains("tab 7") && result.text.contains("browser_state"))
        }
    }

    @Test @MainActor func unreadableWaitCannotSucceedOrClearRepeatProtection() async throws {
        var sent = 0
        var readable = false
        let tools = BrowserTools(discover: { [browser] }, request: { _, method, _, _ in
            switch method {
            case "state": return page
            case "observe": return ["text": "Processing", "label": "Submit", "identity": "submit"]
            case "probe": return ["loading": !readable, "found": false, "quietMs": 1000]
            case "act": sent += 1; return ["action_status": "sent", "message": "Clicked"]
            default: throw ToolError("unexpected method")
            }
        })
        _ = try await tools.call("browser_state", Arguments(["tab_id": 7, "screenshot": false]))
        _ = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
        let result = try await tools.call("browser_wait", Arguments(["tab_id": 7, "text": "Processing", "gone": true, "timeout": 0.5]))
        #expect(result.isError && !result.text.contains("was gone"))
        let again = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
        #expect(again.isError && sent == 1)
        readable = true
        let valid = try await tools.call("browser_wait", Arguments(["tab_id": 7, "text": "Processing", "gone": true, "timeout": 0.5]))
        #expect(!valid.isError)
        _ = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0]))
        #expect(sent == 2)
    }

    @Test @MainActor func uploadReceiptSurvivesReadFailureLostAckAndCancellation() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-upload-\(UUID()).txt")
        try Data("fixture".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        for mode in ["state-error", "lost-ack", "cancelled", "not-sent"] {
            var commits = 0
            let tools = BrowserTools(discover: { [browser] }, request: { _, method, params, _ in
                switch method {
                case "state":
                    if commits > 0 { throw ToolError("state unavailable") }
                    return page
                case "observe":
                    #expect(params["upload_count"] as? Int == 1)
                    return ["upload_token": "owned-input", "origin": "https://upload.fixture.invalid"]
                case "act":
                    #expect(params["upload_token"] as? String == "owned-input")
                    guard params["action"] as? String == "upload-commit" else { return ["action_status": "sent"] }
                    if mode == "not-sent" { throw BrowserActionFailure(status: "not_sent", description: "stale target") }
                    commits += 1
                    if mode == "lost-ack" { throw ToolError("connection lost") }
                    if mode == "cancelled" { throw CancellationError() }
                    return ["action_status": "sent", "message": "Attached fixture"]
                default: throw ToolError("unexpected method")
                }
            })
            tools.approve = { prompt in
                #expect(prompt.contains("https://upload.fixture.invalid"))
                return true
            }
            _ = try await tools.call("browser_state", Arguments(["tab_id": 7, "screenshot": false]))
            let result = try await tools.call("browser_upload", Arguments(["tab_id": 7, "index": 0, "path": file.path]))
            let status = (result.structuredContent?["action"] as? [String: String])?["status"]
            #expect(result.isError)
            #expect(commits == (mode == "not-sent" ? 0 : 1))
            #expect(status == (mode == "state-error" ? "sent" : mode == "not-sent" ? "not_sent" : "unknown"))
            if mode == "state-error" { #expect(result.text.contains("Attached fixture") && result.structuredContent?["state_error"] != nil) }
            if mode == "not-sent" { #expect(result.text.contains("No file was attached") && !result.text.contains("may already be attached")) }
        }
    }

    @Test @MainActor func discoveryAndProbesShareTheWaitBudget() async throws {
        var probeLimit: Double = 0
        var states = 0
        let tools = BrowserTools(discover: {
            try? await Task.sleep(nanoseconds: 150_000_000)
            return [browser]
        }, request: { _, method, _, timeout in
            if method == "state" { states += 1; return page }
            #expect(method == "probe")
            probeLimit = timeout
            try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            throw BrowserDeadlineExceeded()
        })
        let start = ProcessInfo.processInfo.systemUptime
        let result = try await tools.call("browser_wait", Arguments(["tab_id": 7, "text": "Ready", "timeout": 2.0]))
        #expect(result.isError && states == 0)
        #expect(probeLimit > 0 && probeLimit < 1.9)
        #expect(ProcessInfo.processInfo.systemUptime - start < 3)
    }

    @Test @MainActor func downloadDiscoveredAfterTenSecondsCanUseTheRemainingBudget() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-delayed-\(UUID()).txt")
        try Data().write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let start = ProcessInfo.processInfo.systemUptime
        let lastAction = Date()
        let item: [String: Any] = ["id": 3, "state": "complete", "path": file.path, "exists": true,
                                   "started": ISO8601DateFormatter().string(from: lastAction.addingTimeInterval(10.2))]
        let tools = BrowserTools(discover: { [browser] }, request: { _, method, _, _ in
            if method == "download_get" { return item }
            #expect(method == "downloads")
            return ["downloads": ProcessInfo.processInfo.systemUptime - start >= 10.2 ? [item] : [], "lastAct": lastAction.timeIntervalSince1970 * 1000]
        })
        let result = try await tools.call("browser_downloads", Arguments(["action": "wait", "timeout": 15]))
        #expect(!result.isError && result.text.contains(file.path))
    }

    @Test @MainActor func failedCaptureIncludesTheReasonAndNeverDispatchesOldCoordinates() async throws {
        var captures = 0
        let tools = BrowserTools(discover: { [browser] }, request: { _, method, _, _ in
            if method == "state" { return ["snapshot_id": "fresh", "tabId": 7, "active": true, "lines": ["[0] button Pick"]] as [String: Any] }
            #expect(method == "screenshot")
            captures += 1
            throw ToolError("fixture capture unavailable")
        })
        let state = try await tools.call("browser_state", Arguments(["tab_id": 7]))
        #expect(!state.isError && state.structuredContent?["capture_error"] as? String == "fixture capture unavailable")
        let refused = try await tools.call("browser_click", Arguments(["tab_id": 7, "x": 1, "y": 1]))
        #expect(refused.isError && refused.text.contains("button Pick") && refused.image == nil && captures == 2)
        #expect((refused.structuredContent?["action"] as? [String: String])?["status"] == "not_sent")
        #expect(refused.structuredContent?["capture_error"] as? String == "fixture capture unavailable")
    }

    @Test @MainActor func shortExpectationBoundsObservationAndPreservesSentReceipt() async throws {
        var sent = false
        var observationLimit: Double = 0
        let tools = BrowserTools(discover: { [browser] }, request: { _, method, _, timeout in
            switch method {
            case "state": return page
            case "act": sent = true; return ["action_status": "sent"]
            case "observe":
                if sent {
                    observationLimit = timeout
                    try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    throw BrowserDeadlineExceeded()
                }
                return ["text": "Processing", "label": "Submit", "identity": "submit"]
            default: throw ToolError("unexpected method")
            }
        })
        _ = try await tools.call("browser_state", Arguments(["tab_id": 7, "screenshot": false]))
        let start = ProcessInfo.processInfo.systemUptime
        let result = try await tools.call("browser_click", Arguments(["tab_id": 7, "index": 0, "expect": ["text": "Saved", "timeout": 0.2]]))
        #expect(result.isError && sent && observationLimit <= 0.2)
        #expect((result.structuredContent?["action"] as? [String: String])?["status"] == "sent")
        #expect((result.structuredContent?["verification"] as? [String: String])?["status"] == "timeout")
        #expect(ProcessInfo.processInfo.systemUptime - start < 1)
    }
}
