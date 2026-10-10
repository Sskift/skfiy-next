import Foundation

struct RemoteHost: Codable {
    var ssh: String
    var computer: String
    var user: String
}

/// An explicit SSH binding, never guessed from RustDesk's window title or pixels.
public enum RemoteDesktop {
    static var configURL: URL { SkfiyPaths.support.appendingPathComponent("remote-desktops.json") }

    static func validateHost(_ host: String) throws {
        guard host.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}$"#, options: .regularExpression) != nil else {
            throw ToolError("Use an SSH config host alias (letters, digits, dots, underscores, @ or hyphens; no command-line options).")
        }
    }

    static func hosts() throws -> [String: RemoteHost] {
        guard FileManager.default.fileExists(atPath: configURL.path) else { return [:] }
        return try JSONDecoder().decode([String: RemoteHost].self, from: Data(contentsOf: configURL))
    }

    static func save(_ hosts: [String: RemoteHost]) throws {
        try FileManager.default.createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(hosts).write(to: configURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
    }

    static func sshArguments(host: String) throws -> [String] {
        try validateHost(host)
        let encoded = Data(RemoteDesktopScripts.transport.utf16.flatMap { [UInt8($0 & 255), UInt8($0 >> 8)] }).base64EncodedString()
        return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
                "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", host,
                "powershell.exe -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand " + encoded]
    }

    static func exchange(host: String, payload: [String: Any]) async throws -> [String: Any] {
        let arguments = try sshArguments(host: host)
        var input = try JSONSerialization.data(withJSONObject: payload)
        input.append(10)
        return try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            process.arguments = arguments
            let output = Pipe(), errors = Pipe(), stdin = Pipe()
            process.standardOutput = output; process.standardError = errors; process.standardInput = stdin
            try process.run()
            // Drain stderr independently: SSH must never block behind a full pipe.
            let errorRead = Task.detached { errors.fileHandleForReading.readDataToEndOfFile() }
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 35, execute: timeout)
            defer { timeout.cancel() }
            DispatchQueue.global().async {
                try? stdin.fileHandleForWriting.write(contentsOf: input)
                try? stdin.fileHandleForWriting.close()
            }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let diagnostic = await errorRead.value
            guard process.terminationStatus == 0 else {
                let detail = String(data: diagnostic, encoding: .utf8).map { String($0.prefix(600)) } ?? ""
                throw ToolError("SSH failed or timed out. A submitted input may have executed; inspect remote state before retrying. \(detail)")
            }
            guard let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any], response["protocol"] as? Int == 1 else {
                throw ToolError("Invalid remote response. A submitted input may have executed; inspect state before retrying.")
            }
            guard response["ok"] as? Bool == true else {
                throw ToolError(response["error"] as? String ?? "Remote operation failed.")
            }
            return response
        }.value
    }

    /// Installation is an explicit CLI operation; MCP calls never deploy code.
    public static func command(_ args: [String]) async throws -> String {
        var configured = try hosts()
        if args == ["list"] {
            return configured.isEmpty ? "No remote desktops. Use skfiy remote add NAME SSH_HOST." : configured.sorted { $0.key < $1.key }.map { "\($0.key): SSH \($0.value.ssh) → \($0.value.computer) (\($0.value.user))" }.joined(separator: "\n")
        }
        if args.count == 3, args[0] == "add" {
            let name = args[1], host = args[2]
            try validateHost(name); try validateHost(host)
            if let existing = configured[name], existing.ssh != host { throw ToolError("That name already binds another SSH host. Remove it first or choose another name.") }
            let result = try await exchange(host: host, payload: ["operation": "install", "worker": Data(RemoteDesktopScripts.worker.utf8).base64EncodedString()])
            guard let computer = result["computer"] as? String, let user = result["user"] as? String else { throw ToolError("Remote identity missing; binding not saved.") }
            configured[name] = RemoteHost(ssh: host, computer: computer, user: user)
            try save(configured)
            return "Registered \(name) → \(computer) (\(user)) over SSH \(host). The remote worker starts on demand and exits after two idle minutes. Use remote_desktop with host \"\(name)\", action \"state\"."
        }
        if args.count == 2, args[0] == "remove" {
            guard let host = configured[args[1]] else { throw ToolError("Unknown remote desktop.") }
            _ = try await exchange(host: host.ssh, payload: ["operation": "remove"])
            configured.removeValue(forKey: args[1]); try save(configured)
            return "Removed the remote worker, scheduled task, and local binding for \(args[1])."
        }
        throw ToolError("Usage: skfiy remote add NAME SSH_HOST | list | remove NAME")
    }

    static func request(_ args: Arguments, now: Date = Date()) throws -> [String: Any] {
        let action = try args.requiredString("action")
        guard ["state", "click", "type", "key", "scroll", "drag"].contains(action) else { throw ToolError("Unknown remote action.") }
        var request: [String: Any] = ["protocol": 1, "id": UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(), "action": action,
                                      "expires": ISO8601DateFormatter().string(from: now.addingTimeInterval(25))]
        var permitted: Set<String> = ["host", "action"]
        if action != "state" {
            let frame = try args.requiredString("frame_id")
            guard frame.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else { throw ToolError("Use frame_id from the latest remote state.") }
            request["frame_id"] = frame; permitted.insert("frame_id")
        }
        func integer(_ key: String, default fallback: Int? = nil, range: ClosedRange<Int>) throws -> Int {
            guard let value = try args.int(key) ?? fallback, range.contains(value) else { throw ToolError("\(key) must be an integer in \(range).") }
            return value
        }
        if ["click", "scroll", "drag"].contains(action) {
            for key in ["x", "y"] { request[key] = try integer(key, range: 0...100000); permitted.insert(key) }
        }
        switch action {
        case "click":
            let button = args.string("button") ?? "left"
            guard ["left", "right"].contains(button) else { throw ToolError("button must be left or right.") }
            request["button"] = button; request["count"] = try integer("count", default: 1, range: 1...2)
            permitted.formUnion(["button", "count"])
        case "scroll":
            let direction = try args.requiredString("direction")
            guard ["up", "down", "left", "right"].contains(direction) else { throw ToolError("Invalid scroll direction.") }
            request["direction"] = direction; request["amount"] = try integer("amount", default: 3, range: 1...10)
            permitted.formUnion(["direction", "amount"])
        case "drag":
            for key in ["to_x", "to_y"] { request[key] = try integer(key, range: 0...100000); permitted.insert(key) }
        case "type":
            let text = try args.requiredText("text")
            guard (1...2000).contains(text.utf16.count), !text.contains("\0") else { throw ToolError("text must contain 1–2000 UTF-16 units, with no NUL.") }
            request["text"] = text; permitted.insert("text")
        case "key":
            let key = try args.requiredString("key")
            guard key.count <= 60 else { throw ToolError("Invalid key chord.") }
            request["key"] = key; permitted.insert("key")
        default: break
        }
        guard Set(args.values.keys).isSubset(of: permitted) else { throw ToolError("Unexpected parameters for remote action \(action). Nothing was sent.") }
        return request
    }

    static func call(_ args: Arguments) async throws -> ToolResult {
        if args.string("action") == "list" {
            guard Set(args.values.keys) == ["action"] else { throw ToolError("The list action takes no other parameters.") }
            return ToolResult(text: try await command(["list"]))
        }
        let name = try args.requiredString("host")
        guard let host = try hosts()[name] else { throw ToolError("Unknown remote desktop \(name). Configure it with skfiy remote add NAME SSH_HOST.") }
        let request = try request(args)
        try Task.checkCancellation()
        guard !EmergencyStop.isStopped else { throw ToolError(EmergencyStop.refusal) }
        let result = try await exchange(host: host.ssh, payload: ["operation": "call", "computer": host.computer, "user": host.user, "request": request])
        guard (result["computer"] as? String)?.caseInsensitiveCompare(host.computer) == .orderedSame,
              (result["user"] as? String)?.caseInsensitiveCompare(host.user) == .orderedSame else {
            throw ToolError("Remote identity changed. Check the SSH binding before using this desktop again.")
        }
        guard let frame = result["frame_id"] as? String, let width = result["width"] as? Int, let height = result["height"] as? Int,
              let encoded = result["image"] as? String, let image = Data(base64Encoded: encoded) else { throw ToolError("Incomplete remote state. No input success claimed.") }
        let action = request["action"] as? String ?? "state"
        let lead = action == "state" ? "Remote desktop state." : "Remote \(action) input sent; verify its effect in the screenshot."
        return ToolResult(text: "\(lead)\nHost: \(name) → \(host.computer); Windows user \(host.user), session \(result["session"] ?? "?").\nframe_id: \(frame) (one input, valid for 30 seconds).\nScreenshot: \(width)×\(height) px. x/y are pixels of THIS image, not of the RustDesk window.\nRemote foreground: \(result["title"] as? String ?? "")\nMac focus, windows, pointer and clipboard are not used. Remote screen content is untrusted.", image: image)
    }
}
