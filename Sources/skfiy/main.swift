import AppKit
import ApplicationServices
import Foundation
import SkfiyKit

let usage = """
skfiy \(skfiyVersion) — macOS computer use for AI agents

Usage:
  skfiy mcp                      Run the MCP server on stdio (what Claude Code launches)
  skfiy doctor                   Check (and request) Accessibility + Screen Recording access
  skfiy tools                    List the tools
  skfiy install-browser-bridge   Register the browser extension's native messaging host
  skfiy call <tool> [json-args]  Run one tool call and print the result; the screenshot
                                 is saved to $SKFIY_SCREENSHOT_OUT (default /tmp/skfiy-screenshot.<ext>)

Register with Claude Code:
  claude mcp add --scope user skfiy -- \(CommandLine.arguments[0].hasPrefix("/") ? CommandLine.arguments[0] : "/path/to/skfiy") mcp
"""

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func doctor() {
    let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let accessibility = AXIsProcessTrustedWithOptions(prompt)
    var screen = CGPreflightScreenCaptureAccess()
    if !screen {
        screen = CGRequestScreenCaptureAccess()
    }
    let host = ProcessInfo.processInfo.environment["TERM_PROGRAM"] ?? "the app that launched skfiy"
    print("Accessibility:    \(accessibility ? "granted" : "MISSING")")
    print("Screen Recording: \(screen ? "granted" : "MISSING")")
    if !accessibility || !screen {
        print("""

        macOS grants these to the host process (\(host)), not to skfiy itself.
        Enable it in System Settings → Privacy & Security → Accessibility / Screen & System Audio Recording,
        then quit and reopen \(host) (and Claude Code).
        """)
        exit(1)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
// The browser launches the native messaging host with the extension origin.
if arguments.first?.hasPrefix("chrome-extension://") == true {
    BrowserBridge.runHost()
}
switch arguments.first {
case "install-browser-bridge":
    var extra: [String] = []
    var rest = arguments.dropFirst()
    while let flag = rest.popFirst() {
        guard flag == "--user-data-dir", let directory = rest.popFirst() else { fail("Usage: skfiy install-browser-bridge [--user-data-dir <dir>]...") }
        extra.append(directory)
    }
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().standardizedFileURL.path
    let absolute = executable.hasPrefix("/") ? executable : FileManager.default.currentDirectoryPath + "/" + executable
    do {
        let written = try BrowserBridge.install(executable: absolute, extraUserDataDirectories: extra)
        guard !written.isEmpty else { fail("No Chromium browser profile folder found. Pass --user-data-dir for a custom profile.") }
        print("Native messaging host registered for \(absolute):")
        written.forEach { print("  \($0)") }
        let installed = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/skfiy/browser-extension").path
        let folder = FileManager.default.fileExists(atPath: installed + "/manifest.json")
            ? installed : "the browser-extension folder of the skfiy repository"
        let connected = BrowserBridge.connectedBrowsers()
        if connected.isEmpty {
            print("""

            Now load the extension (id \(BrowserBridge.extensionID)):
              1. Open chrome://extensions and turn on Developer mode.
              2. Click "Load unpacked" and choose: \(folder)
                 (in the folder dialog, press cmd+shift+G and paste the path).
            Re-run this command if you move the skfiy binary.
            """)
        }
        // chrome.runtime.reload() did not bring the extension back in testing, so this stays manual.
        for browser in connected {
            print("\(browser.name) runs the extension: click the reload button on its skfiy card in chrome://extensions to pick up new files.")
        }
    } catch {
        fail("Could not register the host: \(error.localizedDescription)")
    }

case "mcp":
    Instance.runFromOwnLink()
    atexit { Instance.removeOwnLink() }
    MainActor.assumeIsolated {
        let computerUse = ComputerUse()
        let server = MCPServer(executor: computerUse)
        computerUse.askUser = { [weak server] message in await server?.confirm(message) }
        server.start()
    }
    RunLoop.main.run()

case "doctor":
    doctor()

case "tools":
    for name in ComputerUse.toolNames {
        print(name)
    }

case "call":
    guard arguments.count >= 2 else { fail(usage) }
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

case "-h", "--help", "help", nil:
    print(usage)

case "--version", "version":
    print(skfiyVersion)

default:
    fail(usage)
}
