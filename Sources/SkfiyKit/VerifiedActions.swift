import AppKit
import ApplicationServices
import Foundation

/// Actions with an `expect`: the outcome is checked after the action and
/// reported as verified, no_effect, target_changed or timeout. Actions that
/// can only happen once (submit, send, pay…) are never retried by skfiy, and
/// an identical one right after an unverified one is refused until the state
/// has been looked at again.
extension ComputerUse {
    nonisolated static let verifiableTools = ToolSchemas.names(.verifiable)

    struct ActionTarget {
        let pid: pid_t
        let window: CGWindowID?
        let signature: String
        let label: String?
        let elementIndex: Int?
    }

    func performVerified(_ name: String, _ raw: [String: Any]) async -> ToolResult {
        let args = Arguments(raw)
        let expectation: ActionExpectation?
        do { expectation = try ActionExpectation(raw["expect"]) } catch {
            return ToolResult(text: (error as? ToolError)?.description ?? "\(error)", isError: true)
        }
        let locked = DirectLockedUse.isActive
        if locked, let expectation, expectation.valueChanges || expectation.value != nil {
            return ToolResult(text: "expect.value and value_changes need accessibility, which is unavailable while macOS is locked; expect a text, text_gone, window_closed, window_opened or changed instead. Nothing was sent.", isError: true)
        }
        let target = locked ? lockedTarget(name, args) : unlockedTarget(name, args)
        let risky = args.bool("idempotent") == false
            || (["click", "perform_secondary_action"].contains(name) && RiskyAction.isRisky(label: target?.label))
            || (name == "press_key" && RiskyAction.isSubmitKey(args.string("key") ?? ""))
        let label = target?.label.map { "\(name) on \(quote($0, limit: 40))" } ?? name
        if risky, let target, args.bool("confirm_repeat") != true,
           let refusal = repeatGuard.refusal(app: String(target.pid), signature: target.signature) {
            return ToolResult(text: refusal + " Nothing was sent.", isError: true)
        }
        guard let expectation, let target else {
            var result = await perform(name, raw)
            if risky, let target, !result.isError {
                repeatGuard.performed(app: String(target.pid), signature: target.signature, label: label, verified: false)
                result.text += "\nThis \(label) can take effect only once: if the screenshot does not clearly show its result, look (get_app_state or wait_for) before repeating it. Pass expect next time to have it checked."
            }
            return result
        }
        let wantText = expectation.text != nil || expectation.textGone != nil
        var cache: (PixelFingerprint, String)?
        let observe = { [self] () async -> VerifyObservation in
            if locked {
                let (observation, updated) = await directLockedUse.verificationObservation(pid: target.pid, window: target.window ?? 0, wantText: wantText, previous: cache)
                cache = updated
                return observation
            }
            return await unlockedObservation(target, wantText: wantText)
        }
        let before = await observe()
        var result = await perform(name, raw)
        guard !result.isError else { return result }
        let started = Date()
        let verdict = await expectation.verify(
            before: before, now: { Date().timeIntervalSince(started) },
            sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
            observe: { await observe() })
        if risky {
            repeatGuard.performed(app: String(target.pid), signature: target.signature, label: label, verified: verdict.status == .verified)
        }
        result.text = verdict.line(risky: risky) + "\n" + result.text
        if verdict.status != .verified {
            result.isError = true
            // The state now, not as it was right after the input.
            var stateArguments: [String: Any] = ["app": raw["app"] ?? ""]
            if locked { stateArguments["ocr"] = true }
            let state = await perform("get_app_state", stateArguments)
            if !state.isError {
                result.text += "\nCurrent state:\n" + state.text
                result.image = state.image
                result.imageMimeType = state.imageMimeType
            }
        }
        return result
    }

    private func lockedTarget(_ name: String, _ args: Arguments) -> ActionTarget? {
        guard let target = directLockedUse.actionTarget(args, tool: name) else { return nil }
        return ActionTarget(pid: target.pid, window: target.window, signature: target.signature, label: target.label, elementIndex: nil)
    }

    private func unlockedTarget(_ name: String, _ args: Arguments) -> ActionTarget? {
        guard let query = args.string("app"), case .running(let app)? = try? directory.resolve(query) else { return nil }
        let pid = app.processIdentifier
        let session = sessions[pid]
        let window = session?.window.flatMap { windowID(of: $0) } ?? focusedWindowID(of: pid) ?? session?.windowID
        var signature = name
        var label: String?
        let index = (try? args.elementIndex()) ?? nil
        if let index, let element = session?.elements[safe: index] {
            label = element.string(kAXTitleAttribute) ?? element.string(kAXDescriptionAttribute) ?? element.string(kAXValueAttribute)
            signature += "|[\(index)] \(describe(element))"
        } else if let session, let point = try? screenPoint(args, name == "drag" ? "from_x" : "x", name == "drag" ? "from_y" : "y", session: session) {
            signature += "|\(Int((point.x / 12).rounded())),\(Int((point.y / 12).rounded()))"
            if let element = hitTest(pid: pid, at: point) {
                label = element.string(kAXTitleAttribute) ?? element.string(kAXDescriptionAttribute)
            }
        }
        switch name {
        case "press_key": signature += "|\(args.string("key")?.lowercased() ?? "")"
        case "type_text": signature += "|\(args.string("text") ?? "")"
        case "set_value": signature += "|\(args.string("value") ?? "")"
        case "perform_secondary_action": signature += "|\(args.string("action") ?? "")"
        default: break
        }
        return ActionTarget(pid: pid, window: window, signature: signature, label: label, elementIndex: index)
    }

    private func unlockedObservation(_ target: ActionTarget, wantText: Bool) async -> VerifyObservation {
        var observation = VerifyObservation(text: "", windows: [:], targetPresent: true)
        guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isTerminated else {
            observation.interruption = "the app quit"
            return observation
        }
        if isScreenLocked() {
            observation.interruption = "the screen locked"
            return observation
        }
        let appElement = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(appElement, 1)
        for window in appElement.elements(kAXWindowsAttribute) where window.string(kAXRoleAttribute) == kAXWindowRole {
            let title = window.string(kAXTitleAttribute) ?? ""
            observation.windows[windowID(of: window).map(String.init) ?? "title:" + title] = title
        }
        if let id = target.window { observation.targetPresent = observation.windows[String(id)] != nil }
        // The window the action was aimed at (an inspected one is not the
        // app's focused window), read on its own.
        let inspected = sessions[target.pid]?.window != nil
        let query = inspected ? target.window.map(String.init) : nil
        if let snapshot = try? buildSnapshot(app: app, appElement: appElement, windowQuery: query) {
            observation.text = snapshot.text
            observation.treeText = snapshot.body.joined(separator: "\n")
            if wantText, snapshot.opaque, let region = snapshot.chosenWindow?.frame ?? appRegion(pid: target.pid, focusedWindow: snapshot.focusedWindowFrame),
               let lines = try? await recognizeView(pid: target.pid, window: snapshot.chosenWindow, rect: region) {
                observation.text += "\n" + lines.map(\.text).joined(separator: "\n")
            }
        }
        // The value of the element acted on, or else of the field typing went
        // to; not of a field in another window that happens to have focus.
        let inTarget = { (element: AXUIElement) -> Bool in
            target.window == nil || self.containingWindow(of: element).flatMap(windowID(of:)) == target.window
        }
        let element = target.elementIndex.flatMap { sessions[target.pid]?.elements[safe: $0] }
            ?? appElement.element(kAXFocusedUIElementAttribute).flatMap { inTarget($0) ? $0 : nil }
            ?? typingTargets[target.pid].flatMap { inTarget($0) ? $0 : nil }
        observation.value = element?.string(kAXValueAttribute)
        if chromiumWindowFrozen(app, window: target.window) {
            observation.unobservable = "the window is completely covered by other windows, and Chromium does not update a covered window"
        }
        return observation
    }

    /// Looking at the app again lifts the guard on repeating a risky action.
    func noteLooked(_ raw: [String: Any]) {
        guard let query = raw["app"] as? String, case .running(let app)? = try? directory.resolve(query) else { return }
        repeatGuard.looked(app: String(app.processIdentifier))
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
