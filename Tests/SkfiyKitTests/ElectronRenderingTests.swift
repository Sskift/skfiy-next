import Foundation
import Darwin
import Testing
@testable import SkfiyKit

@MainActor
struct ElectronRenderingTests {
    private func wire(_ values: String, version: UInt8 = 1, length: UInt8 = 8) -> Data {
        Data("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".utf8) + Data([version, length]) + Data(values.utf8)
    }

    @Test func honorsInspectorFuseAndRejectsUnknownOrTruncatedBinaries() {
        #expect(ElectronRendering.inspectorFuseEnabled(wire("10110001")))
        #expect(!ElectronRendering.inspectorFuseEnabled(wire("10100001")))
        #expect(!ElectronRendering.inspectorFuseEnabled(wire("101r0001")))
        #expect(!ElectronRendering.inspectorFuseEnabled(wire("10110001", version: 2)))
        #expect(!ElectronRendering.inspectorFuseEnabled(wire("1011")))
        #expect(!ElectronRendering.inspectorFuseEnabled(Data("not Electron".utf8)))
        #expect(!ElectronRendering.inspectorFuseEnabled(wire("10110001") + wire("10100001")))
        #expect(ElectronRendering.inspectorFuseEnabled(wire("10110001") + wire("10110001")))
    }

    @Test func neverFollowsInspectorURLsToAnotherHostOrPort() {
        #expect(ElectronRendering.inspectorURL("ws://127.0.0.1:9229/session", port: 9229) != nil)
        for value in ["ws://example.org:9229/session", "ws://127.0.0.1:9230/session",
                      "wss://127.0.0.1:9229/session", "ws://user:password@127.0.0.1:9229/session",
                      "ws://127.0.0.1:9229"] {
            #expect(ElectronRendering.inspectorURL(value, port: 9229) == nil)
        }
    }

    @Test func deadProcessHasNoInspectorEndpoints() {
        #expect(ElectronRendering.loopbackPorts(pid: -1).isEmpty)
    }

    @Test func neverStartsAnInspectorWithCustomNetworkFlags() {
        let header = Data([2, 0, 0, 0])
        #expect(ElectronRendering.defaultInspectorStartup(header + Data("/Electron\0Electron\0app\0NODE_OPTIONS=--max-old-space-size=4096\0".utf8)))
        for option in ["--inspect-port=0.0.0.0:9229", "--inspect-port", "--debug-port=::1:9229", "NODE_OPTIONS=--inspect-port=0.0.0.0:9229"] {
            #expect(!ElectronRendering.defaultInspectorStartup(header + Data(("/Electron\0Electron\0" + option + "\0").utf8)))
        }
        #expect(!ElectronRendering.defaultInspectorStartup(Data()))
        #expect(!ElectronRendering.defaultInspectorStartup(header + Data("/Electron\0Electron\0app\0".utf8)))
    }

    @Test func readsStartupConfigurationFromTheActualTargetProcess() {
        let process = ProcessInfo.processInfo
        let options = process.environment["NODE_OPTIONS"] ?? ""
        let allowed = !process.arguments.contains { $0.hasPrefix("--inspect") || $0.hasPrefix("--debug") }
            && !options.contains("--inspect") && !options.contains("--debug")
        #expect(ElectronRendering.defaultInspectorStartup(process.processIdentifier) == allowed)
    }

    @Test(.enabled(if: Setup.findTool("node") != nil))
    func cancelledCallerStillClosesItsInspectorWithoutStoppingTheTarget() async throws {
        let node = try #require(Setup.findTool("node"))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        // A headless Node inspector exercises the actual socket protocol. The
        // version marker stands in for Electron; no app window is created.
        process.arguments = ["-e", "process.versions.electron='fixture';require('inspector').open(0,'127.0.0.1');setInterval(()=>{},1000)"]
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            if process.isRunning { process.terminate() }
            for _ in 0..<20 where process.isRunning { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
        for _ in 0..<40 where ElectronRendering.loopbackPorts(pid: process.processIdentifier).isEmpty {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(!ElectronRendering.loopbackPorts(pid: process.processIdentifier).isEmpty)
        #expect(ElectronRendering.defaultInspectorStartup(process.processIdentifier))
        let cleanup = Task { await ElectronRendering.closeStartedInspector(pid: process.processIdentifier, endpoint: nil) }
        cleanup.cancel()
        await cleanup.value
        for _ in 0..<40 where !ElectronRendering.loopbackPorts(pid: process.processIdentifier).isEmpty {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(ElectronRendering.loopbackPorts(pid: process.processIdentifier).isEmpty)
        #expect(process.isRunning)
    }
}
