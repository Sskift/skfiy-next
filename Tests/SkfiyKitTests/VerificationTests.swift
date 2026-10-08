import Foundation
import Testing
@testable import SkfiyKit

private final class Clock: @unchecked Sendable {
    var time = 0.0
    func now() -> Double { time }
    func sleep(_ seconds: Double) async throws { time += seconds }
}

private func look(_ text: String = "status: ready", windows: [String: String] = ["1": "Main"], target: Bool = true,
                  value: String? = nil, interruption: String? = nil) -> VerifyObservation {
    VerifyObservation(text: text, treeText: text, windows: windows, targetPresent: target, value: value, interruption: interruption)
}

struct VerificationTests {
    @Test func parsesExpectations() throws {
        #expect(try ActionExpectation("Saved")?.text == "Saved")
        let full = try #require(try ActionExpectation(["text_gone": "Loading", "window_opened": true, "timeout": 2]))
        #expect(full.textGone == "Loading" && full.windowOpened == "" && full.timeout == 2)
        #expect(try ActionExpectation(nil) == nil)
        #expect(throws: ToolError.self) { try ActionExpectation(["textt": "x"]) }
        #expect(throws: ToolError.self) { try ActionExpectation(["timeout": 99, "text": "x"]) }
        #expect(throws: ToolError.self) { try ActionExpectation(["timeout": 2]) }
        #expect(full.summary == "\"Loading\" disappears and a window opens")
    }

    private func run(_ expectation: ActionExpectation, before: VerifyObservation, script: @escaping (Double) -> VerifyObservation) async -> Verdict {
        let clock = Clock()
        let verdict = await expectation.verify(before: before, now: clock.now, sleep: clock.sleep, observe: { script(clock.time) })
        return verdict
    }

    @Test func verifiedWhenTheTextAppears() async {
        var expectation = ActionExpectation()
        expectation.text = "applied 1"
        let verdict = await run(expectation, before: look()) { $0 < 0.5 ? look() : look("status: apply 1\napplied 1") }
        #expect(verdict.status == .verified && verdict.seconds == 0.5)
        #expect(verdict.line(risky: false).hasPrefix("Verification: verified — \"applied 1\" appears"))
    }

    @Test func noEffectWhenNothingChanged() async {
        var expectation = ActionExpectation()
        expectation.text = "noop clicked"
        expectation.timeout = 2
        let verdict = await run(expectation, before: look()) { _ in look() }
        #expect(verdict.status == .noEffect && verdict.seconds >= 2)
        #expect(verdict.line(risky: true).contains("do not repeat it blindly"))
    }

    @Test func timeoutWhenSomethingElseChanged() async {
        var expectation = ActionExpectation()
        expectation.text = "never"
        expectation.timeout = 1
        let verdict = await run(expectation, before: look()) { _ in look("status: submitted 1") }
        #expect(verdict.status == .timeout)
        #expect(verdict.line(risky: true).contains("wait_for or get_app_state before repeating"))
    }

    @Test func targetChangedWhenTheWindowClosesOrAnotherOpens() async {
        var expectation = ActionExpectation()
        expectation.text = "done"
        let closed = await run(expectation, before: look()) { $0 < 0.25 ? look() : look(windows: [:], target: false) }
        #expect(closed.status == .targetChanged && closed.detail == "the window it acted on closed")
        let opened = await run(expectation, before: look()) { _ in look(windows: ["1": "Main", "2": "Error"]) }
        #expect(opened.status == .targetChanged && opened.detail.contains("\"Error\""))
        let unlocked = await run(expectation, before: look()) { _ in look(interruption: "macOS was unlocked") }
        #expect(unlocked.status == .targetChanged && unlocked.detail == "macOS was unlocked")
    }

    @Test func windowAndValueExpectations() async {
        var closes = ActionExpectation()
        closes.windowClosed = true
        let closed = await run(closes, before: look()) { $0 < 1 ? look() : look(windows: [:], target: false) }
        #expect(closed.status == .verified)
        var opens = ActionExpectation()
        opens.windowOpened = "dialog"
        let opened = await run(opens, before: look()) { $0 < 0.5 ? look() : look(windows: ["1": "Main", "9": "Scenario dialog"]) }
        #expect(opened.status == .verified)
        var value = ActionExpectation()
        value.valueChanges = true
        let changed = await run(value, before: look(value: "a")) { _ in look(value: "ab") }
        #expect(changed.status == .verified)
        var exact = ActionExpectation()
        exact.value = "42"
        let wrong = await run(exact, before: look(value: "1")) { _ in look(value: "41") }
        #expect(wrong.status == .timeout)
    }

    @Test func pixelChangesCountAsChanges() {
        let still = PixelFingerprint(width: 10, height: 10, pixels: [UInt8](repeating: 0, count: 100))
        var moved = still.pixels
        for index in 0..<10 { moved[index] = 255 }
        var a = look(), b = look()
        a.treeText = nil; b.treeText = nil
        a.pixels = still
        b.pixels = PixelFingerprint(width: 10, height: 10, pixels: moved)
        #expect(b.differs(from: a))
        b.pixels = still
        #expect(!b.differs(from: a))
    }

    @Test func riskyLabelsAndKeys() {
        for label in ["Submit", "Send message", "Pay now", "Delete", "提交订单", "发送", "Confirm purchase"] {
            #expect(RiskyAction.isRisky(label: label), "\(label)")
        }
        for label in ["Apply", "Noop", "Sender settings", "Submitted 1", nil, ""] as [String?] {
            #expect(!RiskyAction.isRisky(label: label), "\(label ?? "nil")")
        }
        #expect(RiskyAction.isSubmitKey("Return") && RiskyAction.isSubmitKey("KP_Enter") && !RiskyAction.isSubmitKey("Tab"))
    }

    @Test func repeatGuardNeedsALookAfterAnUnverifiedRiskyAction() {
        var guardrail = RepeatGuard()
        guardrail.performed(app: "42", signature: "click|[5] Button \"Submit\"", label: "click on \"Submit\"", verified: false)
        #expect(guardrail.refusal(app: "42", signature: "click|[5] Button \"Submit\"")?.contains("confirm_repeat") == true)
        #expect(guardrail.refusal(app: "42", signature: "click|[6] Button \"Cancel\"") == nil)
        #expect(guardrail.refusal(app: "7", signature: "click|[5] Button \"Submit\"") == nil)
        guardrail.looked(app: "42")
        #expect(guardrail.refusal(app: "42", signature: "click|[5] Button \"Submit\"") == nil)
        guardrail.performed(app: "42", signature: "s", label: "x", verified: true)
        #expect(guardrail.refusal(app: "42", signature: "s") == nil)
    }
}
