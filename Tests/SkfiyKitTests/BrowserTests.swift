import Foundation
import Testing
@testable import SkfiyKit

struct NativeMessageTests {
    @Test func roundTripsFramesSplitAcrossReads() throws {
        let first = Data(#"{"id":1}"#.utf8)
        let second = Data(#"{"event":"hello","browser":"Chrome 浏览器"}"#.utf8)
        let stream = NativeMessage.encode(first) + NativeMessage.encode(second)
        #expect(stream.prefix(4) == Data([UInt8(first.count), 0, 0, 0]))

        var buffer = Data()
        var decoded: [Data] = []
        // Feed the stream in awkward chunks, as a pipe may deliver it.
        for chunk in stride(from: 0, to: stream.count, by: 5) {
            buffer.append(stream[chunk..<min(chunk + 5, stream.count)])
            decoded += NativeMessage.decode(&buffer)
        }
        #expect(decoded == [first, second])
        #expect(buffer.isEmpty)
    }

    @Test func keepsIncompleteFramesBuffered() {
        var data = Data(NativeMessage.encode(Data("12345678".utf8)).prefix(7))
        #expect(NativeMessage.decode(&data).isEmpty)
        #expect(data.count == 7)
    }

    @Test func hostManifestAllowsOnlyTheExtension() {
        let manifest = BrowserBridge.hostManifest(executable: "/usr/local/bin/skfiy")
        #expect(manifest["name"] as? String == "com.skfiy.bridge")
        #expect(manifest["path"] as? String == "/usr/local/bin/skfiy")
        #expect(manifest["type"] as? String == "stdio")
        #expect(manifest["allowed_origins"] as? [String] == ["chrome-extension://fkllhjogckpegfdomkajlkmjaaahnhbd/"])
    }

    @Test func installWritesOnlyToGivenProfiles() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-install-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let written = try BrowserBridge.install(executable: "/bin/skfiy", extraUserDataDirectories: [directory.path])
        #expect(written == [directory.appendingPathComponent("NativeMessagingHosts/com.skfiy.bridge.json").path])
        let data = try Data(contentsOf: URL(fileURLWithPath: written[0]))
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(json?["path"] as? String == "/bin/skfiy")
    }
}

struct BrowserFormattingTests {
    @Test func tabsMarkWhatTheUserSees() {
        let lines = formatTabs(browser: "Google Chrome", windows: [[
            "windowId": 7, "focused": true,
            "tabs": [
                ["id": 1, "title": "Inbox", "url": "https://mail.example.com", "active": true, "userVisible": true],
                ["id": 2, "title": "Docs", "url": "https://docs.example.com", "active": false, "loading": true]
            ]
        ]])
        #expect(lines == [
            "Google Chrome:",
            "  window 7 (focused)",
            "    tab 1 [shown] \"Inbox\" — https://mail.example.com",
            "    tab 2 [loading] \"Docs\" — https://docs.example.com"
        ])
    }

    @Test func stateShowsScrollFocusAndTruncation() {
        let text = formatState(browser: "Chromium", page: [
            "tabId": 5, "title": "Fixture", "url": "http://127.0.0.1/",
            "viewport": ["width": 1200, "height": 800],
            "scroll": ["y": 100, "max": 600],
            "focused": 3,
            "lines": ["# Fixture", "[0] link \"Go\""],
            "truncated": true
        ])
        #expect(text == """
        Tab 5 · Chromium · "Fixture" — http://127.0.0.1/
        Viewport 1200×800 · scrolled 100 of 600 px (more below)
        Keyboard focus: [3]

        # Fixture
        [0] link "Go"
        (Page text truncated; scroll or use browser_scroll to see more.)
        """)
    }
}
