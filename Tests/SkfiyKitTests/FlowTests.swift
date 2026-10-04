import Foundation
import Testing
@testable import SkfiyKit

struct FlowTests {
    private func temporary() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-flow-\(UUID().uuidString)", isDirectory: true)
    }

    @Test func parsesStepsAndProofs() throws {
        let steps = try FlowRecord.steps(["Download the report", ["id": "open", "title": "Open it"], "Process"])
        #expect(steps.map(\.id) == ["1", "open", "3"])
        #expect(throws: ToolError.self) { try FlowRecord.steps([]) }
        #expect(throws: ToolError.self) { try FlowRecord.steps([["id": "a", "title": "x"], ["id": "a", "title": "y"]]) }
        let record = FlowRecord(name: "f", goal: nil, steps: steps, created: Date(), updated: Date())
        #expect(record.index(of: "open") == 1 && record.index(of: "3") == 2 && record.index(of: "download the report") == 0 && record.index(of: "nope") == nil)

        let file = try FlowProof(["file": "~/x.txt", "contains": "total"])
        #expect(file.file == NSString("~/x.txt").expandingTildeInPath && file.contains == "total")
        #expect(try FlowProof(["tab_id": 12, "text": "Done"]).summary == "tab 12 showing \"Done\"")
        #expect(try FlowProof(["app": "TextEdit", "window": "a.txt"]).summary == "TextEdit window \"a.txt\"")
        #expect(throws: ToolError.self) { try FlowProof(["text": "Saved"]) }
        #expect(throws: ToolError.self) { try FlowProof(["window": "a"]) }
        #expect(throws: ToolError.self) { try FlowProof(["file": "relative.txt"]) }
        #expect(throws: ToolError.self) { try FlowProof(["files": "/x"]) }
        #expect(throws: ToolError.self) { try FlowProof(nil) }
        #expect(throws: ToolError.self) { try FlowStore.validName("../escape") }
    }

    @Test func storeKeepsFlowsAcrossProcesses() throws {
        let store = FlowStore(directory: temporary())
        defer { try? FileManager.default.removeItem(at: store.directory) }
        var record = FlowRecord(name: "monthly report", goal: "g", steps: try FlowRecord.steps(["a", "b"]), created: Date(), updated: Date())
        record.steps[0].status = .done
        record.steps[0].proof = FlowProof(file: "/tmp/x", sha256: "ab")
        record.steps[0].identity = ["pid": "42"]
        try store.save(record)
        let loaded = try #require(try store.load("monthly report"))
        #expect(loaded.steps == record.steps && loaded.goal == "g")
        #expect(store.names() == ["monthly report"])
        #expect(try store.load("other") == nil)
    }

    @Test func fileProofsNoticeChangeAndRemoval() throws {
        let directory = temporary()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("data.txt").path
        try "alpha beta\n".write(toFile: path, atomically: true, encoding: .utf8)
        let (recorded, enriched) = FlowProof(file: path, contains: "beta").checkFile(recording: true)
        guard case .holds = recorded else { Issue.record("\(recorded)"); return }
        #expect(enriched.sha256?.count == 64)
        guard case .holds = enriched.checkFile(recording: false).0 else { Issue.record("unchanged file should hold"); return }
        try "alpha beta gamma\n".write(toFile: path, atomically: true, encoding: .utf8)
        #expect(enriched.checkFile(recording: false).0 == .broken("the file \(path) has different content than when it was recorded"))
        try FileManager.default.removeItem(atPath: path)
        #expect(enriched.checkFile(recording: false).0 == .broken("the file \(path) is not there any more"))
        try "x\n".write(toFile: path, atomically: true, encoding: .utf8)
        #expect(FlowProof(file: path, contains: "beta").checkFile(recording: false).0 == .broken("the file \(path) does not contain \"beta\""))
    }

    private func flow(_ statuses: [FlowRecord.Status]) -> FlowRecord {
        var record = FlowRecord(name: "dl", goal: "download, open, process",
                                steps: [.init(id: "download", title: "Download"), .init(id: "open", title: "Open"), .init(id: "process", title: "Process")],
                                created: Date(), updated: Date())
        for (index, status) in statuses.enumerated() {
            record.steps[index].status = status
            record.steps[index].proof = status == .todo ? nil : FlowProof(file: "/tmp/f\(index)")
        }
        return record
    }

    @Test func resumesAfterTheLastVerifiedStep() {
        let (report, updated) = FlowReport.evaluate(flow([.done, .done, .todo]), checks: [0: .holds("file ok"), 1: .holds("window open")])
        #expect(!report.needsReplan && !report.complete && report.next == "3. Process")
        #expect(updated.steps == flow([.done, .done, .todo]).steps)
        let text = report.render(updated, checkedAt: Date(), locked: true)
        #expect(text.contains("✓ 1. download — Download: still holds — file ok") && text.contains("Next: 3. Process") && text.contains("\"replan\":false"))
    }

    @Test func aPendingActionIsConfirmedOrLeftForALook() {
        let (confirmed, updated) = FlowReport.evaluate(flow([.done, .done, .pending]), checks: [0: .holds("a"), 1: .holds("b"), 2: .holds("tab shows Submitted")])
        #expect(confirmed.complete && updated.steps[2].status == .done && confirmed.unconfirmed.isEmpty)
        let (open, same) = FlowReport.evaluate(flow([.done, .done, .pending]), checks: [0: .holds("a"), 1: .holds("b"), 2: .broken("tab 4 does not show \"Submitted\" now")])
        #expect(open.unconfirmed == ["process"] && same.steps[2].status == .pending && !open.needsReplan)
        #expect(open.next == "3. Process (check whether it happened first)")
        #expect(open.render(same, checkedAt: Date(), locked: false).contains("never repeat a submit"))
    }

    @Test func aBrokenStepAsksForAReplan() {
        let (report, _) = FlowReport.evaluate(flow([.done, .done, .todo]), checks: [0: .broken("the file /tmp/f0 is not there any more"), 1: .holds("b")])
        #expect(report.needsReplan && report.broken == ["download"])
        #expect(report.next == "1. Download (redo: what it produced is gone or changed)")
        let text = report.render(flow([.done, .done, .todo]), checkedAt: Date(), locked: false)
        #expect(text.contains("✗ 1. download — Download: done before, but no longer holds — the file /tmp/f0 is not there any more"))
        #expect(text.contains("Replan needed: 1 step done before no longer holds (download); steps done after it (open) were built on it"))
        #expect(text.contains("\"broken\":[\"download\"]"))
        let (unknown, _) = FlowReport.evaluate(flow([.done, .todo, .todo]), checks: [0: .unknown("the browser is not connected")])
        #expect(unknown.unknown == ["download"] && !unknown.needsReplan && unknown.next == "2. Open")
    }
}
