import Foundation
import CoreGraphics
import Testing
@testable import SkfiyKit

struct ScreenSharingTests {
    let screen = SharedScreenSnapshot(window: 42, identifier: "connection-a", title: "远端 Mac – Locked",
                                      frame: CGRect(x: -700, y: 152, width: 640, height: 480))

    @Test func validatesConnectionIdentityAndFreshFrame() throws {
        let now = Date()
        try screen.validate(current: screen, captured: now, now: now)
        try screen.validate(current: screen, captured: now.addingTimeInterval(-30), now: now)
        for date in [nil, now.addingTimeInterval(-30.01), now.addingTimeInterval(1)] {
            #expect(throws: ToolError.self) { try screen.validate(current: screen, captured: date, now: now) }
        }
        #expect(throws: ToolError.self) { try screen.validate(current: nil, captured: now, now: now) }
        var other = screen
        other.identifier = "connection-b" // Same title and bounds, different peer/session.
        #expect(throws: ToolError.self) { try screen.validate(current: other, captured: now, now: now) }
        other = screen; other.window = 43
        #expect(throws: ToolError.self) { try screen.validate(current: other, captured: now, now: now) }
        other = screen; other.frame.origin.y += 1
        #expect(throws: ToolError.self) { try screen.validate(current: other, captured: now, now: now) }
        other = screen; other.frame.size.width *= 2
        #expect(throws: ToolError.self) { try screen.validate(current: other, captured: now, now: now) }
    }

    @Test func excludesToolbarAndOtherDisplaysFromRemoteSurface() {
        #expect(screen.contains(CGPoint(x: -380, y: 392)))
        #expect(!screen.contains(CGPoint(x: -380, y: 140)))
        #expect(!screen.contains(CGPoint(x: 100, y: 392)))
        #expect(!screen.contains(CGPoint(x: CGFloat.nan, y: 200)))
        #expect(!screen.contains(CGPoint(x: -380, y: CGFloat.infinity)))
        #expect(ScreenSharing.isApp("com.apple.ScreenSharing"))
        #expect(!ScreenSharing.isApp("com.apple.ScreenSharing.other"))
        #expect(!ScreenSharing.isApp("com.carriez.rustdesk"))
    }

    @Test func textUsesRealKeysAndRejectsUnicodeBeforeSendingAnyPrefix() throws {
        let input = try screenSharingTextChords("aA +\r\n\t")
        #expect(input.count == 6)
        #expect(input[0] == (try parseKeyChord("a")))
        #expect(input[1] == (try parseKeyChord("shift+a")))
        #expect(input[2] == (try parseKeyChord("space")))
        #expect(input[3] == (try parseKeyChord("plus")))
        #expect(input[4] == (try parseKeyChord("Return")))
        #expect(input[5] == (try parseKeyChord("Tab")))
        for text in ["ASCII prefix中", "😀", "e\u{301}", "prefix\0", "\u{7f}"] {
            #expect(throws: ToolError.self) { try screenSharingTextChords(text) }
        }
    }

    @Test func horizontalWheelIsRejectedInsteadOfReportingUnsupportedInputAsSent() throws {
        try ScreenSharing.validateScrollDirection("up")
        try ScreenSharing.validateScrollDirection("down")
        for direction in ["left", "right"] {
            #expect(throws: ToolError.self) { try ScreenSharing.validateScrollDirection(direction) }
        }
    }

    @Test func reportsRemoteKeyboardTargetWithoutClaimingRemoteAX() {
        var facts = CapabilityInputs(session: .unlocked, mode: .normal, appName: "Screen Sharing")
        facts.pid = 100
        facts.bundleID = "com.apple.ScreenSharing"
        facts.windows = [.init(id: 42, title: "Mac")]
        facts.inspected = facts.windows[0]
        facts.screenSharingSession = true
        var report = CapabilityReport.evaluate(facts)
        #expect(report["pointer"]?.available == true)
        #expect(report["keyboard"]?.available == false)
        facts.screenSharingKeyboard = true
        report = CapabilityReport.evaluate(facts)
        #expect(report["keyboard"]?.available == true)
        #expect(report["keyboard"]?.detail.contains("bypassing local menu") == true)
        facts.session = .locked
        report = CapabilityReport.evaluate(facts)
        #expect(report["pointer"]?.available == false)
        #expect(report["keyboard"]?.available == false)
    }
}
