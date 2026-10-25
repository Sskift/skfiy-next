import Darwin
import Foundation
import Testing
@testable import SkfiyKit

struct BrowserCancellationTests {
    @Test func expiredParentBudgetCannotRestartAtTheSocket() {
        BrowserOperation.$deadline.withValue(BrowserDeadline(seconds: 0)) {
            #expect(throws: BrowserDeadlineExceeded.self) {
                try BrowserBridge.request("/nonexistent.sock", method: "act", timeout: 30)
            }
        }
    }

    @Test func cancellationBeforeSocketAttachmentRefusesTheRequest() async throws {
        let cancellation = BrowserRequestCancellation()
        cancellation.cancel()
        #expect(throws: CancellationError.self) { try cancellation.attach(-1) }
        #expect(throws: CancellationError.self) {
            try BrowserBridge.request("/nonexistent.sock", method: "act", cancellation: cancellation)
        }
    }

    @Test func requestWriteSharesTheReadDeadline() async throws {
        let path = "/tmp/skfiy-write-\(UUID().uuidString).sock"
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        try #require(listener >= 0)
        defer { Darwin.close(listener); unlink(path) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        try #require(bound == 0 && listen(listener, 1) == 0)
        let server = blockingTestWorker {
            var poller = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            guard poll(&poller, 1, 3000) > 0 else { return }
            let client = accept(listener, nil, nil)
            guard client >= 0 else { return }
            // The peer deliberately consumes no request bytes.
            Thread.sleep(forTimeInterval: 1.2)
            Darwin.close(client)
        }
        let started = ProcessInfo.processInfo.systemUptime
        do {
            _ = try await BrowserBridge.requestAsync(path, method: "act", params: ["data": String(repeating: "x", count: 4 * 1024 * 1024)], timeout: 0.2)
            Issue.record("The blocked write unexpectedly returned")
        } catch { #expect(error is BrowserDeadlineExceeded) }
        #expect(ProcessInfo.processInfo.systemUptime - started < 0.8)
        await server.value
    }

    @Test func cancelledBridgeReadClosesTheConnectionPromptly() async throws {
        let path = "/tmp/skfiy-cancel-\(UUID().uuidString).sock"
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        try #require(listener >= 0)
        defer { Darwin.close(listener); unlink(path) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { bytes in
            bytes.copyBytes(from: Array(path.utf8) + [0])
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        try #require(bound == 0 && listen(listener, 1) == 0)
        let received = SocketReceipt()
        let server = blockingTestWorker { () -> Bool in
            var poller = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            guard poll(&poller, 1, 3000) > 0 else { return false }
            let client = accept(listener, nil, nil)
            guard client >= 0 else { return false }
            defer { Darwin.close(client) }
            var buffer = [UInt8](repeating: 0, count: 4096)
            guard read(client, &buffer, buffer.count) > 0 else { return false }
            received.mark()
            // Deliberately never reply. Cancellation must close the socket,
            // not wait for the request's 30-second timeout.
            poller = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
            guard poll(&poller, 1, 3000) > 0 else { return false }
            return read(client, &buffer, buffer.count) == 0
        }
        let request = Task {
            try await BrowserBridge.requestAsync(path, method: "act", params: ["action": "click"], timeout: 30)
        }
        defer { request.cancel() }
        for _ in 0..<100 where !received.value { try await Task.sleep(nanoseconds: 10_000_000) }
        try #require(received.value)
        let started = Date()
        request.cancel()
        do { _ = try await request.value; Issue.record("A cancelled bridge request returned a result") }
        catch { #expect(error is CancellationError) }
        #expect(Date().timeIntervalSince(started) < 1)
        #expect(await server.value)
    }
}

private final class SocketReceipt: @unchecked Sendable {
    private let lock = NSLock()
    private var received = false
    func mark() { lock.lock(); received = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return received }
}
