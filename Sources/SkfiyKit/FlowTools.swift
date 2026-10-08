import AppKit
import Foundation

/// flow_start, flow_record and flow_status: a flow's steps are recorded only
/// with proof that holds when recorded, and every status check looks at
/// the present again instead of trusting the record.
extension ComputerUse {
    func flowStart(_ args: Arguments) async throws -> ToolResult {
        let store = FlowStore.standard
        let name = try FlowStore.validName(try args.requiredString("name"))
        if let existing = try store.load(name), args.bool("restart") != true {
            let status = try await flowStatusText(existing, store: store)
            return ToolResult(text: "Flow \(quote(name, limit: 60)) exists already (started \(ISO8601DateFormatter().string(from: existing.created))); resuming it, nothing was reset (pass restart: true to start over).\n" + status)
        }
        let steps = try FlowRecord.steps(args.values["steps"])
        let record = FlowRecord(name: name, goal: nonEmpty(args.string("goal")), steps: steps, created: Date(), updated: Date())
        try store.save(record)
        let list = steps.enumerated().map { "  \($0.offset + 1). " + ($0.element.id == String($0.offset + 1) ? "" : "\($0.element.id) — ") + $0.element.title }
        return ToolResult(text: (["Started flow \(quote(name, limit: 60)) with \(steps.count) step\(steps.count == 1 ? "" : "s"):"] + list
            + ["Record each step with flow_record: done (with a proof that can be checked later) once verified, or pending right before an action that must not happen twice. After a reconnect or when the user took over, call flow_status first."]).joined(separator: "\n"))
    }

    func flowRecord(_ args: Arguments) async throws -> ToolResult {
        let store = FlowStore.standard
        let name = try FlowStore.validName(try args.requiredString("name"))
        guard var record = try store.load(name) else { throw ToolError("No flow \(quote(name, limit: 60)). Start it with flow_start.") }
        let query = try args.requiredString("step")
        guard let index = record.index(of: query) else {
            throw ToolError("Flow \(quote(name, limit: 60)) has no step \(quote(query, limit: 40)); its steps: " + record.steps.map(\.id).joined(separator: ", ") + ".")
        }
        guard let status = FlowRecord.Status(rawValue: (args.string("status") ?? "").lowercased()) else {
            throw ToolError("status is done, pending or todo.")
        }
        var step = record.steps[index]
        let label = "step \(index + 1) (\(step.title))"
        switch status {
        case .todo:
            step.status = .todo
            step.proof = nil
            step.identity = [:]
        case .done, .pending:
            let proof = try FlowProof(args.values["proof"])
            let (check, enriched, identity) = await checkProof(proof, identity: [:], recording: true)
            if status == .done {
                switch check {
                case .holds: break
                case .broken(let reason):
                    throw ToolError("Not recorded as done: the proof does not hold now — \(reason). Record it when it does (or as pending if the action was sent but its effect is not visible yet).")
                case .unknown(let reason):
                    throw ToolError("Not recorded as done: the proof cannot be checked now — \(reason).")
                }
            }
            step.status = status
            step.proof = status == .done ? enriched : proof
            step.identity = identity
        }
        step.note = nonEmpty(args.string("note")) ?? step.note
        step.at = Date()
        record.steps[index] = step
        record.updated = Date()
        try store.save(record)
        switch status {
        case .done:
            let next = record.steps.indices.first { record.steps[$0].status != .done }
            return ToolResult(text: "Recorded \(label) as done, verified now: \(step.proof?.summary ?? "")."
                + (next.map { " Next: \($0 + 1). \(record.steps[$0].title)." } ?? " All steps are done."))
        case .pending:
            return ToolResult(text: "Recorded \(label) as pending: its effect will be \(step.proof?.summary ?? ""). Do the action now; once that shows, record it as done. If the connection drops first, flow_status checks whether it happened before anything is repeated.")
        case .todo:
            return ToolResult(text: "Recorded \(label) as to do again.")
        }
    }

    func flowStatus(_ args: Arguments) async throws -> ToolResult {
        let store = FlowStore.standard
        guard let name = nonEmpty(args.string("name")?.trimmingCharacters(in: .whitespaces)) else {
            let names = store.names()
            return ToolResult(text: names.isEmpty ? "No flows yet. Start one with flow_start." : "Flows: " + names.map { quote($0, limit: 60) }.joined(separator: ", ") + ". Pass name to check one.")
        }
        guard let record = try store.load(try FlowStore.validName(name)) else { throw ToolError("No flow \(quote(name, limit: 60)). Start it with flow_start.") }
        return ToolResult(text: try await flowStatusText(record, store: store))
    }

    private func flowStatusText(_ record: FlowRecord, store: FlowStore) async throws -> String {
        var checks: [Int: FlowCheck] = [:]
        for (index, step) in record.steps.enumerated() where step.status != .todo {
            guard let proof = step.proof else { continue }
            checks[index] = await checkProof(proof, identity: step.identity, recording: false).0
        }
        let (report, evaluated) = FlowReport.evaluate(record, checks: checks)
        var updated = evaluated
        if updated != record {
            updated.updated = Date()
            try store.save(updated)
        }
        let locked = DirectLockedUse.enabled ? DirectLockedUse.isActive : isScreenLocked()
        return report.render(updated, locked: locked)
    }

    /// Checks a proof against the present. When recording, a file proof
    /// without sha256 gets the file's hash now (so a later change shows),
    /// and the identities acted on are noted: app pid, window id.
    func checkProof(_ proof: FlowProof, identity: [String: String], recording: Bool) async -> (FlowCheck, FlowProof, [String: String]) {
        var enriched = proof
        var noted = identity
        var details: [String] = []
        var unknown: String?
        if EmergencyStop.isStopped { return (.unknown("emergency stop is on"), proof, identity) }

        if proof.file != nil {
            let (check, withHash) = proof.checkFile(recording: recording)
            guard case .holds(let detail) = check else { return (check, proof, identity) }
            enriched = withHash
            details.append(detail)
        }

        if let id = proof.downloadID {
            var arguments: [String: Any] = ["action": "wait", "download_id": id, "timeout": 1]
            if let browser = proof.browser { arguments["browser"] = browser }
            let result = await perform("browser_downloads", arguments)
            if result.isError {
                if result.text.contains("No browser is connected") { unknown = "the browser is not connected" } else {
                    return (.broken("download \(id): " + firstLine(result.text)), proof, identity)
                }
            } else {
                details.append("download \(id) finished")
            }
        }

        if let app = proof.app {
            guard case .running(let running)? = try? directory.resolve(app), !running.isTerminated else {
                return (.broken("\(app) is not running"), proof, identity)
            }
            let pid = String(running.processIdentifier)
            if let before = identity["pid"], before != pid {
                details.append("\(app) was restarted since (pid \(before) → \(pid)): element indices and window ids from before do not apply")
            }
            noted["pid"] = pid
            if let window = proof.window {
                let rows = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
                let shown = rows.filter { row in
                    (row[kCGWindowOwnerPID as String] as? Int) == Int(running.processIdentifier)
                        && (row[kCGWindowLayer as String] as? Int) == 0 && (row[kCGWindowIsOnscreen as String] as? Bool) == true
                }
                let match = shown.first { row in
                    String((row[kCGWindowNumber as String] as? Int) ?? -1) == window
                        || ((row[kCGWindowName as String] as? String)?.localizedCaseInsensitiveContains(window) ?? false)
                }
                guard let match, let number = match[kCGWindowNumber as String] as? Int else {
                    return (.broken("\(app) has no window \(quote(window, limit: 60)) open"), proof, identity)
                }
                if let before = identity["windowID"], before != String(number) {
                    details.append("window \(quote(window, limit: 60)) is open, now as id \(number) (it was id \(before): closed and opened again)")
                } else {
                    details.append("\(app) window \(quote(window, limit: 60)) (id \(number)) is open")
                }
                noted["windowID"] = String(number)
            }
            if let text = proof.text {
                var arguments: [String: Any] = ["app": app, "text": text, "timeout": 1.5]
                if let window = proof.window { arguments["window"] = window }
                let result = await perform("wait_for", arguments)
                if result.isError {
                    if result.text.contains("did not appear") {
                        return (.broken("\(quote(text, limit: 60)) is not shown in \(app) now"), proof, identity)
                    }
                    unknown = firstLine(result.text)
                } else {
                    details.append("\(quote(text, limit: 60)) is shown in \(app)")
                }
            } else if proof.window == nil {
                details.append("\(app) is running")
            }
        }

        if let tab = proof.tabID {
            var arguments: [String: Any] = ["tab_id": tab, "timeout": 1.5]
            if let text = proof.text { arguments["text"] = text }
            if let browser = proof.browser { arguments["browser"] = browser }
            let result = await perform("browser_wait", arguments)
            if result.isError {
                if result.text.contains("No browser is connected") {
                    unknown = "the browser is not connected"
                } else if let text = proof.text, result.text.contains("did not appear") {
                    return (.broken("tab \(tab) does not show \(quote(text, limit: 60)) now"), proof, identity)
                } else {
                    return (.broken("tab \(tab): " + firstLine(result.text)), proof, identity)
                }
            } else {
                details.append(proof.text.map { "tab \(tab) shows \(quote($0, limit: 60))" } ?? "tab \(tab) is open")
            }
        }

        if let unknown { return (.unknown(unknown), proof, identity) }
        return (.holds(details.joined(separator: "; ")), enriched, noted)
    }
}

private func firstLine(_ text: String) -> String {
    String(text.split(separator: "\n", maxSplits: 1).first ?? "").trimmingCharacters(in: .whitespaces)
}
