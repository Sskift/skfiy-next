import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

private final class Clock: @unchecked Sendable {
    var time = 0.0
    var looks = 0
    func now() -> Double { time }
    func sleep(_ seconds: Double) async throws { time += seconds }
}

struct StateChangesTests {
    private let before = [
        "[0] Window \"Scenario\"",
        "  [1] StaticText \"status: ready\"",
        "  [2] Button \"Save\"",
        "  [3] TextField \"Name\" value=\"\" settable",
        "  [4] Button \"Apply\""
    ]

    @Test func reportsChangedAddedAndRemovedLinesByIndex() {
        let after = [
            "[0] Window \"Scenario\"",
            "  [1] StaticText \"status: saved\"",
            "  [2] Button \"Save\"",
            "  [3] TextField \"Name\" value=\"Ada\" settable",
            "  [5] Sheet \"Confirm\"",
            "    [6] Button \"OK\""
        ]
        let diff = StateDiff.compare(old: before, new: after)
        #expect(diff.changed == [
            .init(old: "  [1] StaticText \"status: ready\"", new: "  [1] StaticText \"status: saved\""),
            .init(old: "  [3] TextField \"Name\" value=\"\" settable", new: "  [3] TextField \"Name\" value=\"Ada\" settable")
        ])
        #expect(diff.added == ["  [5] Sheet \"Confirm\"", "    [6] Button \"OK\""])
        #expect(diff.removed == ["  [4] Button \"Apply\""])
        #expect(diff.summary == "2 changed, 2 added, 1 removed")
        let rendered = diff.render()
        #expect(rendered.first == "~   [1] StaticText \"status: saved\"")
        #expect(rendered[1] == "    was: [1] StaticText \"status: ready\"")
        #expect(rendered.contains("+     [6] Button \"OK\""))
        #expect(rendered.last == "-   [4] Button \"Apply\"")
    }

    @Test func nothingChangedIsEmpty() {
        let diff = StateDiff.compare(old: before, new: before, oldWindows: ["7": "Scenario"], newWindows: ["7": "Scenario"])
        #expect(diff.isEmpty && diff.render().isEmpty && diff.summary == "no line changed")
    }

    @Test func windowsOpenedClosedAndRenamed() {
        let diff = StateDiff.compare(old: before, new: before, oldWindows: ["7": "Scenario", "8": "Old dialog", "9": "Doc"],
                                     newWindows: ["7": "Scenario", "9": "Doc — Edited", "10": "Save changes?"])
        #expect(diff.opened == ["\"Save changes?\" (id 10)"])
        #expect(diff.closed == ["\"Old dialog\" (id 8)"])
        #expect(diff.renamed == ["\"Doc\" → \"Doc — Edited\" (id 9)"])
        #expect(!diff.isEmpty && diff.size == 0)
        #expect(diff.render() == ["Windows: opened \"Save changes?\" (id 10); closed \"Old dialog\" (id 8); renamed \"Doc\" → \"Doc — Edited\" (id 9)."])
    }

    @Test func recognizedTextIsKeyedByItsText() {
        let old = ["  \"Loading\" x=100 y=40", "  \"Total: 3\" x=60 y=80"]
        let new = ["  \"Total: 4\" x=60 y=80", "  \"Done\" x=100 y=40", "  \"Loading\" x=100 y=140"]
        let diff = StateDiff.compare(old: old, new: new)
        #expect(diff.changed == [.init(old: "  \"Loading\" x=100 y=40", new: "  \"Loading\" x=100 y=140")])
        #expect(Set(diff.added) == ["  \"Total: 4\" x=60 y=80", "  \"Done\" x=100 y=40"])
        #expect(diff.removed == ["  \"Total: 3\" x=60 y=80"])
        #expect(StateDiff.key("    [12] Button \"OK\"") == "[12]")
        #expect(StateDiff.key("  \"Done\" x=1 y=2") == "\"Done\"")
        #expect(StateDiff.key("Menu bar: [3] \"File\"") == nil)
    }

    @Test func largeChangesAndLongListsAreCut() {
        let old = (0..<100).map { "[\($0)] Row \"r\($0)\"" }
        let new = (0..<100).map { "[\($0 + 100)] Row \"n\($0)\"" }
        let diff = StateDiff.compare(old: old, new: new)
        #expect(diff.isLarge(comparedTo: new.count))
        #expect(!StateDiff.compare(old: old, new: old.dropLast() + ["[99] Row \"x\""]).isLarge(comparedTo: 100))
        let rendered = diff.render(limit: 10)
        #expect(rendered.count == 11 && rendered.last!.hasPrefix("(190 more change lines"))
    }

    @Test func historyKeepsTheLastLooks() {
        var history: [StateRecord]?
        for n in 1...9 {
            history = StateRecord.appending(StateRecord(version: "v\(n)", epoch: 1, window: "7", lines: [], textLines: [], windows: [:], fingerprint: nil), to: history)
        }
        #expect(history?.map(\.version) == ["v4", "v5", "v6", "v7", "v8", "v9"])
    }

    @Test func rendererKeepsEarlierIndices() {
        // Earlier look: OK was [1], Name [2]. Now a Cancel button came before them.
        let root = UINode(info: NodeInfo(role: "AXWindow", title: "W"), children: [
            UINode(info: NodeInfo(role: "AXButton", title: "Cancel"), ref: 3),
            UINode(info: NodeInfo(role: "AXButton", title: "OK"), ref: 1),
            UINode(info: NodeInfo(role: "AXTextField", value: "x"), ref: 2)
        ], ref: 0)
        let earlier: [Int: Int] = [0: 0, 1: 1, 2: 2]
        var next = 3
        var renderer = TreeRenderer { _, _ in NodeDetails() }
        renderer.allocate = { ref in
            if let index = earlier[ref] { return index }
            defer { next += 1 }
            return next
        }
        renderer.render(root)
        #expect(renderer.lines == ["[0] Window \"W\"", "  [3] Button \"Cancel\"", "  [1] Button \"OK\"", "  [2] TextField value=\"x\""])
        #expect(renderer.printed.map(\.index) == [0, 3, 1, 2])
    }

    @Test func idleLooksBackOffAndChangesResetThePace() async {
        // Text that never comes, on a window that changes once at 5 s.
        let clock = Clock()
        var plain = WaitEngine(text: "never", timeout: 10, interval: 0.25)
        _ = await plain.run(now: clock.now, sleep: clock.sleep, check: {}, observe: {
            clock.looks += 1
            return WaitObservation(text: clock.time < 5 ? "a" : "b", textFingerprint: clock.time < 5 ? "a" : "b")
        })
        let polled = clock.looks
        let paced = Clock()
        plain.maxInterval = 1
        var lookTimes: [Double] = []
        _ = await plain.run(now: paced.now, sleep: paced.sleep, check: {}, observe: {
            paced.looks += 1
            lookTimes.append(paced.time)
            return WaitObservation(text: paced.time < 5 ? "a" : "b", textFingerprint: paced.time < 5 ? "a" : "b")
        })
        #expect(polled == 41)
        #expect(paced.looks < polled / 2)
        // Right after the change, the next look comes at the base pace again.
        let firstAfter = lookTimes.firstIndex { $0 >= 5 }!
        #expect(lookTimes[firstAfter + 1] - lookTimes[firstAfter] == 0.25)
    }

    @Test func stableWaitsLookWhenStableEnough() async {
        let clock = Clock()
        var engine = WaitEngine(stableFor: 1, timeout: 10, interval: 1)
        engine.maxInterval = 1
        let result = await engine.run(now: clock.now, sleep: clock.sleep, check: {}, observe: {
            clock.looks += 1
            let frame = clock.time < 2 ? "moving \(clock.time)" : "still"
            return WaitObservation(text: nil, textFingerprint: frame)
        })
        // Changes until 2 s, then still: met one second after the first still look.
        #expect(result == .met(seconds: 3))
        #expect(clock.looks == 4)
    }
}
