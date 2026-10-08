import AppKit
import Foundation
import SkfiyKit

let usage = """
skfiy \(skfiyVersion) — macOS computer use for AI agents

Usage:
  skfiy setup                    Finish installing: browser extension files and bridge, Claude Code
                                 registration, permission check. Safe to run again.
  skfiy doctor [--check]         Check the setup; without --check, macOS asks for missing permissions
  skfiy uninstall [--keep-binary]  Undo setup and remove skfiy's files (and this binary)
  skfiy mcp                      Run the MCP server (your MCP client starts it)
  skfiy tools                    List the tools
  skfiy stop | resume | status   Emergency stop for every running skfiy (also ⌃⌥⌘. anywhere)
  skfiy log [N]                  The last N actions skfiy took (~/Library/Logs/skfiy/actions.jsonl)
  skfiy call <tool> [json-args]  Run one tool call and print the result; the screenshot
                                 is saved to $SKFIY_SCREENSHOT_OUT (default /tmp/skfiy-screenshot.<ext>)
  skfiy install-browser-bridge [--user-data-dir <dir>]...
                                 Only the browser part of setup (with --user-data-dir: only the bridge
                                 for that browser profile)

Setup options:
  --codex             also add skfiy to Codex (an existing Codex entry is always kept up to date)
  --no-claude, --no-codex, --no-browser   leave that part alone
  --user-data-dir <dir>                   register the bridge for a custom browser profile too
  -e KEY=VALUE        a setting for the MCP server, e.g. -e SKFIY_LOCKED_USE=direct

Locked computer use (the Mac stays locked): SKFIY_LOCKED_USE=direct in the server's environment.

Register by hand with Claude Code:
  claude mcp add --scope user skfiy -- \(SkfiyPaths.executable) mcp
"""

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

/// Commands that take no arguments: anything extra (even --help) prints the
/// usage instead of running them, so `skfiy stop --help` does not stop skfiy.
func noArguments(_ arguments: [String]) {
    guard arguments.count <= 1 else {
        if ["-h", "--help", "help"].contains(arguments[1]) { print(usage); exit(0) }
        fail("`skfiy \(arguments[0])` takes no arguments.\n\n" + usage)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
signal(SIGPIPE, SIG_IGN)
// The browser launches the native messaging host with the extension origin.
if arguments.first?.hasPrefix("chrome-extension://") == true {
    BrowserBridge.runHost()
}
switch arguments.first {
case "setup", "install-browser-bridge":
    var options = Setup.Options()
    if arguments[0] == "install-browser-bridge" {
        options.claude = false
        options.skipCodex = true
    }
    var rest = arguments.dropFirst()
    while let flag = rest.popFirst() {
        switch flag {
        case "--no-claude": options.claude = false
        case "--codex": options.codex = true
        case "--no-codex": options.skipCodex = true
        case "--no-browser": options.browser = false
        case "--user-data-dir":
            guard let directory = rest.popFirst() else { fail("--user-data-dir needs a folder.") }
            options.userDataDirectories.append(directory)
        case "-e", "--env":
            guard let pair = rest.popFirst(), let equals = pair.firstIndex(of: "="), pair.first != "=" else {
                fail("\(flag) needs KEY=VALUE, e.g. -e SKFIY_LOCKED_USE=direct.")
            }
            options.environment[String(pair[..<equals])] = String(pair[pair.index(after: equals)...])
        case "-h", "--help": print(usage); exit(0)
        default: fail("Unknown option \(flag) for `skfiy \(arguments[0])`.\n\n" + usage)
        }
    }
    if arguments[0] == "install-browser-bridge", !options.userDataDirectories.isEmpty {
        // A test or custom profile: only its bridge manifest, nothing else.
        do {
            let written = try BrowserBridge.install(executable: SkfiyPaths.executable, extraUserDataDirectories: options.userDataDirectories)
            print("Native messaging host registered for \(SkfiyPaths.executable):")
            written.forEach { print("  \($0)") }
        } catch {
            fail("Could not register the host: \(error.localizedDescription)")
        }
        exit(0)
    }
    exit(Setup.run(options))

case "uninstall":
    let rest = Array(arguments.dropFirst())
    guard rest.isEmpty || rest == ["--keep-binary"] else {
        if rest.contains(where: { ["-h", "--help"].contains($0) }) { print(usage); exit(0) }
        fail("Usage: skfiy uninstall [--keep-binary]")
    }
    exit(Setup.uninstall(keepBinary: !rest.isEmpty))

case "doctor":
    let rest = Array(arguments.dropFirst())
    guard rest.isEmpty || rest == ["--check"] else {
        if rest.contains(where: { ["-h", "--help"].contains($0) }) { print(usage); exit(0) }
        fail("Usage: skfiy doctor [--check]")
    }
    exit(Setup.doctor(prompt: rest.isEmpty))

case "mcp":
    if arguments.dropFirst().first == "--locked-use" {
        fail("The experimental --locked-use guardian was removed. To keep macOS locked while skfiy works, set SKFIY_LOCKED_USE=direct in the server's environment instead.")
    }
    guard arguments.dropFirst().isEmpty else {
        fail("Usage: skfiy mcp\n\n" + usage)
    }
    if isatty(STDIN_FILENO) != 0 {
        FileHandle.standardError.write(Data("""
        skfiy mcp talks MCP (JSON-RPC) on stdin and stdout; your MCP client starts it for you.
        To register it with Claude Code: claude mcp add --scope user skfiy -- \(SkfiyPaths.executable) mcp
        Waiting for MCP messages (ctrl-C to quit)…

        """.utf8))
    }
    Instance.runFromOwnLink()
    atexit { Instance.removeOwnLink() }
    Task { @MainActor in
        let computerUse = ComputerUse()
        let server = MCPServer(executor: computerUse)
        computerUse.askUser = { [weak server] message in await server?.confirm(message) }
        computerUse.waitForUser = { [weak server] message in await server?.confirm(message, timeout: 1800) }
        computerUse.clientCanAsk = { [weak server] in server?.clientCanAsk ?? false }
        server.start()
        // The emergency stop shortcut needs an event loop; another skfiy may
        // own it already, so keep trying until this one gets it.
        if !EmergencyStop.registerShortcut() {
            Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { timer in
                MainActor.assumeIsolated {
                    if EmergencyStop.registerShortcut() { timer.invalidate() }
                }
            }
        }
    }
    // An app without a Dock icon or menu bar, so shortcuts reach it.
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.run()

case "stop":
    noArguments(arguments)
    let playing = EmergencyStop.set(stopped: true)
    Thread.sleep(forTimeInterval: playing + 0.1)
    print("skfiy is stopped; every action and read is refused until `skfiy resume` or \(EmergencyStop.shortcut) (only list_apps, get_desktop_status, get_app_capabilities and the locked-use status tools still answer).")

case "resume":
    noArguments(arguments)
    let playing = EmergencyStop.set(stopped: false)
    Thread.sleep(forTimeInterval: playing + 0.1)
    print("skfiy is running again.")

case "log":
    // What skfiy did: the last N actions (default 30).
    guard arguments.count <= 2 else { fail("Usage: skfiy log [N]") }
    var count = 30
    if arguments.count == 2 {
        guard let number = Int(arguments[1]), number > 0 else { fail("Usage: skfiy log [N], where N is a positive number.") }
        count = number
    }
    let lines = ActionLog.standard?.recent(count) ?? []
    print(lines.isEmpty ? "No actions recorded (SKFIY_ACTION_LOG=off turns recording off)." : lines.joined(separator: "\n"))

case "status":
    noArguments(arguments)
    print(EmergencyStop.isStopped ? "stopped (resume with `skfiy resume` or \(EmergencyStop.shortcut))" : "running")

case "tools":
    noArguments(arguments)
    for name in ComputerUse.toolNames {
        print(name)
    }

case "call":
    guard arguments.count >= 2 else { fail("Usage: skfiy call <tool> [json-args]; `skfiy tools` lists the tools.") }
    let name = arguments[1]
    var toolArguments: [String: Any] = [:]
    if arguments.count >= 3 {
        guard let data = arguments[2].data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fail("Arguments must be a JSON object, e.g. '{\"app\": \"TextEdit\"}'.")
        }
        toolArguments = parsed
    }
    Task { @MainActor in
        let result = await ComputerUse().call(name, toolArguments)
        print(result.text)
        if let image = result.image {
            let ext = result.imageMimeType == "image/png" ? "png" : "jpg"
            let path = ProcessInfo.processInfo.environment["SKFIY_SCREENSHOT_OUT"] ?? "/tmp/skfiy-screenshot.\(ext)"
            do {
                try image.write(to: URL(fileURLWithPath: path))
                print("[screenshot: \(path)]")
            } catch {
                fail("Could not save the screenshot to \(path): \(error.localizedDescription)")
            }
        }
        exit(result.isError ? 1 : 0)
    }
    RunLoop.main.run()

case "cursor-overlay":
    // Internal: draws the agent cursor for `skfiy mcp` (see VirtualCursor).
    VirtualCursorOverlay.run()

case "capture-window":
    // Internal: a screenshot in a fresh process, for `skfiy mcp` when its own
    // screen capture stalled.
    Instance.runFromOwnLink()
    atexit { Instance.removeOwnLink() }
    Task { @MainActor in
        let (output, ok) = await captureWindowCommand(Array(arguments.dropFirst()))
        print(output)
        exit(ok ? 0 : 1)
    }
    RunLoop.main.run()

case "-h", "--help", "help", nil:
    print(usage)

case "--version", "version":
    print(skfiyVersion)

default:
    fail("Unknown command \"\(arguments[0])\".\n\n" + usage)
}
