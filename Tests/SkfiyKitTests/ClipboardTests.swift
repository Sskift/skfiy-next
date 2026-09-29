import AppKit
import Testing
@testable import SkfiyKit

@MainActor
struct ClipboardTests {
    /// A pasteboard of the test's own, so the user's clipboard is never touched.
    private func scratch() -> SystemClipboard {
        SystemClipboard(NSPasteboard(name: NSPasteboard.Name("skfiy-test-\(UUID().uuidString)")))
    }

    @Test func roundTripsEveryTypeAndMarksWritesTransient() {
        let clipboard = scratch()
        let contents = ClipboardContents(items: [
            ["public.utf8-plain-text": Data("hello".utf8), "public.rtf": Data("{\\rtf1 hello}".utf8)],
            ["public.file-url": Data("file:///tmp/a.txt".utf8)]
        ])
        clipboard.write(contents)
        let read = clipboard.read()
        #expect(read.items.count == 2)
        #expect(read.items[0]["public.rtf"] == contents.items[0]["public.rtf"])
        #expect(read.items[1]["public.file-url"] == contents.items[1]["public.file-url"])
        #expect(read.items.allSatisfy { $0[ClipboardContents.transientType] != nil })
        clipboard.pasteboard.releaseGlobally()
    }

    @Test func describesWhatItHolds() {
        #expect(ClipboardContents.text("hi").summary == "text")
        #expect(!ClipboardContents.text("hi").isRich)
        #expect(ClipboardContents.text("hi").text == "hi")
        let files = ClipboardContents(items: [["public.file-url": Data()], ["public.file-url": Data()]])
        #expect(files.summary == "2 files")
        #expect(files.isRich)
        #expect(ClipboardContents(items: [["public.png": Data()]]).summary == "an image")
        #expect(ClipboardContents(items: [["public.utf8-plain-text": Data("x".utf8), ClipboardContents.concealedType: Data()]]).isConcealed)
    }
}
