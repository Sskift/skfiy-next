import AppKit
import ApplicationServices
import Foundation

/// `skfiy setup`, `skfiy uninstall` and `skfiy doctor`: everything a single
/// binary needs to finish its own installation. Setup can run any number of
/// times; it changes only what is missing or out of date.
public enum Setup {
    public struct Options {
        public var claude = true
        /// Add skfiy to Codex too. An existing Codex entry is kept up to date either way.
        public var codex = false
        /// Leave Codex alone entirely.
        public var skipCodex = false
        public var browser = true
        public var userDataDirectories: [String] = []
        /// Extra environment for the MCP server registrations (e.g. SKFIY_LOCKED_USE=direct).
        public var environment: [String: String] = [:]
        public init() {}
    }

    // MARK: - Browser extension

    /// The embedded extension files, decoded.
    static var extensionFiles: [(name: String, data: Data)] {
        EmbeddedExtension.files.map { ($0.name, Data(base64Encoded: $0.base64, options: .ignoreUnknownCharacters) ?? Data()) }
    }

    /// The version in the embedded manifest.json.
    public static var extensionVersion: String {
        extensionFiles.first { $0.name == "manifest.json" }.flatMap { manifestVersion($0.data) } ?? "?"
    }

    static func manifestVersion(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["version"] as? String
    }

    /// The version of the extension files in `folder`, if any are installed.
    static func installedExtensionVersion(in folder: URL = SkfiyPaths.browserExtension) -> String? {
        (try? Data(contentsOf: folder.appendingPathComponent("manifest.json"))).flatMap(manifestVersion)
    }

    enum ExtensionChange: Equatable {
        case unchanged, installed, updated(from: String?)
    }

    /// Writes the embedded extension into `folder`, removing files it no
    /// longer has. Files that are already right are not touched.
    static func installExtension(in folder: URL = SkfiyPaths.browserExtension) throws -> ExtensionChange {
        let fileManager = FileManager.default
        let existed = fileManager.fileExists(atPath: folder.appendingPathComponent("manifest.json").path)
        let previous = installedExtensionVersion(in: folder)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        var changed = false
        let files = extensionFiles
        for file in files {
            let url = folder.appendingPathComponent(file.name)
            if (try? Data(contentsOf: url)) != file.data {
                try file.data.write(to: url, options: .atomic)
                changed = true
            }
        }
        let wanted = Set(files.map(\.name))
        for name in (try? fileManager.contentsOfDirectory(atPath: folder.path)) ?? [] where !wanted.contains(name) {
            try fileManager.removeItem(at: folder.appendingPathComponent(name))
            changed = true
        }
        return !existed ? .installed : changed ? .updated(from: previous) : .unchanged
    }

    // MARK: - MCP clients (Claude Code, Codex)

    /// An MCP server entry as a client reports it.
    struct MCPEntry: Equatable {
        var command: String
        var arguments: [String]
        var environment: [String: String]
        /// Claude Code: the entry is in the user config (not one project's).
        var userScope = true
    }

    enum Client: String {
        case claude, codex
        var displayName: String { self == .claude ? "Claude Code" : "Codex" }
    }

    /// Parses `claude mcp get skfiy`.
    static func parseClaudeEntry(_ output: String) -> MCPEntry? {
        var command: String?
        var arguments: [String] = []
        var environment: [String: String] = [:]
        var scope = ""
        var inEnvironment = false
        for line in output.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if inEnvironment {
                if line.hasPrefix("    "), let equals = trimmed.firstIndex(of: "=") {
                    environment[String(trimmed[..<equals])] = String(trimmed[trimmed.index(after: equals)...])
                    continue
                }
                inEnvironment = false
            }
            if trimmed.hasPrefix("Command:") {
                command = trimmed.dropFirst("Command:".count).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("Args:") {
                arguments = trimmed.dropFirst("Args:".count).split(separator: " ").map(String.init)
            } else if trimmed.hasPrefix("Scope:") {
                scope = trimmed
            } else if trimmed == "Environment:" {
                inEnvironment = true
            }
        }
        guard let command, !command.isEmpty else { return nil }
        return MCPEntry(command: command, arguments: arguments, environment: environment,
                        userScope: scope.isEmpty || scope.contains("User"))
    }

    /// Parses `codex mcp get skfiy --json`.
    static func parseCodexEntry(_ output: String) -> MCPEntry? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any],
              let transport = object["transport"] as? [String: Any],
              let command = transport["command"] as? String else { return nil }
        return MCPEntry(command: command, arguments: transport["args"] as? [String] ?? [],
                        environment: transport["env"] as? [String: String] ?? [:])
    }

    /// The commands that make `client` start `executable mcp`, given what it
    /// has now. Keeps environment variables the user already set; empty when
    /// nothing needs to change.
    static func registrationCommands(_ client: Client, existing: MCPEntry?, executable: String,
                                     environment: [String: String]) -> [[String]] {
        var wanted = MCPEntry(command: executable, arguments: ["mcp"], environment: existing?.environment ?? [:])
        wanted.environment.merge(environment) { $1 }
        if let existing, existing.userScope, existing.command == wanted.command,
           existing.arguments == wanted.arguments, existing.environment == wanted.environment {
            return []
        }
        let variables = wanted.environment.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        switch client {
        case .claude:
            let remove = existing?.userScope == true ? [["mcp", "remove", "--scope", "user", "skfiy"]] : []
            return remove + [["mcp", "add", "--scope", "user", "skfiy"] + variables.flatMap { ["-e", $0] } + ["--", executable, "mcp"]]
        case .codex:
            let remove = existing != nil ? [["mcp", "remove", "skfiy"]] : []
            return remove + [["mcp", "add", "skfiy"] + variables.flatMap { ["--env", $0] } + ["--", executable, "mcp"]]
        }
    }

    /// The command a user would type to register skfiy by hand, with the
    /// settings that setup was given.
    static func manualCommand(_ client: Client, executable: String, environment: [String: String] = [:]) -> String {
        let flag = client == .claude ? "-e" : "--env"
        let settings = environment.sorted { $0.key < $1.key }.map { " \(flag) \(shellQuoted("\($0.key)=\($0.value)"))" }.joined()
        return client == .claude
            ? "claude mcp add --scope user skfiy\(settings) -- \(shellQuoted(executable)) mcp"
            : "codex mcp add skfiy\(settings) -- \(shellQuoted(executable)) mcp"
    }

    /// The client's CLI: on PATH, or where its installer puts it under ~.
    static func findTool(_ name: String, environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let directories = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
            + (name == "claude" ? [SkfiyPaths.home.path + "/.claude/local"] : [])
        return directories.map { $0 + "/" + name }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Runs a tool and returns its exit status and combined output.
    static func run(_ tool: String, _ arguments: [String], timeout: TimeInterval = 90) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return (-1, error.localizedDescription) }
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        deadline.cancel()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    /// What `client` has registered as skfiy now (nil: nothing).
    static func currentEntry(_ client: Client, tool: String) -> MCPEntry? {
        switch client {
        case .claude:
            let result = run(tool, ["mcp", "get", "skfiy"])
            return result.status == 0 ? parseClaudeEntry(result.output) : nil
        case .codex:
            let result = run(tool, ["mcp", "get", "skfiy", "--json"])
            return result.status == 0 ? parseCodexEntry(result.output) : nil
        }
    }

    /// Registers skfiy with one client, or with `add` false only updates an
    /// entry that is already there; returns a line for the report.
    static func register(_ client: Client, add: Bool, executable: String, environment: [String: String]) -> Line? {
        guard let tool = findTool(client.rawValue) else {
            return !add ? nil : Line(.skipped, "\(client.displayName): not installed. To add skfiy later: \(manualCommand(client, executable: executable, environment: environment))")
        }
        let existing = currentEntry(client, tool: tool)
        if existing == nil, !add {
            return Line(.skipped, "\(client.displayName): skfiy is not added. To use it there too: `skfiy setup --\(client.rawValue)` or \(manualCommand(client, executable: executable, environment: environment))")
        }
        let commands = registrationCommands(client, existing: existing, executable: executable, environment: environment)
        if commands.isEmpty {
            return Line(.ok, "\(client.displayName): skfiy is registered (\(abbreviated(executable)) mcp)")
        }
        for arguments in commands {
            let result = run(tool, arguments)
            if result.status != 0 {
                let reason = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
                return Line(.failed, "\(client.displayName): `\(client.rawValue) \(arguments.joined(separator: " "))` failed: \(reason). Register by hand: \(manualCommand(client, executable: executable, environment: (existing?.environment ?? [:]).merging(environment) { $1 }))")
            }
        }
        let verb = existing == nil ? "registered skfiy" : "updated the skfiy entry"
        return Line(.ok, "\(client.displayName): \(verb) (\(abbreviated(executable)) mcp); restart running sessions to use it")
    }

    // MARK: - Report lines

    struct Line {
        enum Mark: String { case ok = "✓", failed = "✗", skipped = "·", warning = "!" }
        let mark: Mark
        let text: String
        init(_ mark: Mark, _ text: String) { self.mark = mark; self.text = text }
        var rendered: String { "\(mark.rawValue) \(text)" }
    }

    static func abbreviated(_ path: String) -> String { SkfiyPaths.abbreviated(path) }

    static func shellQuoted(_ text: String) -> String {
        text.allSatisfy({ $0.isLetter || $0.isNumber || "/._-+~=".contains($0) }) ? text : "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    // MARK: - Checks shared with doctor

    static func permissionLines(host: String) -> (lines: [Line], missing: [String]) {
        let accessibility = AXIsProcessTrusted()
        let screen = CGPreflightScreenCaptureAccess()
        let missing = (accessibility ? [] : ["Accessibility"]) + (screen ? [] : ["Screen Recording"])
        return ([
            Line(accessibility ? .ok : .failed, "Accessibility: \(accessibility ? "granted" : "missing") (\(host))"),
            Line(screen ? .ok : .failed, "Screen Recording: \(screen ? "granted" : "missing") (\(host))")
        ], missing)
    }

    /// Whether `directory` is on $PATH.
    static func onPath(_ directory: String, environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        let wanted = URL(fileURLWithPath: directory).standardizedFileURL.path
        return (environment["PATH"] ?? "").split(separator: ":").contains {
            URL(fileURLWithPath: String($0)).standardizedFileURL.path == wanted
        }
    }

    static func pathLine(executable: String) -> Line? {
        let directory = (executable as NSString).deletingLastPathComponent
        guard !onPath(directory) else { return nil }
        let shown = directory == SkfiyPaths.home.path + "/.local/bin" ? "$HOME/.local/bin" : directory
        return Line(.warning, "\(abbreviated(directory)) is not on your PATH, so type the full path (\(abbreviated(executable))) or run: echo 'export PATH=\"\(shown):$PATH\"' >> ~/.zprofile")
    }

    /// Settings with a value skfiy does not understand; they would silently do nothing.
    static func settingWarnings(environment: [String: String] = ProcessInfo.processInfo.environment) -> [Line] {
        var lines: [Line] = []
        if let value = environment["SKFIY_LOCKED_USE"], !value.isEmpty, value != "direct" {
            lines.append(Line(.warning, "SKFIY_LOCKED_USE=\(value) is not recognized, so locked use stays off; the only value is direct"))
        }
        let known: Set<String> = [
            "SKFIY_LOCKED_USE", "SKFIY_LOCKED_WAKE_DISPLAY", "SKFIY_BRIEF_FOCUS", "SKFIY_ALLOW_TERMINALS", "SKFIY_CURSOR",
            "SKFIY_CURSOR_IDLE", "SKFIY_ACTION_LOG", "SKFIY_SETTLE_SECONDS", "SKFIY_SCREENSHOT_FORMAT", "SKFIY_SCREENSHOT_OUT",
            "SKFIY_STOP_FILE", "SKFIY_FLOW_DIR", "SKFIY_WAIT_EVENTS", "SKFIY_FRONT_GRANT_FILE", "SKFIY_OCR_DUMP",
            "SKFIY_SIMULATE_CAPTURE_STALL", "SKFIY_UPLOAD_WITHOUT_ASKING", "SKFIY_INSTANCE", "SKFIY_GUARDIAN",
            // install.sh, scripts/test_install.sh and the locked-use build
            "SKFIY_PREFIX", "SKFIY_VERSION", "SKFIY_RELEASE_URL", "SKFIY_REPO", "SKFIY_SOURCE_DIR", "SKFIY_TEST_FROM_SOURCE",
            "SKFIY_SOCKET_ROOT", "SKFIY_PLUGINS", "SKFIY_RIGHTS", "SKFIY_SIGN_IDENTITY"
        ]
        for name in environment.keys.sorted() where name.hasPrefix("SKFIY_") && !known.contains(name) {
            lines.append(Line(.warning, "\(name) is set but skfiy does not read it (a typo?)"))
        }
        return lines
    }

    /// MCP servers still running a binary that has since been replaced.
    static func staleServers(executable: String) -> [pid_t] {
        var current = stat()
        guard stat((executable as NSString).resolvingSymlinksInPath, &current) == 0 else { return [] }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Instance.directory.path)) ?? []
        return names.compactMap { name -> pid_t? in
            guard name.hasPrefix("skfiy-"), let pid = pid_t(name.dropFirst("skfiy-".count)), kill(pid, 0) == 0 || errno == EPERM else { return nil }
            var link = stat()
            guard stat(Instance.directory.appendingPathComponent(name).path, &link) == 0 else { return nil }
            return link.st_ino == current.st_ino && link.st_dev == current.st_dev ? nil : pid
        }.sorted()
    }

    static func browserLines(executable: String) -> (lines: [Line], loadExtension: Bool) {
        var lines: [Line] = []
        let installed = installedExtensionVersion()
        let folder = abbreviated(SkfiyPaths.browserExtension.path)
        if let installed {
            let current = installed == extensionVersion
            lines.append(Line(current ? .ok : .warning, "Browser extension files: \(folder) (\(installed)\(current ? "" : "; this skfiy carries \(extensionVersion), run `skfiy setup`"))"))
        } else {
            lines.append(Line(.skipped, "Browser extension files: not installed (`skfiy setup` installs them)"))
        }
        let hosts = BrowserBridge.installedHosts()
        if hosts.isEmpty {
            lines.append(Line(.skipped, BrowserBridge.installedBrowserFolders().isEmpty
                ? "Browser bridge: no Chromium browser (Chrome, Edge, Brave…) found; the browser tools are optional"
                : "Browser bridge: not registered (`skfiy setup` registers it)"))
        }
        for host in hosts {
            let browser = URL(fileURLWithPath: host.manifest).deletingLastPathComponent().deletingLastPathComponent().lastPathComponent
            let target = host.executable ?? "?"
            if !FileManager.default.isExecutableFile(atPath: target) {
                lines.append(Line(.failed, "Browser bridge (\(browser)): points at \(abbreviated(target)), which does not exist; run `skfiy setup`"))
            } else if target != executable {
                lines.append(Line(.warning, "Browser bridge (\(browser)): points at \(abbreviated(target)), not this skfiy"))
            } else {
                lines.append(Line(.ok, "Browser bridge (\(browser)): registered"))
            }
        }
        let connected = BrowserBridge.connectedBrowsers()
        for browser in connected {
            let version = browser.version ?? "?"
            lines.append(version == extensionVersion
                ? Line(.ok, "\(browser.name) is connected (extension \(version))")
                : Line(.warning, "\(browser.name) runs extension \(version), skfiy carries \(extensionVersion): click reload on the skfiy card in chrome://extensions"))
        }
        return (lines, connected.isEmpty && !hosts.isEmpty)
    }

    static let loadExtensionSteps = """
    Load the browser extension (optional; lets skfiy use background tabs in your Chrome):
         open chrome://extensions, turn on Developer mode, click "Load unpacked" and choose
         \(SkfiyPaths.browserExtension.path)
         (in the folder dialog press cmd+shift+G and paste the path).
    """

    // MARK: - Commands

    /// `skfiy setup`. Returns the exit status.
    public static func run(_ options: Options) -> Int32 {
        let executable = SkfiyPaths.executable
        var lines: [Line] = []
        var todo: [String] = []
        var failed = false
        print("skfiy \(skfiyVersion) setup: \(abbreviated(executable))\n")

        if options.browser {
            do {
                let change = try installExtension()
                let folder = abbreviated(SkfiyPaths.browserExtension.path)
                switch change {
                case .unchanged: lines.append(Line(.ok, "Browser extension files: \(folder) (\(extensionVersion), up to date)"))
                case .installed: lines.append(Line(.ok, "Browser extension files: installed \(extensionVersion) in \(folder)"))
                case .updated(let from): lines.append(Line(.ok, "Browser extension files: updated \(from ?? "?") → \(extensionVersion) in \(folder)"))
                }
                var written = try BrowserBridge.install(executable: executable)
                if !options.userDataDirectories.isEmpty {
                    written += try BrowserBridge.install(executable: executable, extraUserDataDirectories: options.userDataDirectories)
                }
                if written.isEmpty {
                    lines.append(Line(.skipped, "Browser bridge: no Chromium browser (Chrome, Edge, Brave…) found; the browser tools are optional. Run `skfiy setup` again after installing one"))
                } else {
                    let names = written.map { URL(fileURLWithPath: $0).deletingLastPathComponent().deletingLastPathComponent().lastPathComponent }
                    lines.append(Line(.ok, "Browser bridge: registered for \(names.joined(separator: ", "))"))
                    let connected = BrowserBridge.connectedBrowsers()
                    if connected.isEmpty {
                        todo.append(loadExtensionSteps)
                    } else if change != .unchanged {
                        // chrome.runtime.reload() did not bring the extension back in testing, so this stays manual.
                        for browser in connected {
                            todo.append("\(browser.name) runs the old extension files: click the reload button on the skfiy card in chrome://extensions.")
                        }
                    }
                }
            } catch {
                lines.append(Line(.failed, "Browser extension: \(error.localizedDescription)"))
                failed = true
            }
        }

        var registered = false
        for (client, wanted, add) in [(Client.claude, options.claude, true), (.codex, !options.skipCodex, options.codex)] {
            guard wanted else { continue }
            guard let line = register(client, add: add, executable: executable, environment: options.environment) else { continue }
            lines.append(line)
            if line.mark == .failed { failed = true }
            if line.mark == .ok { registered = true }
        }
        if !options.claude {
            lines.append(Line(.skipped, "Claude Code: left alone. To add skfiy: \(manualCommand(.claude, executable: executable, environment: options.environment))"))
        } else if !registered {
            todo.append("Add skfiy to your MCP client (commands above). Any other MCP client: command \(executable), argument mcp.")
        }

        let host = hostApplicationName()
        let permissions = permissionLines(host: host)
        lines += permissions.lines
        if !permissions.missing.isEmpty {
            todo.insert("""
            Grant \(permissions.missing.joined(separator: " and ")) to the app that runs Claude Code (here: \(host)), not to skfiy:
                 run `\(abbreviated(executable)) doctor` in it to get the macOS prompts, or enable it in System Settings → Privacy & Security.
                 Then quit and reopen \(host) and Claude Code.
            """, at: 0)
        }
        if let line = pathLine(executable: executable) { lines.append(line) }
        lines += settingWarnings(environment: ProcessInfo.processInfo.environment.merging(options.environment) { $1 })

        lines.forEach { print($0.rendered) }
        if !todo.isEmpty {
            print("\nStill to do:")
            for (index, step) in todo.enumerated() { print("  \(index + 1). \(step)") }
        } else {
            print("\nDone. In Claude Code, ask for something like \"Open Notes and make a new note\".")
        }
        return failed ? 1 : 0
    }

    /// True when `path` is another skfiy binary that still exists, so what
    /// points at it belongs to another install and uninstall leaves it alone.
    static func isOtherInstall(_ path: String?, executable: String) -> Bool {
        guard let path, !path.isEmpty else { return false }
        let resolved = { ((BrowserBridge.expandingTilde($0) as NSString).resolvingSymlinksInPath as NSString).standardizingPath }
        return resolved(path) != resolved(executable) && FileManager.default.isExecutableFile(atPath: resolved(path))
    }

    /// `skfiy uninstall`: undoes what setup did for this binary. Registrations
    /// and host manifests that launch another skfiy binary still on disk are
    /// left alone, and so are the shared folders while that install uses them.
    /// The binary goes too unless `keepBinary`.
    public static func uninstall(keepBinary: Bool) -> Int32 {
        let executable = SkfiyPaths.executable
        var failed = false
        var others: Set<String> = []
        for client in [Client.claude, .codex] {
            guard let tool = findTool(client.rawValue) else { continue }
            guard let entry = currentEntry(client, tool: tool) else {
                print("· \(client.displayName): skfiy is not registered")
                continue
            }
            guard client == .codex || entry.userScope else {
                print("! \(client.displayName): skfiy is registered for one project only; remove it there with `claude mcp remove skfiy`")
                continue
            }
            guard !isOtherInstall(entry.command, executable: executable) else {
                print("! \(client.displayName): skfiy runs \(abbreviated(entry.command)), another copy; left registered (uninstall with that copy)")
                others.insert(entry.command)
                continue
            }
            let arguments = client == .claude ? ["mcp", "remove", "--scope", "user", "skfiy"] : ["mcp", "remove", "skfiy"]
            let result = run(tool, arguments)
            if result.status == 0 {
                print("✓ \(client.displayName): removed skfiy")
            } else {
                print("✗ \(client.displayName): `\(client.rawValue) \(arguments.joined(separator: " "))` failed: \(result.output.trimmingCharacters(in: .whitespacesAndNewlines))")
                failed = true
            }
        }
        let other = { isOtherInstall($0, executable: executable) }
        for host in BrowserBridge.installedHosts() where other(host.executable) {
            print("! Kept \(abbreviated(host.manifest)): it launches \(abbreviated(host.executable ?? "")), another copy")
            others.insert(host.executable ?? "")
        }
        for file in BrowserBridge.uninstall(keep: other) {
            print("✓ Removed \(abbreviated(file))")
        }
        if !others.isEmpty {
            print("! Kept \(abbreviated(SkfiyPaths.support.path)) and skfiy's caches and logs: \(others.sorted().map(abbreviated).joined(separator: ", ")) still uses them")
        }
        for folder in [SkfiyPaths.support, SkfiyPaths.caches, SkfiyPaths.logs] where others.isEmpty && FileManager.default.fileExists(atPath: folder.path) {
            do {
                try FileManager.default.removeItem(at: folder)
                print("✓ Removed \(abbreviated(folder.path))")
            } catch {
                print("✗ Could not remove \(abbreviated(folder.path)): \(error.localizedDescription)")
                failed = true
            }
        }
        let resolved = (executable as NSString).resolvingSymlinksInPath
        if keepBinary {
            print("· Kept \(abbreviated(executable))")
        } else if resolved.contains("/Cellar/") {
            print("· \(abbreviated(executable)) belongs to Homebrew: run `brew uninstall skfiy`")
        } else if (try? FileManager.default.removeItem(atPath: executable)) != nil {
            print("✓ Removed \(abbreviated(executable))")
        } else {
            print("✗ Could not remove \(abbreviated(executable))")
            failed = true
        }
        print("""

        Left for you: remove the skfiy card in chrome://extensions if you loaded the extension,
        and restart Claude Code sessions that still run skfiy.
        """)
        return failed ? 1 : 0
    }

    /// `skfiy doctor`. With `prompt`, macOS shows its permission prompts for
    /// whatever is missing; without, it only reports. Returns the exit
    /// status: non-zero when a required permission is missing.
    public static func doctor(prompt: Bool) -> Int32 {
        let executable = SkfiyPaths.executable
        let host = hostApplicationName()
        if prompt {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        }
        print("skfiy \(skfiyVersion): \(abbreviated(executable))\n")
        let permissions = permissionLines(host: host)
        var lines = permissions.lines
        if let line = pathLine(executable: executable) { lines.append(line) }
        // The server runs with the settings in its registration, not doctor's own.
        var settings = ProcessInfo.processInfo.environment
        if let tool = findTool("claude") {
            if let entry = currentEntry(.claude, tool: tool) {
                settings.merge(entry.environment) { $1 }
                let ours = entry.command == executable && entry.arguments == ["mcp"]
                lines.append(Line(ours ? .ok : .warning, "Claude Code: skfiy runs \(abbreviated(entry.command)) \(entry.arguments.joined(separator: " "))\(ours ? "" : " (not this binary; `skfiy setup` updates it)")"))
            } else {
                lines.append(Line(.warning, "Claude Code: skfiy is not registered (`skfiy setup` registers it)"))
            }
        }
        let browser = browserLines(executable: executable)
        lines += browser.lines
        if EmergencyStop.isStopped {
            lines.append(Line(.warning, "Emergency stop is on: every action is refused until `skfiy resume` or \(EmergencyStop.shortcut)"))
        }
        let stale = staleServers(executable: executable)
        if !stale.isEmpty {
            lines.append(Line(.warning, "\(stale.count) running skfiy server\(stale.count == 1 ? "" : "s") (pid \(stale.map(String.init).joined(separator: ", "))) still use\(stale.count == 1 ? "s" : "") an older build: restart those Claude Code sessions"))
        }
        if settings["SKFIY_LOCKED_USE"] == "direct" {
            lines.append(Line(.ok, "Locked use: direct"))
        }
        lines += settingWarnings(environment: settings)
        lines.forEach { print($0.rendered) }
        if browser.loadExtension {
            print("\n" + loadExtensionSteps)
        }
        if !permissions.missing.isEmpty {
            print("""

            macOS grants these to the app hosting skfiy (\(host)), not to skfiy itself.
            Enable them in System Settings → Privacy & Security → Accessibility / Screen & System Audio Recording,
            then quit and reopen \(host) (and Claude Code).
            """)
            return 1
        }
        return 0
    }
}
