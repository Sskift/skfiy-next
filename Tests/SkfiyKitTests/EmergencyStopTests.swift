import ApplicationServices
import Foundation
import Testing
@testable import SkfiyKit

/// Serialized: both tests point SKFIY_STOP_FILE at a flag of their own.
@MainActor @Suite(.serialized)
struct EmergencyStopTests {
    @Test func stoppedSkfiyRefusesToolsButStillListsApps() async {
        let flag = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-stop-\(UUID().uuidString)").path
        setenv("SKFIY_STOP_FILE", flag, 1)
        defer {
            EmergencyStop.set(stopped: false, sound: false)
            unsetenv("SKFIY_STOP_FILE")
        }
        let computerUse = ComputerUse()
        computerUse.actionLog = nil  // tests never write to the user's action log
        EmergencyStop.set(stopped: true, sound: false)
        #expect(EmergencyStop.isStopped)
        for tool in ["get_app_state", "type_text", "press_key", "open_file", "browser_tabs"] {
            let result = await computerUse.call(tool, ["app": "TextEdit", "text": "x", "key": "a", "path": "/tmp"])
            #expect(result.isError && result.text.contains("⌃⌥⌘."), "\(tool) ran while stopped")
        }
        #expect(await computerUse.call("list_apps", [:]).isError == false)
        EmergencyStop.set(stopped: false, sound: false)
        #expect(!EmergencyStop.isStopped)
    }

    @Test func refusedAccessibilityIsNeverTakenForDone() async {
        let flag = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-stop-\(UUID().uuidString)").path
        setenv("SKFIY_STOP_FILE", flag, 1)
        defer {
            EmergencyStop.set(stopped: false, sound: false)
            unsetenv("SKFIY_STOP_FILE")
        }
        EmergencyStop.set(stopped: true, sound: false)
        // Refused before any IPC, and not as the .cannotComplete of a menu still opening.
        #expect(guardedAXPerformAction(AXUIElementCreateSystemWide(), kAXPressAction as CFString) == .failure)
        let refused = #expect(throws: ToolError.self) { try check(.failure, "perform AXPress") }
        #expect(refused?.description == EmergencyStop.refusal)
        #expect(throws: Never.self) { try throwIfRefused(.cannotComplete) }
        // Pointer input sends nothing while stopped, and says so (no event is posted).
        #expect(await Input.click(at: .zero, pid: getpid(), windowID: 0, button: .left, count: 1, modifiers: []) == false)
        EmergencyStop.set(stopped: false, sound: false)

        let cancelled = Task { () -> String? in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            return axMutationRefusal()
        }
        cancelled.cancel()
        #expect(await cancelled.value == "The request was cancelled, so nothing was done.")
        // A slow app is no refusal.
        let slow = #expect(throws: ToolError.self) { try check(.cannotComplete, "perform AXPress") }
        #expect(slow?.description.hasPrefix("The app did not respond in time") == true)
    }
}

struct FrontGrantTests {
    @Test func grantsExpireAndRevoke() {
        setenv("SKFIY_FRONT_GRANT_FILE", "/tmp/skfiy-grant-test-\(getpid())", 1)
        defer { FrontGrant.revoke(); unsetenv("SKFIY_FRONT_GRANT_FILE") }
        #expect(FrontGrant.granted() == nil)
        FrontGrant.grant(1234, seconds: 30)
        #expect(FrontGrant.granted() == 1234)
        FrontGrant.grant(1234, seconds: -1)
        #expect(FrontGrant.granted() == nil)
        FrontGrant.grant(99, seconds: 30)
        FrontGrant.revoke()
        #expect(FrontGrant.granted() == nil)
    }
}
