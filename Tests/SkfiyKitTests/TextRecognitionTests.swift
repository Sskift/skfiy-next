import AppKit
import Testing
@testable import SkfiyKit

struct TextRecognitionTests {
    /// A white image with `words` drawn at the given top-left points.
    private func render(_ words: [(String, CGPoint)], size: CGSize) -> CGImage {
        let image = NSImage(size: size, flipped: true) { rect in
            NSColor.white.setFill()
            rect.fill()
            for (word, point) in words {
                (word as NSString).draw(at: point, withAttributes: [.font: NSFont.systemFont(ofSize: 28), .foregroundColor: NSColor.black])
            }
            return true
        }
        return image.cgImage(forProposedRect: nil, context: nil, hints: nil)!
    }

    @Test func recognizesWordsAndPlacesThemOnScreen() async throws {
        let image = render([("Settings", CGPoint(x: 20, y: 20)), ("发送消息", CGPoint(x: 20, y: 120))], size: CGSize(width: 400, height: 200))
        // The image shows a 400×200 pt region at (1000, 500) on screen.
        let lines = TextRecognition.sorted(try await TextRecognition.recognize(image, showing: CGRect(x: 1000, y: 500, width: 400, height: 200)))
        #expect(lines.map(\.text) == ["Settings", "发送消息"])
        #expect(lines[0].frame.minX > 1000 && lines[0].frame.minX < 1060)
        #expect(lines[0].frame.midY < lines[1].frame.midY)
        #expect(lines[1].frame.minY > 600)
    }

    @Test func splitsLabelsThatShareARow() async throws {
        let image = render([("Save", CGPoint(x: 20, y: 40)), ("Cancel", CGPoint(x: 300, y: 40))], size: CGSize(width: 500, height: 120))
        let lines = TextRecognition.sorted(try await TextRecognition.recognize(image, showing: CGRect(x: 0, y: 0, width: 500, height: 120)))
        #expect(lines.map(\.text) == ["Save", "Cancel"])
        #expect(lines[1].frame.minX > 250)
    }

    @Test func ordersRowsTopToBottomAndLeftToRight() {
        let text = { (text: String, x: Double, y: Double) in RecognizedText(text: text, frame: CGRect(x: x, y: y, width: 40, height: 20)) }
        let lines = [text("b", 100, 12), text("c", 0, 60), text("a", 0, 10)]
        #expect(TextRecognition.sorted(lines).map(\.text) == ["a", "b", "c"])
    }

    @Test func mergesTheLinesOneResolutionMissed() {
        let title = RecognizedText(text: "twin.txt", frame: CGRect(x: 100, y: 5, width: 60, height: 14))
        let titleAgain = RecognizedText(text: "twin.txt ~", frame: CGRect(x: 98, y: 6, width: 66, height: 13))
        let line = RecognizedText(text: "Alpha line 001", frame: CGRect(x: 10, y: 30, width: 100, height: 13))
        let merged = TextRecognition.merged([title], with: [titleAgain, line])
        #expect(merged.map(\.text) == ["twin.txt", "Alpha line 001"])
        #expect(TextRecognition.merged([], with: [line]).map(\.text) == ["Alpha line 001"])
    }

    @Test func aFullerLineReplacesFragments() {
        // At full resolution the glued word was dropped; at 1x the line reads whole.
        let fragments = [RecognizedText(text: "line", frame: CGRect(x: 60, y: 30, width: 28, height: 13)),
                         RecognizedText(text: "Ø01", frame: CGRect(x: 92, y: 30, width: 22, height: 13))]
        let whole = RecognizedText(text: "MARK07AC5Bench line 001", frame: CGRect(x: 8, y: 30, width: 108, height: 13))
        let next = RecognizedText(text: "Bench line 002", frame: CGRect(x: 8, y: 44, width: 100, height: 13))
        #expect(TextRecognition.merged(fragments + [next], with: [whole]).map(\.text) == ["Bench line 002", "MARK07AC5Bench line 001"])
        // The same text with a stray mark is not "more".
        let title = RecognizedText(text: "twin.txt", frame: CGRect(x: 100, y: 5, width: 60, height: 14))
        #expect(TextRecognition.merged([title], with: [RecognizedText(text: "twin.txt —", frame: title.frame)]).map(\.text) == ["twin.txt"])
        #expect(TextMatch.contains("MARKØD65EBench line 001", "MARK0D65E"))
        // Fragments with a word missing between them.
        let gappy = [RecognizedText(text: "Bench", frame: CGRect(x: 8, y: 60, width: 36, height: 13)),
                     RecognizedText(text: "002", frame: CGRect(x: 90, y: 60, width: 22, height: 13))]
        let line = RecognizedText(text: "Bench line 002", frame: CGRect(x: 8, y: 60, width: 104, height: 13))
        #expect(TextRecognition.merged(gappy, with: [line]).map(\.text) == ["Bench line 002"])
        #expect(TextRecognition.isSubsequence("bench002", of: "benchline002") && !TextRecognition.isSubsequence("bench003", of: "benchline002"))
    }
}
