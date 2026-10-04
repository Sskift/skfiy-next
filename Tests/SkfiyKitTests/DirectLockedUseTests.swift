import Testing
@testable import SkfiyKit

struct DirectLockedUseTests {
    @Test func lockUnlockBetweenCallsInvalidatesStateWhenBothSamplesAreUnlocked() {
        var transitions = DirectLockedUse.TransitionTracker()
        let initial = transitions.observe(.unlocked)
        let unchanged = transitions.observe(.unlocked)
        #expect(initial)
        #expect(!unchanged)

        // Both notifications arrive before the next MCP call. This signal
        // makes ComputerUse discard its pre-lock AX indices/focus approvals,
        // as well as invalidating DirectLockedUse's screenshot coordinates.
        transitions.receivedNotification() // locked
        transitions.receivedNotification() // unlocked
        let afterCycle = transitions.observe(.unlocked)
        let afterConsumption = transitions.observe(.unlocked)
        #expect(afterCycle)
        #expect(!afterConsumption)

        // Polling remains a fallback when no notification is delivered.
        let locked = transitions.observe(.locked)
        let stillLocked = transitions.observe(.locked)
        let unavailable = transitions.observe(.unavailable)
        #expect(locked)
        #expect(!stillLocked)
        #expect(unavailable)
    }
}
