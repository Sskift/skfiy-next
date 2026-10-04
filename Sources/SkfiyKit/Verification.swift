import Foundation

/// What an action is expected to bring about, from its `expect` argument.
struct ActionExpectation: Equatable {
    var text: String?
    var textGone: String?
    /// The element (element_index) or field value: changed at all, or equal to this.
    var valueChanges = false
    var value: String?
    var windowClosed = false
    var windowOpened: String?
    var anyChange = false
    var timeout: Double = 5

    var isEmpty: Bool {
        text == nil && textGone == nil && !valueChanges && value == nil && !windowClosed && windowOpened == nil && !anyChange
    }

    init() {}

    init?(_ raw: Any?) throws {
        guard let raw else { return nil }
        if let text = raw as? String {
            self.text = text
            return
        }
        guard let object = raw as? [String: Any] else {
            throw ToolError("expect is an object such as {\"text\": \"Saved\"}, {\"text_gone\": \"Loading\"}, {\"value_changes\": true}, {\"window_closed\": true}, {\"window_opened\": \"Settings\"} or {\"changed\": true}, with an optional timeout in seconds.")
        }
        let known: Set<String> = ["text", "text_gone", "value_changes", "value", "window_closed", "window_opened", "changed", "timeout"]
        if let unknown = object.keys.first(where: { !known.contains($0) }) {
            throw ToolError("expect has no \"\(unknown)\"; use text, text_gone, value_changes, value, window_closed, window_opened, changed, timeout.")
        }
        let string = { (key: String) -> String? in (object[key] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 } }
        text = string("text")
        textGone = string("text_gone")
        valueChanges = object["value_changes"] as? Bool ?? false
        value = object["value"] as? String
        windowClosed = object["window_closed"] as? Bool ?? false
        if let opened = object["window_opened"] {
            windowOpened = (opened as? String) ?? ((opened as? Bool) == true ? "" : nil)
        }
        anyChange = object["changed"] as? Bool ?? false
        if let seconds = (object["timeout"] as? NSNumber)?.doubleValue {
            guard seconds.isFinite, (0.2...30).contains(seconds) else { throw ToolError("expect.timeout must be between 0.2 and 30 seconds.") }
            timeout = seconds
        }
        guard !isEmpty else { throw ToolError("expect needs at least one condition.") }
    }

    var summary: String {
        var parts: [String] = []
        if let text { parts.append("\(quote(text, limit: 40)) appears") }
        if let textGone { parts.append("\(quote(textGone, limit: 40)) disappears") }
        if let value { parts.append("the value becomes \(quote(value, limit: 40))") } else if valueChanges { parts.append("the value changes") }
        if windowClosed { parts.append("the window closes") }
        if let windowOpened { parts.append(windowOpened.isEmpty ? "a window opens" : "a window \(quote(windowOpened, limit: 40)) opens") }
        if anyChange { parts.append("something changes") }
        return parts.joined(separator: " and ")
    }
}

/// One look at the target after (or before) an action, in either mode.
struct VerifyObservation {
    /// Accessibility text of the window (unlocked), or text recognized in it (locked).
    var text: String
    /// What changed is judged on: pixels while locked, the tree's text unlocked.
    var pixels: PixelFingerprint?
    var treeText: String?
    /// The app's windows, by id (or title when no id is known).
    var windows: [String: String]
    /// Whether the window the action was aimed at is still there.
    var targetPresent: Bool
    var value: String?
    /// Something that makes the action's target no longer the same (app quit, lock change).
    var interruption: String?

    func differs(from other: VerifyObservation) -> Bool {
        if let a = pixels, let b = other.pixels, a.changed(from: b) { return true }
        if let a = treeText, let b = other.treeText, a != b { return true }
        return windows != other.windows || value != other.value
    }
}

enum VerificationStatus: String {
    case verified
    case noEffect = "no_effect"
    case targetChanged = "target_changed"
    case timeout
}

struct Verdict: Equatable {
    let status: VerificationStatus
    let detail: String
    let seconds: Double
}

extension ActionExpectation {
    func met(before: VerifyObservation, now: VerifyObservation) -> Bool {
        if let text, !TextMatch.contains(now.text, text) { return false }
        if let textGone, TextMatch.contains(now.text, textGone) { return false }
        if let value, now.value?.trimmingCharacters(in: .whitespacesAndNewlines) != value.trimmingCharacters(in: .whitespacesAndNewlines) { return false }
        if valueChanges, now.value == before.value { return false }
        if windowClosed, now.targetPresent { return false }
        if let windowOpened {
            let opened = now.windows.filter { before.windows[$0.key] == nil }
            if opened.isEmpty || (!windowOpened.isEmpty && !opened.values.contains { TextMatch.contains($0, windowOpened) }) { return false }
        }
        if anyChange, !now.differs(from: before) { return false }
        return true
    }

    /// Something other than what was expected happened to the target: the
    /// window it acted on closed, another window appeared, or the app quit.
    func targetChange(before: VerifyObservation, now: VerifyObservation) -> String? {
        if let interruption = now.interruption { return interruption }
        if !windowClosed, before.targetPresent, !now.targetPresent { return "the window it acted on closed" }
        if windowOpened == nil {
            let opened = now.windows.filter { before.windows[$0.key] == nil }.values
            if !opened.isEmpty { return "a new window appeared: " + opened.map { quote($0, limit: 40) }.joined(separator: ", ") }
        }
        return nil
    }

    /// Watches after an action until the expectation holds, the target
    /// changes, or the timeout; then classifies what was seen.
    func verify(before: VerifyObservation, now: () -> Double, sleep: (Double) async throws -> Void,
                observe: () async throws -> VerifyObservation, interval: Double = 0.25) async -> (Verdict, VerifyObservation?) {
        let started = now()
        var latest: VerifyObservation?
        var changed = false
        while true {
            let current: VerifyObservation
            do {
                try Task.checkCancellation()
                current = try await observe()
            } catch is CancellationError {
                return (Verdict(status: .timeout, detail: "verification was cancelled", seconds: now() - started), latest)
            } catch {
                return (Verdict(status: .targetChanged, detail: "\(error)", seconds: now() - started), latest)
            }
            latest = current
            changed = changed || current.differs(from: before)
            if met(before: before, now: current) {
                return (Verdict(status: .verified, detail: summary, seconds: now() - started), current)
            }
            if let change = targetChange(before: before, now: current) {
                return (Verdict(status: .targetChanged, detail: change, seconds: now() - started), current)
            }
            if now() - started >= timeout {
                return changed
                    ? (Verdict(status: .timeout, detail: "the window changed, but not as expected (\(summary))", seconds: now() - started), current)
                    : (Verdict(status: .noEffect, detail: "nothing in the window changed", seconds: now() - started), current)
            }
            do { try await sleep(interval) } catch {
                return (Verdict(status: .timeout, detail: "verification was cancelled", seconds: now() - started), latest)
            }
        }
    }
}

extension Verdict {
    /// The line put at the top of the action's result.
    func line(risky: Bool) -> String {
        let seconds = formatNumber((self.seconds * 10).rounded() / 10)
        switch status {
        case .verified:
            return "Verification: verified — \(detail) (after \(seconds) s)."
        case .noEffect:
            return "Verification: no_effect — \(detail) within \(seconds) s; the action probably did not take."
                + (risky ? " It may still have been received: look at the current state before trying again, and do not repeat it blindly." : " Try another way (element_index, keyboard, focus) rather than the same input.")
        case .targetChanged:
            return "Verification: target_changed — \(detail) (after \(seconds) s); the expectation could not be judged. Look at the current state before continuing."
                + (risky ? " Do not repeat the action blindly: it may have gone through." : "")
        case .timeout:
            return "Verification: timeout — \(detail) within \(seconds) s."
                + (risky ? " It may still complete or may have gone through: wait_for or get_app_state before repeating it." : "")
        }
    }
}

/// Actions that can produce a duplicate (submit, send, pay, delete…).
enum RiskyAction {
    static let words = ["submit", "send", "post", "publish", "pay", "purchase", "buy", "order", "checkout", "confirm", "delete", "remove",
                        "transfer", "book", "reply", "提交", "发送", "发布", "支付", "付款", "购买", "下单", "确认", "删除", "转账", "回复"]

    static func isRisky(label: String?) -> Bool {
        guard let label = label?.lowercased(), !label.isEmpty else { return false }
        return words.contains { word in
            label == word || label.hasPrefix(word + " ") || label.hasSuffix(" " + word) || label.contains(" \(word) ")
                || (word.unicodeScalars.first.map { $0.value > 0x2E80 } == true && label.contains(word))
        }
    }

    static func isSubmitKey(_ key: String) -> Bool {
        ["return", "enter", "kp_enter", "cmd+return", "cmd+enter", "super+return", "ctrl+return"].contains(key.lowercased())
    }
}

/// Refuses an identical risky action right after one whose effect was not
/// verified, until the state has been looked at again (or confirm_repeat).
struct RepeatGuard {
    struct Entry: Equatable {
        let signature: String
        let label: String
        let verified: Bool
    }
    private(set) var last: [String: Entry] = [:]

    mutating func performed(app: String, signature: String, label: String, verified: Bool) {
        last[app] = Entry(signature: signature, label: label, verified: verified)
    }

    /// A fresh look at the app (get_app_state, wait_for) lifts the guard.
    mutating func looked(app: String) { last[app] = nil }

    func refusal(app: String, signature: String) -> String? {
        guard let entry = last[app], entry.signature == signature, !entry.verified else { return nil }
        return "The previous \(entry.label) was not verified to have taken effect, and repeating it could submit or send twice. Look at the current state first (get_app_state or wait_for, which may show it went through); if it really did nothing, call again with confirm_repeat: true."
    }
}
