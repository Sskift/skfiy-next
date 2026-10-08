import Foundation
import Testing
@testable import SkfiyKit

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
}
