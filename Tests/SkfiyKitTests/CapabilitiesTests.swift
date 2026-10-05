import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

struct CapabilitiesTests {
    private func facts(_ session: CapabilityInputs.Session = .unlocked, mode: CapabilityInputs.Mode = .normal,
                       windows: Int = 1, configure: (inout CapabilityInputs) -> Void = { _ in }) -> CapabilityInputs {
        var facts = CapabilityInputs(session: session, mode: mode, appName: "Notes")
        facts.pid = 42
        facts.bundleID = "com.example.notes"
        facts.windows = (0..<windows).map { .init(id: CGWindowID(100 + $0), title: "Window \($0)") }
        facts.inspected = facts.windows.first
        facts.accessibilityElements = 30
        facts.hasFocusedElement = true
        facts.keyboardWindows = windows
        facts.clientCanAsk = true
        configure(&facts)
        return facts
    }

    private func available(_ report: CapabilityReport) -> [String: Bool] {
        Dictionary(uniqueKeysWithValues: report.channels.map { ($0.name, $0.available) })
    }

    @Test func unlockedBackgroundAppHasEveryDesktopChannel() {
        let report = CapabilityReport.evaluate(facts())
        #expect(available(report) == ["ax": true, "screenshot": true, "ocr": true, "pointer": true, "keyboard": true,
                                      "browser": false, "foreground": true, "file_dialog": true, "clipboard": true])
        #expect(report.tools.contains("set_value") && report.tools.contains("run_in_front"))
        #expect(report["keyboard"]?.limits.contains { $0.contains("disabled in the background") } == true)
    }

    @Test func lockedDirectUsesScreenshotsAndOneKeyboardWindow() {
        let one = CapabilityReport.evaluate(facts(.locked, mode: .direct), lockedTools: DirectLockedUse.lockedTools)
        #expect(available(one) == ["ax": false, "screenshot": true, "ocr": true, "pointer": true, "keyboard": true,
                                   "browser": false, "foreground": false, "file_dialog": false, "clipboard": false])
        #expect(!one.tools.contains("set_value") && one.tools.contains("type_text"))
        #expect(one["pointer"]?.limits.contains { $0.contains("No valid screenshot") } == true)

        let two = CapabilityReport.evaluate(facts(.locked, mode: .direct, windows: 2))
        #expect(two["keyboard"]?.available == false)
        #expect(two["keyboard"]?.detail.contains("2 active windows") == true)
        #expect(!two.tools.contains("type_text") && two.tools.contains("click"))
        #expect(two.changes(since: one).contains("windows"))
        #expect(two.changes(since: one).contains("keyboard"))
        #expect(two.version != one.version)

        let aged = CapabilityReport.evaluate(facts(.locked, mode: .direct) { $0.screenshotAge = 4 })
        #expect(aged["pointer"]?.limits.contains("Current screenshot coordinates are 4 s old.") == true)
    }

    @Test func lockedWithoutDirectModeOrAfterEndingExplainsWhy() {
        let plain = CapabilityReport.evaluate(facts(.locked, mode: .normal))
        #expect(available(plain).values.allSatisfy { !$0 })
        #expect(plain["screenshot"]?.detail.contains("SKFIY_LOCKED_USE=direct") == true)
        #expect(plain.tools == ["list_apps", "get_app_capabilities"])
        let ended = CapabilityReport.evaluate(facts(.locked, mode: .directEnded))
        #expect(ended["keyboard"]?.detail.contains("locked_use_end") == true)
        let unknown = CapabilityReport.evaluate(facts(.unknown, mode: .direct))
        #expect(unknown["screenshot"]?.available == false)
    }

    @Test func lockStateChangeIsReported() {
        let before = CapabilityReport.evaluate(facts(.unlocked, mode: .direct))
        let after = CapabilityReport.evaluate(facts(.locked, mode: .direct))
        let changes = after.changes(since: before)
        #expect(changes.contains("session") && changes.contains("ax") && changes.contains("foreground"))
        #expect(after.changes(since: after).isEmpty)
    }

    @Test func permissionsGateTheirChannels() {
        let noAX = CapabilityReport.evaluate(facts { $0.accessibility = false })
        #expect(noAX["ax"]?.available == false && noAX["screenshot"]?.available == true)
        let noCapture = CapabilityReport.evaluate(facts { $0.screenRecording = false })
        #expect(noCapture["screenshot"]?.available == false && noCapture["ocr"]?.available == false)
        #expect(noCapture["pointer"]?.available == false)
        #expect(noCapture.changes(since: CapabilityReport.evaluate(facts())).contains("permissions"))
        let lockedNoCapture = CapabilityReport.evaluate(facts(.locked, mode: .direct) { $0.screenRecording = false })
        #expect(lockedNoCapture["screenshot"]?.detail.contains("Screen Recording") == true)
    }

    @Test func hiddenMinimizedAndOpaqueWindows() {
        let hidden = CapabilityReport.evaluate(facts { $0.hidden = true })
        #expect(hidden["screenshot"]?.available == false && hidden["pointer"]?.available == false && hidden["keyboard"]?.available == true)
        let minimized = CapabilityReport.evaluate(facts { $0.windows[0].minimized = true; $0.inspected = $0.windows[0] })
        #expect(minimized["screenshot"]?.detail.contains("minimized") == true)
        let opaque = CapabilityReport.evaluate(facts { $0.accessibilityElements = 0 })
        #expect(opaque["ax"]?.available == false && opaque["ocr"]?.available == true)
        let noWindows = CapabilityReport.evaluate(facts(windows: 0))
        #expect(noWindows["ax"]?.available == true && noWindows["screenshot"]?.available == false)
    }

    @Test func protectedAppsGetNoInput() {
        let terminal = CapabilityReport.evaluate(facts { $0.protection = .terminal })
        #expect(terminal["keyboard"]?.available == false && terminal["pointer"]?.available == false)
        #expect(terminal.tools.contains("scroll") && !terminal.tools.contains("type_text"))
        let host = CapabilityReport.evaluate(facts { $0.protection = .host })
        #expect(!host.tools.contains("scroll") && host["foreground"]?.available == false)
    }

    @Test func browserChannelFollowsTheConnection() {
        let disconnected = CapabilityReport.evaluate(facts { $0.chromium = true; $0.browserApp = true; $0.webContent = true })
        #expect(disconnected["browser"]?.available == false)
        #expect(disconnected["pointer"]?.limits.contains { $0.contains("Web content ignores pointer events") } == true)
        let connected = CapabilityReport.evaluate(facts {
            $0.chromium = true; $0.browserApp = true; $0.browserConnected = true; $0.connectedBrowsers = ["Chromium (pid 42)"]
        })
        #expect(connected["browser"]?.available == true && connected.tools.contains("browser_*"))
        #expect(connected.changes(since: disconnected).contains("browser"))
        let lockedConnected = CapabilityReport.evaluate(facts(.locked, mode: .direct) {
            $0.chromium = true; $0.browserApp = true; $0.browserConnected = true
        })
        #expect(lockedConnected["browser"]?.available == true)
        let electron = CapabilityReport.evaluate(facts { $0.chromium = true; $0.webContent = false })
        #expect(electron["browser"]?.available == false)
        #expect(electron["ax"]?.limits.contains { $0.contains("No web content in the tree yet") } == true)
    }

    @Test func emergencyStopAndClientWithoutQuestions() {
        let stopped = CapabilityReport.evaluate(facts { $0.emergencyStopped = true })
        #expect(available(stopped).values.allSatisfy { !$0 })
        let silent = CapabilityReport.evaluate(facts { $0.clientCanAsk = false })
        #expect(silent["foreground"]?.available == false && !silent.tools.contains("run_in_front"))
        let front = CapabilityReport.evaluate(facts { $0.frontmost = true })
        #expect(front["foreground"]?.detail.contains("already frontmost") == true)
    }

    @Test func renderedTextEndsWithMatchingJSON() throws {
        let report = CapabilityReport.evaluate(facts(.locked, mode: .direct, windows: 2))
        let text = report.render(changes: ["windows"])
        #expect(text.contains("changed since the last query: windows"))
        let json = try #require(text.split(separator: "\n").last.map { String($0.dropFirst("JSON: ".count)) })
        let object = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        #expect(object["version"] as? String == report.version)
        #expect(object["activeKeyboardWindows"] as? Int == 2)
    }

    @Test func staleBrowserSocketsOnlyWhenTheBrowserIsGone() {
        #expect(BrowserBridge.browserAlive("/tmp/\(getpid()).sock"))
        #expect(!BrowserBridge.browserAlive("/tmp/999999.sock"))
        #expect(!BrowserBridge.browserAlive("/tmp/not-a-pid.sock"))
    }

    @Test func anAsleepDisplayIsWokenWhileLockedOrSaidSo() {
        // Locked in direct mode: capture still works, the display is woken first.
        let wake = CapabilityReport.evaluate(facts(.locked, mode: .direct) { $0.displayAsleep = true }, lockedTools: DirectLockedUse.lockedTools)
        #expect(wake["screenshot"]?.available == true && wake["screenshot"]?.limits.contains { $0.contains("wakes it to the lock screen") } == true)
        #expect(wake["pointer"]?.available == true)
        // Waking turned off: no screenshot, no pointer, and why.
        let off = CapabilityReport.evaluate(facts(.locked, mode: .direct) { $0.displayAsleep = true; $0.wakeDisplay = false },
                                            lockedTools: DirectLockedUse.lockedTools)
        #expect(off["screenshot"]?.available == false && off["screenshot"]?.detail.contains("SKFIY_LOCKED_WAKE_DISPLAY=0") == true)
        #expect(off["ocr"]?.available == false && off["pointer"]?.available == false && !off.tools.contains("click"))
        #expect(off.changes(since: wake).contains("screenshot"))
        // Unlocked: an asleep display is the user's choice; not woken.
        let unlocked = CapabilityReport.evaluate(facts { $0.displayAsleep = true })
        #expect(unlocked["screenshot"]?.available == false && unlocked["ax"]?.available == true)
    }
}
