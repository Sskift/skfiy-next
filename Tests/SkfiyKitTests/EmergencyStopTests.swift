import Foundation
import Testing
@testable import SkfiyKit

@MainActor
struct EmergencyStopTests {
    @Test func stoppedSkfiyRefusesEveryToolButListingApps() async {
        let flag = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-stop-\(UUID().uuidString)").path
        setenv("SKFIY_STOP_FILE", flag, 1)
        defer {
            EmergencyStop.set(stopped: false, sound: false)
            unsetenv("SKFIY_STOP_FILE")
        }
        let computerUse = ComputerUse()
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
}
