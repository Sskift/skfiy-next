import Foundation
import Testing
@testable import SkfiyKit

private func temporaryFolder(_ name: String) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-\(name)-\(UUID().uuidString)", isDirectory: true)
}

struct PathsTests {
    @Test func homeFollowsTheHomeVariable() {
        #expect(SkfiyPaths.home(environment: ["HOME": "/tmp/skfiy-home"]).path == "/tmp/skfiy-home")
        #expect(SkfiyPaths.home(environment: ["HOME": "/tmp/skfiy-home/"]).path == "/tmp/skfiy-home")
        let real = FileManager.default.homeDirectoryForCurrentUser
        #expect(SkfiyPaths.home(environment: [:]) == real)
        #expect(SkfiyPaths.home(environment: ["HOME": ""]) == real)
        #expect(SkfiyPaths.home(environment: ["HOME": "relative/home"]) == real)
        #expect(SkfiyPaths.home(environment: ["HOME": "/"]) == real)
    }

    @Test func stateFoldersLiveUnderHome() {
        let home = SkfiyPaths.home.path
        #expect(SkfiyPaths.browserExtension.path == home + "/Library/Application Support/skfiy/browser-extension")
        #expect(SkfiyPaths.caches.path == home + "/Library/Caches/skfiy")
        #expect(SkfiyPaths.logs.path == home + "/Library/Logs/skfiy")
        #expect(BrowserBridge.socketDirectory.path.hasPrefix(home + "/Library/Application Support/skfiy/"))
        #expect(Instance.directory.path.hasPrefix(home + "/Library/Caches/skfiy/"))
        #expect(SkfiyPaths.abbreviated(home + "/.local/bin/skfiy") == "~/.local/bin/skfiy")
        #expect(SkfiyPaths.abbreviated("/usr/local/bin/skfiy") == "/usr/local/bin/skfiy")
        #expect(BrowserBridge.expandingTilde("~/x") == home + "/x")
    }
}

struct EmbeddedExtensionTests {
    /// browser-extension/ in this checkout.
    static let source = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("browser-extension", isDirectory: true)

    @Test func matchesTheExtensionFolder() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: Self.source.path).filter { !$0.hasPrefix(".") }.sorted()
        let embedded = Setup.extensionFiles
        #expect(embedded.map(\.name).sorted() == names, "Run scripts/embed_extension.sh (make embed-extension) after changing browser-extension/.")
        for file in embedded {
            let original = try Data(contentsOf: Self.source.appendingPathComponent(file.name))
            #expect(file.data == original, "\(file.name) differs: run scripts/embed_extension.sh")
        }
        let manifest = try Data(contentsOf: Self.source.appendingPathComponent("manifest.json"))
        #expect(Setup.extensionVersion == Setup.manifestVersion(manifest))
    }

    @Test func installsUpdatesAndLeavesAloneWhatIsCurrent() throws {
        let folder = temporaryFolder("extension")
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(try Setup.installExtension(in: folder) == .installed)
        #expect(Setup.installedExtensionVersion(in: folder) == Setup.extensionVersion)

        let background = folder.appendingPathComponent("background.js")
        let past = Date(timeIntervalSince1970: 1_000_000)
        try FileManager.default.setAttributes([.modificationDate: past], ofItemAtPath: background.path)
        #expect(try Setup.installExtension(in: folder) == .unchanged)
        let modified = try FileManager.default.attributesOfItem(atPath: background.path)[.modificationDate] as? Date
        #expect(modified == past)

        try Data("old".utf8).write(to: background)
        try Data("stale".utf8).write(to: folder.appendingPathComponent("removed-in-this-version.js"))
        #expect(try Setup.installExtension(in: folder) == .updated(from: Setup.extensionVersion))
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("removed-in-this-version.js").path))
        #expect(try Data(contentsOf: background) == Setup.extensionFiles.first { $0.name == "background.js" }?.data)
    }
}

struct BridgeInstallTests {
    @Test func registersInstalledBrowsersOnlyAndRemovesThemAgain() throws {
        let support = temporaryFolder("support")
        defer { try? FileManager.default.removeItem(at: support) }
        #expect(try BrowserBridge.install(executable: "/opt/skfiy", support: support).isEmpty)

        let chrome = support.appendingPathComponent("Google/Chrome", isDirectory: true)
        try FileManager.default.createDirectory(at: chrome, withIntermediateDirectories: true)
        let written = try BrowserBridge.install(executable: "/opt/skfiy", support: support)
        #expect(written == [chrome.appendingPathComponent("NativeMessagingHosts/com.skfiy.bridge.json").path])
        #expect(BrowserBridge.installedHosts(support: support).map(\.executable) == ["/opt/skfiy"])

        // Again with the same binary: the file is not rewritten.
        let past = Date(timeIntervalSince1970: 1_000_000)
        try FileManager.default.setAttributes([.modificationDate: past], ofItemAtPath: written[0])
        _ = try BrowserBridge.install(executable: "/opt/skfiy", support: support)
        #expect(try FileManager.default.attributesOfItem(atPath: written[0])[.modificationDate] as? Date == past)
        // A moved binary is picked up.
        _ = try BrowserBridge.install(executable: "/opt/other/skfiy", support: support)
        #expect(BrowserBridge.installedHosts(support: support).map(\.executable) == ["/opt/other/skfiy"])

        #expect(BrowserBridge.uninstall(support: support, keep: { $0 == "/opt/other/skfiy" }).isEmpty)
        #expect(BrowserBridge.uninstall(support: support) == written)
        #expect(BrowserBridge.installedHosts(support: support).isEmpty)
    }
}

struct MCPRegistrationTests {
    static let claudeOutput = """
    skfiy:
      Scope: User config (available in all your projects)
      Status: ✓ Connected
      Type: stdio
      Command: /Users/someone/.local/bin/skfiy
      Args: mcp
      Environment:
        SKFIY_LOCKED_USE=direct
        SKFIY_CURSOR=0

    To remove this server, run: claude mcp remove skfiy -s user
    """

    @Test func readsClaudeCodesEntry() {
        let entry = Setup.parseClaudeEntry(Self.claudeOutput)
        #expect(entry == Setup.MCPEntry(command: "/Users/someone/.local/bin/skfiy", arguments: ["mcp"],
                                        environment: ["SKFIY_LOCKED_USE": "direct", "SKFIY_CURSOR": "0"]))
        let local = Setup.parseClaudeEntry(Self.claudeOutput.replacingOccurrences(of: "User config (available in all your projects)", with: "Local config (private to you in this project)"))
        #expect(local?.userScope == false)
        #expect(Setup.parseClaudeEntry("No MCP server named \"skfiy\". Run `claude mcp add` to add one.") == nil)
    }

    @Test func readsCodexsEntry() {
        let json = #"{"name":"skfiy","enabled":true,"transport":{"type":"stdio","command":"/opt/skfiy","args":["mcp"],"env":{"SKFIY_LOCKED_USE":"direct"},"env_vars":[],"cwd":null}}"#
        #expect(Setup.parseCodexEntry(json) == Setup.MCPEntry(command: "/opt/skfiy", arguments: ["mcp"], environment: ["SKFIY_LOCKED_USE": "direct"]))
        #expect(Setup.parseCodexEntry("Error: No MCP server named 'skfiy' found.") == nil)
    }

    @Test func addsOnlyWhatIsMissingAndKeepsTheUsersSettings() {
        let path = "/Users/someone/.local/bin/skfiy"
        #expect(Setup.registrationCommands(.claude, existing: nil, executable: path, environment: [:])
                == [["mcp", "add", "--scope", "user", "skfiy", "--", path, "mcp"]])
        let current = Setup.parseClaudeEntry(Self.claudeOutput)
        #expect(Setup.registrationCommands(.claude, existing: current, executable: path, environment: [:]).isEmpty)
        #expect(Setup.registrationCommands(.claude, existing: current, executable: path, environment: ["SKFIY_LOCKED_USE": "direct"]).isEmpty)
        // Moved binary: replaced, with the settings the user had.
        #expect(Setup.registrationCommands(.claude, existing: current, executable: "/opt/skfiy", environment: [:]) == [
            ["mcp", "remove", "--scope", "user", "skfiy"],
            ["mcp", "add", "--scope", "user", "skfiy", "-e", "SKFIY_CURSOR=0", "-e", "SKFIY_LOCKED_USE=direct", "--", "/opt/skfiy", "mcp"]
        ])
        // A project-only entry is left alone; the user one is added beside it.
        var local = current
        local?.userScope = false
        #expect(Setup.registrationCommands(.claude, existing: local, executable: path, environment: [:]).count == 1)
        #expect(Setup.registrationCommands(.codex, existing: nil, executable: path, environment: ["SKFIY_LOCKED_USE": "direct"])
                == [["mcp", "add", "skfiy", "--env", "SKFIY_LOCKED_USE=direct", "--", path, "mcp"]])
        #expect(Setup.registrationCommands(.codex, existing: Setup.MCPEntry(command: "/old/skfiy", arguments: ["mcp"], environment: [:]),
                                           executable: path, environment: [:])
                == [["mcp", "remove", "skfiy"], ["mcp", "add", "skfiy", "--", path, "mcp"]])
    }

    @Test func manualCommandsAreReadyToPaste() {
        #expect(Setup.manualCommand(.claude, executable: "/Users/a b/skfiy") == "claude mcp add --scope user skfiy -- '/Users/a b/skfiy' mcp")
        #expect(Setup.manualCommand(.codex, executable: "/opt/skfiy") == "codex mcp add skfiy -- /opt/skfiy mcp")
        #expect(Setup.manualCommand(.claude, executable: "/opt/skfiy", environment: ["SKFIY_LOCKED_USE": "direct", "SKFIY_CURSOR": "0"])
            == "claude mcp add --scope user skfiy -e SKFIY_CURSOR=0 -e SKFIY_LOCKED_USE=direct -- /opt/skfiy mcp")
        #expect(Setup.manualCommand(.codex, executable: "/opt/skfiy", environment: ["SKFIY_LOCKED_USE": "direct"])
            == "codex mcp add skfiy --env SKFIY_LOCKED_USE=direct -- /opt/skfiy mcp")
    }
}

struct SetupChecksTests {
    @Test func flagsSettingsThatWouldDoNothing() {
        #expect(Setup.settingWarnings(environment: ["SKFIY_LOCKED_USE": "direct", "SKFIY_CURSOR": "0"]).isEmpty)
        let old = Setup.settingWarnings(environment: ["SKFIY_LOCKED_USE": "1"])
        #expect(old.count == 1 && old[0].text.contains("direct"))
        #expect(Setup.settingWarnings(environment: ["SKFIY_CURSER": "0"]).first?.text.contains("SKFIY_CURSER") == true)
        // The installer's own variables are not typos.
        #expect(Setup.settingWarnings(environment: ["SKFIY_SOURCE_DIR": "/src", "SKFIY_TEST_FROM_SOURCE": "1", "SKFIY_PREFIX": "/p"]).isEmpty)
    }

    @Test func uninstallLeavesOtherInstallsAlone() throws {
        let folder = temporaryFolder("copies")
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let other = folder.appendingPathComponent("skfiy").path
        #expect(FileManager.default.createFile(atPath: other, contents: Data(), attributes: [.posixPermissions: 0o755]))
        #expect(Setup.isOtherInstall(other, executable: "/tmp/elsewhere/skfiy"))
        #expect(!Setup.isOtherInstall(other, executable: other))
        #expect(!Setup.isOtherInstall(folder.appendingPathComponent("./skfiy").path, executable: other))
        // A registration left pointing at a deleted binary is ours to clean up.
        #expect(!Setup.isOtherInstall(folder.appendingPathComponent("gone").path, executable: other))
        #expect(!Setup.isOtherInstall(nil, executable: other))
    }

    @Test func knowsWhatIsOnPath() {
        #expect(Setup.onPath("/usr/bin", environment: ["PATH": "/bin:/usr/bin/"]))
        #expect(!Setup.onPath("/Users/a/.local/bin", environment: ["PATH": "/bin:/usr/bin"]))
    }

    @Test func findsToolsOnPathOnly() throws {
        let folder = temporaryFolder("tools")
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let tool = folder.appendingPathComponent("codex")
        try Data("#!/bin/sh\necho hi\n".utf8).write(to: tool)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool.path)
        #expect(Setup.findTool("codex", environment: ["PATH": "/nonexistent:" + folder.path]) == tool.path)
        #expect(Setup.findTool("codex", environment: ["PATH": "/nonexistent"]) == nil)
        let result = Setup.run(tool.path, [])
        #expect(result.status == 0 && result.output == "hi\n")
    }

    @MainActor @Test func serverInstructionsMentionMissingPermissions() {
        #expect(MCPServer.setupNote(accessibility: true, screenRecording: true, host: "Ghostty") == "")
        let note = MCPServer.setupNote(accessibility: false, screenRecording: true, host: "Visual Studio Code")
        #expect(note.contains("Accessibility") && !note.contains("Screen Recording") && note.contains("Visual Studio Code"))
        #expect(note.count + ToolSchemas.instructions.count < 2400)
    }
}
