import CoreGraphics
import Testing
@testable import SkfiyKit

struct TreeRendererTests {
    private func render(_ root: UINode, clip: CGRect? = nil, details: [Int: NodeDetails] = [:]) -> TreeRenderer {
        var renderer = TreeRenderer { ref, _ in details[ref] ?? NodeDetails() }
        renderer.render(root, clip: clip)
        return renderer
    }

    @Test func flattensUnlabeledGroupsAndIndexesSequentially() {
        let root = UINode(info: NodeInfo(role: "AXWindow", title: "Untitled", frame: CGRect(x: 0, y: 0, width: 800, height: 600)), children: [
            UINode(info: NodeInfo(role: "AXGroup"), children: [
                UINode(info: NodeInfo(role: "AXButton", title: "OK"), ref: 2),
                UINode(info: NodeInfo(role: "AXTextField", value: "hello", focused: true), ref: 3)
            ], ref: 1)
        ], ref: 0)
        let renderer = render(root, details: [3: NodeDetails(settable: true)])
        #expect(renderer.lines == [
            "[0] Window \"Untitled\"",
            "  [1] Button \"OK\"",
            "  [2] TextField value=\"hello\" focused settable"
        ])
        #expect(renderer.indexToRef == [0, 2, 3])
    }

    @Test func dropsStaticTextRepeatingParentLabel() {
        let root = UINode(info: NodeInfo(role: "AXLink", description: "Docs"), children: [
            UINode(info: NodeInfo(role: "AXStaticText", value: "Docs"), ref: 1)
        ], ref: 0)
        #expect(render(root).lines == ["[0] Link \"Docs\""])
    }

    @Test func prunesSubtreesOutsideTheClip() {
        let clip = CGRect(x: 0, y: 0, width: 500, height: 500)
        let root = UINode(info: NodeInfo(role: "AXWebArea", title: "Page", frame: clip), children: [
            UINode(info: NodeInfo(role: "AXLink", title: "Visible", frame: CGRect(x: 10, y: 10, width: 50, height: 20)), ref: 1),
            UINode(info: NodeInfo(role: "AXLink", title: "Below the fold", frame: CGRect(x: 10, y: 2000, width: 50, height: 20)), ref: 2)
        ], ref: 0)
        let lines = render(root, clip: clip).lines
        #expect(lines.contains("  [1] Link \"Visible\""))
        #expect(!lines.contains { $0.contains("Below the fold") })
    }

    @Test func togglesShowCheckedState() {
        let root = UINode(info: NodeInfo(role: "AXCheckBox", title: "Bold", value: "1"), ref: 0)
        #expect(render(root).lines == ["[0] CheckBox \"Bold\" checked"])
    }

    @Test func showsPlaceholderAndNonImplicitActions() {
        let root = UINode(info: NodeInfo(role: "AXTextField", placeholder: "Search", enabled: false), ref: 0)
        let lines = render(root, details: [0: NodeDetails(actions: ["AXPress", "AXShowMenu", "AXConfirm"])]).lines
        #expect(lines == ["[0] TextField placeholder=\"Search\" disabled actions=[Confirm]"])
    }

    @Test func escapesAndTruncatesValues() {
        var renderer = TreeRenderer { _, _ in NodeDetails() }
        renderer.valueLimit = 5
        renderer.render(UINode(info: NodeInfo(role: "AXTextArea", value: "line1\nline2 \"quoted\""), ref: 0))
        #expect(renderer.lines == ["[0] TextArea value=\"line1…\""])
        #expect(quote("a\"b\nc", limit: 50) == "\"a\\\"b\\nc\"")
    }

    @Test func subroleIsShownUnlessNoise() {
        #expect(TreeRenderer.displayRole(NodeInfo(role: "AXButton", subrole: "AXCloseButton")) == "Button(CloseButton)")
        #expect(TreeRenderer.displayRole(NodeInfo(role: "AXWindow", subrole: "AXStandardWindow")) == "Window")
    }

    @Test func stopsAtTheLineBudget() {
        let children = (1...50).map { UINode(info: NodeInfo(role: "AXButton", title: "B\($0)"), ref: $0) }
        var renderer = TreeRenderer { _, _ in NodeDetails() }
        renderer.maxLines = 10
        renderer.render(UINode(info: NodeInfo(role: "AXWindow", title: "W"), children: children, ref: 0))
        #expect(renderer.lines.count == 10)
        #expect(renderer.truncated)
    }

    @Test func summarizesRowsAndHidesTheirCells() {
        let row = UINode(info: NodeInfo(role: "AXRow", selected: true), children: [
            UINode(info: NodeInfo(role: "AXCell"), children: [
                UINode(info: NodeInfo(role: "AXTextField", value: "report.pdf"), ref: 2)
            ], ref: 1),
            UINode(info: NodeInfo(role: "AXCell"), children: [
                UINode(info: NodeInfo(role: "AXStaticText", value: "2 MB"), ref: 4)
            ], ref: 3),
            UINode(info: NodeInfo(role: "AXCell"), children: [
                UINode(info: NodeInfo(role: "AXCheckBox", title: "Sync", value: "0"), ref: 6)
            ], ref: 5)
        ], ref: 0)
        #expect(render(row).lines == [
            "[0] Row \"report.pdf | 2 MB\" selected",
            "  [1] CheckBox \"Sync\" unchecked"
        ])
    }

    @Test func flattensContainerRepeatingParentLabel() {
        let root = UINode(info: NodeInfo(role: "AXWindow", title: "Doc"), children: [
            UINode(info: NodeInfo(role: "AXGroup", title: "Doc"), children: [
                UINode(info: NodeInfo(role: "AXButton", title: "Back"), ref: 2)
            ], ref: 1)
        ], ref: 0)
        #expect(render(root).lines == ["[0] Window \"Doc\"", "  [1] Button \"Back\""])
    }

    @Test func stripsInvisibleFormatCharacters() {
        #expect(quote("\u{200B}Go\u{200D} project\u{FEFF}", limit: 50) == "\"Go project\"")
    }

    @Test func customActionNamesAreReadable() {
        #expect(TreeRenderer.actionDisplayName("Name:Move next\nTarget:0x0\nSelector:(null)") == "Move next")
        #expect(TreeRenderer.actionDisplayName("AXIncrement") == "Increment")
    }

    @Test func scrollAreasShowTheirPosition() {
        let root = UINode(info: NodeInfo(role: "AXScrollArea"), ref: 0)
        #expect(render(root, details: [0: NodeDetails(verticalScroll: 0.354)]).lines == ["[0] ScrollArea vscroll=35%"])
    }
}
