import Foundation
import CryptoKit

/// What skfiy did on the user's behalf, one JSON object per line, so they
/// can look back at every click, keystroke and file operation
/// (`skfiy log`). Only the user can read it; text typed into password fields
/// is recorded as its length, and the clipboard's content is never recorded.
public struct ActionLog: Sendable {
    public let file: URL

    public init(file: URL) {
        self.file = file
    }

    /// ~/Library/Logs/skfiy/actions.jsonl, or SKFIY_ACTION_LOG (a path, or
    /// "off" for none).
    public static var standard: ActionLog? {
        let setting = ProcessInfo.processInfo.environment["SKFIY_ACTION_LOG"]
        if setting == "off" { return nil }
        if let setting, !setting.isEmpty { return ActionLog(file: URL(fileURLWithPath: setting)) }
        return ActionLog(file: SkfiyPaths.logs.appendingPathComponent("actions.jsonl"))
    }

    static let maxBytes = 5_000_000

    /// Successful reads stay quiet. Failed reads and incomplete captures are
    /// recorded too, so a later coordinate error has a diagnosable cause.
    static let recordedTools = Set(ToolSchemas.names(.recorded))

    /// Identifies the executable this process loaded, including old MCP
    /// instances left running after an atomic installation update.
    static let buildID: String = {
        guard let url = Bundle.main.executableURL, let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return "unknown" }
        return SHA256.hash(data: data).prefix(8).map { String(format: "%02x", $0) }.joined()
    }()

    /// Arguments as recorded: typed text is kept (up to 500 characters)
    /// unless it went into a password field.
    static func recordedArguments(_ arguments: [String: Any], secret: Bool) -> [String: Any] {
        var recorded: [String: Any] = [:]
        let routing: Set<String> = ["app", "action", "browser", "tab_id", "window_id", "window", "zoom_id", "direction", "mouse_button"]
        var budget = 64
        for key in arguments.keys.sorted() {
            let value = arguments[key]!
            if secret, let text = value as? String, !routing.contains(key) {
                recorded[key] = "(\(text.count) characters, redacted)"
            } else if secret, value is [String: Any] || value is [Any] {
                recorded[key] = "(structured argument, redacted)"
            } else if let value = boundedValue(value, depth: 0, budget: &budget) {
                recorded[key] = value
            }
        }
        return recorded
    }

    private static func boundedValue(_ value: Any, depth: Int, budget: inout Int) -> Any? {
        guard budget > 0 else { return nil }
        budget -= 1
        if let text = value as? String { return String(text.prefix(500)) }
        if let number = value as? NSNumber { return number.doubleValue.isFinite ? number : "(non-finite number)" }
        if value is NSNull { return NSNull() }
        guard depth < 4 else { return "(nested argument truncated)" }
        if let object = value as? [String: Any] {
            var result: [String: Any] = [:]
            for key in object.keys.sorted().prefix(16) {
                result[String(key.prefix(100))] = boundedValue(object[key]!, depth: depth + 1, budget: &budget)
            }
            return result
        }
        if let array = value as? [Any] {
            return array.prefix(16).compactMap { boundedValue($0, depth: depth + 1, budget: &budget) }
        }
        return nil
    }

    func record(tool: String, arguments: [String: Any], result: ToolResult, secret: Bool, date: Date = Date(), duration: TimeInterval? = nil) {
        let captureError = result.structuredContent?["capture_error"] as? String
        let stateError = result.structuredContent?["state_error"] as? String
        let problem = result.isError || captureError != nil || stateError != nil
        guard Self.recordedTools.contains(tool) || problem else { return }
        if tool == "remote_desktop", ["state", "list"].contains(arguments["action"] as? String ?? ""), !problem { return }
        var entry: [String: Any] = [
            "time": ISO8601DateFormatter().string(from: date),
            "session": Int(getpid()),
            "build": Self.buildID,
            "tool": tool,
            "arguments": Self.recordedArguments(arguments, secret: secret),
            // Validation errors can echo a secret argument, so the result
            // follows the same privacy flag as the input fields.
            "result": secret ? "(redacted)" : String((result.text.split(separator: "\n").first ?? "").prefix(300)),
            "error": result.isError
        ]
        if let duration, duration.isFinite { entry["duration_ms"] = Int(max(0, duration) * 1000) }
        if let captureError {
            entry["capture_error"] = secret ? "(redacted)" : String(captureError.prefix(1000))
        }
        if let stateError {
            entry["state_error"] = secret ? "(redacted)" : String(stateError.prefix(1000))
        }
        if result.structuredContent?["validation_error"] as? String == "expect" { entry["validation_error"] = "expect" }
        // Keep structured outcome details, never the returned UI tree or
        // clipboard contents. Secret results retain only the status enum.
        if let verification = result.structuredContent?["verification"] as? [String: Any] {
            if secret {
                let statuses: Set<String> = ["verified", "already_satisfied", "no_effect", "target_changed", "timeout"]
                if let status = verification["status"] as? String, statuses.contains(status) {
                    entry["verification"] = ["status": status]
                }
            } else {
                entry["verification"] = Self.recordedArguments(verification, secret: false)
            }
        }
        guard var line = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else { return }
        line.append(0x0A)
        let manager = FileManager.default
        try? manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let size = (try? manager.attributesOfItem(atPath: file.path))?[.size] as? Int, size > Self.maxBytes {
            let previous = file.deletingPathExtension().appendingPathExtension("1.jsonl")
            try? manager.removeItem(at: previous)
            try? manager.moveItem(at: file, to: previous)
        }
        if !manager.fileExists(atPath: file.path) {
            manager.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: file) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: line)
    }

    /// The last `count` entries, one readable line each, for `skfiy log`.
    public func recent(_ count: Int) -> [String] {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").suffix(count).compactMap { line in
            guard let data = line.data(using: .utf8),
                  let entry = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            let time = (entry["time"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
                .map { DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .medium) } ?? "?"
            let arguments = (entry["arguments"] as? [String: Any] ?? [:])
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }
                .joined(separator: " ")
            let captureError = entry["capture_error"] as? String
            let stateError = entry["state_error"] as? String
            let mark = entry["error"] as? Bool == true ? "✘" : captureError != nil || stateError != nil ? "⚠" : "✔"
            return "\(time)  \(mark) \(entry["tool"] as? String ?? "?")  \(arguments)\n      → \(entry["result"] as? String ?? "")"
                + (captureError.map { "\n      → Screenshot unavailable: \($0)" } ?? "")
                + (stateError.map { "\n      → State refresh failed: \($0)" } ?? "")
        }
    }
}
