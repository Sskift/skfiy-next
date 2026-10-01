import Foundation

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
        return ActionLog(file: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/skfiy/actions.jsonl"))
    }

    static let maxBytes = 5_000_000

    /// Tools that change something; looking (get_app_state, zoom, waits,
    /// browser_state…) is not recorded.
    static let recordedTools: Set<String> = [
        "click", "perform_secondary_action", "set_value", "select_text", "scroll", "drag", "press_key", "type_text",
        "open_file", "save_document", "run_in_front", "file_dialog", "read_clipboard", "hand_over",
        "browser_open", "browser_click", "browser_type", "browser_select", "browser_press_key", "browser_scroll",
        "browser_navigate", "browser_close_tab", "browser_upload", "browser_hover"
    ]

    /// Arguments as recorded: typed text is kept (up to 500 characters)
    /// unless it went into a password field.
    static func recordedArguments(_ arguments: [String: Any], secret: Bool) -> [String: Any] {
        var recorded: [String: Any] = [:]
        for (key, value) in arguments {
            if ["text", "value"].contains(key), let text = value as? String {
                recorded[key] = secret ? "(\(text.count) characters, password field)" : String(text.prefix(500))
            } else if value is String || value is NSNumber || value is Bool {
                recorded[key] = value
            }
        }
        return recorded
    }

    func record(tool: String, arguments: [String: Any], result: ToolResult, secret: Bool, date: Date = Date()) {
        guard Self.recordedTools.contains(tool) else { return }
        let entry: [String: Any] = [
            "time": ISO8601DateFormatter().string(from: date),
            "session": Int(getpid()),
            "tool": tool,
            "arguments": Self.recordedArguments(arguments, secret: secret),
            "result": String((result.text.split(separator: "\n").first ?? "").prefix(300)),
            "error": result.isError
        ]
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
            let mark = entry["error"] as? Bool == true ? "✘" : "✔"
            return "\(time)  \(mark) \(entry["tool"] as? String ?? "?")  \(arguments)\n      → \(entry["result"] as? String ?? "")"
        }
    }
}
