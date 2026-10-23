import AppKit
import Darwin
import Foundation

/// The browser bridge: a Chromium extension talks to `skfiy` through native
/// messaging; `skfiy mcp` talks to that host process over a per-user Unix
/// socket, so any number of MCP sessions can share one browser.
///
///   extension ⇄ (stdio, native messaging) ⇄ skfiy host ⇄ (unix socket) ⇄ skfiy mcp
public enum BrowserBridge {
    public static let hostName = "com.skfiy.bridge"
    public static let extensionID = "fkllhjogckpegfdomkajlkmjaaahnhbd"

    static var socketDirectory: URL {
        SkfiyPaths.support.appendingPathComponent("browsers", isDirectory: true)
    }
}

// MARK: - Native messaging framing

/// Chrome's native messaging frame: a 32-bit native-endian length, then JSON.
public enum NativeMessage {
    static let maximumBytes = 32 * 1024 * 1024
    public static func encode(_ payload: Data) -> Data {
        var length = UInt32(payload.count).littleEndian
        return Data(bytes: &length, count: 4) + payload
    }

    /// Splits complete frames off the front of `buffer`.
    public static func decode(_ buffer: inout Data) throws -> [Data] {
        var messages: [Data] = []
        while buffer.count >= 4 {
            let length = buffer.prefix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
            guard length <= maximumBytes else { throw ToolError("The browser bridge message exceeds 32 MiB.") }
            guard buffer.count >= 4 + Int(length) else { break }
            messages.append(Data(buffer.dropFirst(4).prefix(Int(length))))
            buffer = Data(buffer.dropFirst(4 + Int(length)))
        }
        return messages
    }
}

// MARK: - Unix sockets

private func socketAddress(_ path: String) -> sockaddr_un? {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
}

private func noSigPipe(_ fd: Int32) {
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
}

private func nonblocking(_ fd: Int32) {
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
}

private func socketReady(_ fd: Int32, event: Int16, deadline: BrowserDeadline) -> Bool {
    while deadline.remaining > 0 {
        var descriptor = pollfd(fd: fd, events: event, revents: 0)
        let ready = poll(&descriptor, 1, Int32(ceil(min(3600, deadline.remaining) * 1000)))
        if ready < 0 && errno == EINTR { continue }
        return ready > 0 && descriptor.revents & event != 0
    }
    return false
}

private func writeAll(_ fd: Int32, _ data: Data, deadline: BrowserDeadline) -> Bool {
    data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count, deadline.remaining > 0 {
            let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if written < 0 && errno == EINTR { continue }
            if written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                if socketReady(fd, event: Int16(POLLOUT), deadline: deadline) { continue }
                return false
            }
            guard written > 0 else { return false }
            offset += written
        }
        return offset == raw.count
    }
}

/// Replies never run on the native browser reader. A stalled peer has a
/// bounded queue and write deadline. Strong ownership keeps the descriptor
/// alive until both the reader and any in-flight write have finished.
final class BridgeClient: @unchecked Sendable {
    let fd: Int32
    private let lock = NSLock()
    private var queue: [Data] = []
    private var queuedBytes = 0
    private var writing = false
    private var stopped = false
    private let timeout: TimeInterval
    private let maximumQueuedBytes: Int
    init(_ fd: Int32, timeout: TimeInterval = 5, maximumQueuedBytes: Int = NativeMessage.maximumBytes * 2 + 2) {
        self.fd = fd; self.timeout = timeout; self.maximumQueuedBytes = maximumQueuedBytes
        noSigPipe(fd); nonblocking(fd)
    }
    deinit { Darwin.close(fd) }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return }
        stopped = true; queue.removeAll(); queuedBytes = 0
        _ = shutdown(fd, SHUT_RDWR)
    }

    func reply(_ object: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: object) else { return }
        let data = json + Data([10])
        lock.lock()
        if stopped { lock.unlock(); return }
        guard data.count <= NativeMessage.maximumBytes + 1, queue.count < 16,
              queuedBytes + data.count <= maximumQueuedBytes else {
            lock.unlock(); stop(); return
        }
        queue.append(data); queuedBytes += data.count
        let start = !writing
        writing = true
        lock.unlock()
        if start { DispatchQueue.global(qos: .userInitiated).async { self.drain() } }
    }

    private func next() -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard !stopped, !queue.isEmpty else { writing = false; return nil }
        return queue.removeFirst()
    }

    private func drain() {
        while let data = next() {
            guard writeAll(fd, data, deadline: BrowserDeadline(seconds: timeout)) else { stop(); return }
            lock.lock(); if !stopped { queuedBytes -= data.count }; lock.unlock()
        }
    }
}

/// One reader per connection retains coalesced messages. Chunked reads avoid
/// two system calls per byte for base64 screenshots; lengths remain bounded.
final class BridgeLineReader {
    private var buffer = Data()
    private(set) var reads = 0
    private let maximumBytes: Int
    init(maximumBytes: Int = NativeMessage.maximumBytes) { self.maximumBytes = maximumBytes }

    func line(_ fd: Int32, timeout: TimeInterval) throws -> Data? {
        let started = ProcessInfo.processInfo.systemUptime
        var searched = buffer.startIndex
        var chunk = [UInt8](repeating: 0, count: 65_536)
        while true {
            if let newline = buffer[searched...].firstIndex(of: 0x0A) {
                guard newline - buffer.startIndex <= maximumBytes else { throw ToolError("The browser bridge line is too large.") }
                let line = Data(buffer[..<newline])
                buffer = Data(buffer[buffer.index(after: newline)...])
                return line
            }
            guard buffer.count <= maximumBytes else { throw ToolError("The browser bridge line is too large.") }
            let remaining = timeout - (ProcessInfo.processInfo.systemUptime - started)
            guard remaining > 0 else { return nil }
            var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&poller, 1, Int32(ceil(min(remaining, 3600) * 1000)))
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0 else { return nil }
            let count = read(fd, &chunk, chunk.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return nil }
            reads += 1
            searched = buffer.endIndex
            buffer.append(contentsOf: chunk[..<count])
        }
    }
}

/// Owns shutdown, not just Task cancellation: a detached socket reader must
/// actually wake up. The lock keeps shutdown from touching a reused fd.
final class BrowserRequestCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var fd: Int32?
    private var cancelled = false

    func attach(_ descriptor: Int32) throws {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw CancellationError() }
        fd = descriptor
    }

    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        if let fd { _ = shutdown(fd, SHUT_RDWR) }
    }

    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
    }

    func close(_ descriptor: Int32) {
        lock.lock(); defer { lock.unlock() }
        fd = nil
        Darwin.close(descriptor)
    }
}

// MARK: - Host (launched by the browser)

extension BrowserBridge {
    /// Runs as the native messaging host until the browser closes the pipe.
    public static func runHost() -> Never {
        signal(SIGPIPE, SIG_IGN)
        let host = Host()
        host.start()
    }

    private final class Host: @unchecked Sendable {
        private let lock = NSLock()
        private var pending: [Int: (client: BridgeClient, id: Any)] = [:]
        private var nextID = 1
        private var hello: [String: Any] = [:]
        private var socketPath = ""
        private var socketInode: ino_t = 0

        func start() -> Never {
            let directory = BrowserBridge.socketDirectory
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            // One socket per browser process; the parent is the browser.
            socketPath = directory.appendingPathComponent("\(getppid()).sock").path
            let server = listenSocket()
            if server >= 0 {
                Thread { self.acceptLoop(server) }.start()
            }
            nonblocking(STDOUT_FILENO)
            readBrowser()
            removeOwnSocket()
            exit(0)
        }

        /// When the extension reconnects, the next host for the same browser
        /// can be listening at this path before this one exits; its socket
        /// is not this host's to remove.
        private func removeOwnSocket() {
            var info = stat()
            if socketInode != 0, stat(socketPath, &info) == 0, info.st_ino == socketInode { unlink(socketPath) }
        }

        /// Listens on a temporary name and renames it into place, so the
        /// socket never appears before it accepts: a client connecting
        /// between bind and listen would be refused and take it for stale.
        private func listenSocket() -> Int32 {
            let staging = socketPath + ".\(getpid()).new"
            guard var address = socketAddress(staging) else { return -1 }
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { return -1 }
            unlink(staging)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard bound == 0 else { close(fd); return -1 }
            chmod(staging, 0o600)
            guard listen(fd, 16) == 0, rename(staging, socketPath) == 0 else { unlink(staging); close(fd); return -1 }
            var info = stat()
            if stat(socketPath, &info) == 0 { socketInode = info.st_ino }
            return fd
        }

        private func acceptLoop(_ server: Int32) {
            while true {
                let client = accept(server, nil, nil)
                guard client >= 0 else { continue }
                let connection = BridgeClient(client)
                Thread { self.serve(connection) }.start()
            }
        }

        /// One JSON request per line; the reply comes back on the same connection.
        private func serve(_ client: BridgeClient) {
            let reader = BridgeLineReader()
            while let line = try? reader.line(client.fd, timeout: 3600) {
                guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                let clientID = request["id"] ?? NSNull()
                let method = request["method"] as? String ?? ""
                if method == "hello" {
                    lock.lock()
                    let info = hello
                    lock.unlock()
                    client.reply(["id": clientID, "result": info])
                    continue
                }
                lock.lock()
                let hostID = nextID
                nextID += 1
                pending[hostID] = (client, clientID)
                lock.unlock()
                let message: [String: Any] = ["id": hostID, "method": method, "params": request["params"] ?? [:]]
                guard let payload = try? JSONSerialization.data(withJSONObject: message) else { continue }
                lock.lock()
                guard writeAll(STDOUT_FILENO, NativeMessage.encode(payload), deadline: BrowserDeadline(seconds: 5)) else { exit(1) }
                lock.unlock()
            }
            lock.lock()
            let abandoned = pending.filter { $0.value.client === client }.map(\.key)
            pending = pending.filter { $0.value.client !== client }
            // A cancelled caller closes its socket. Withdraw work still
            // waiting in the extension before its next input is dispatched.
            for id in abandoned {
                if let data = try? JSONSerialization.data(withJSONObject: ["method": "cancel", "params": ["request_id": id]]) {
                    guard writeAll(STDOUT_FILENO, NativeMessage.encode(data), deadline: BrowserDeadline(seconds: 5)) else { exit(1) }
                }
            }
            lock.unlock()
            client.stop()
        }

        private func readBrowser() {
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(0, &chunk, chunk.count)
                guard count > 0 else { return }
                buffer.append(contentsOf: chunk[0..<count])
                guard let messages = try? NativeMessage.decode(&buffer) else { return }
                for payload in messages {
                    guard let message = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { continue }
                    if message["event"] as? String == "hello" {
                        lock.lock()
                        hello = message.filter { $0.key != "event" }
                        hello["pid"] = Int(getppid())
                        lock.unlock()
                        continue
                    }
                    guard let hostID = message["id"] as? Int else { continue }
                    lock.lock()
                    let waiter = pending.removeValue(forKey: hostID)
                    lock.unlock()
                    guard let waiter else { continue }
                    var response: [String: Any] = ["id": waiter.id]
                    if let error = message["error"] { response["error"] = error } else { response["result"] = message["result"] ?? NSNull() }
                    waiter.client.reply(response)
                }
            }
        }
    }
}

// MARK: - Client (used by the MCP server)

public struct ConnectedBrowser {
    public let socketPath: String
    public let name: String
    public let pid: Int
    /// The extension's version, as its hello message reported it.
    public var version: String? = nil
    public var snapshotProtocol: Int? = nil
}

extension BrowserBridge {
    /// One request to one browser host; blocking, so call off the main actor.
    static func request(_ socketPath: String, method: String, params: [String: Any] = [:], timeout: TimeInterval = 30,
                        cancellation: BrowserRequestCancellation? = nil) throws -> Any {
        let budget = BrowserDeadline(seconds: min(timeout, BrowserOperation.deadline?.remaining ?? timeout))
        var phase = "transport.connect"
        var stageStarted = ProcessInfo.processInfo.systemUptime
        var completed = false
        defer { if !completed { BrowserOperation.record(phase, started: stageStarted, outcome: "error") } }
        try budget.check()
        try cancellation?.check()
        guard var address = socketAddress(socketPath) else { throw ToolError("Bad browser socket path.") }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ToolError("Could not open a socket.") }
        defer { if let cancellation { cancellation.close(fd) } else { close(fd) } }
        try cancellation?.attach(fd)
        noSigPipe(fd); nonblocking(fd)
        var connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if connected != 0 && [EINPROGRESS, EAGAIN, EWOULDBLOCK].contains(errno) {
            if socketReady(fd, event: Int16(POLLOUT), deadline: budget) {
                var error: Int32 = 0
                var size = socklen_t(MemoryLayout<Int32>.size)
                if getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && error == 0 { connected = 0 }
            }
        }
        try cancellation?.check()
        try budget.check()
        guard connected == 0 else {
            // Stale only when its browser is gone; a live one may just be busy.
            if errno == ECONNREFUSED || errno == ENOENT, !browserAlive(socketPath) { unlink(socketPath) }
            throw ToolError("The browser bridge at \(socketPath) is not running.")
        }
        BrowserOperation.record(phase, started: stageStarted, outcome: "ok")
        phase = "transport.write"; stageStarted = ProcessInfo.processInfo.systemUptime
        let request: [String: Any] = ["id": 1, "method": method, "params": params]
        let data = try JSONSerialization.data(withJSONObject: request)
        try cancellation?.check()
        guard writeAll(fd, data + Data([0x0A]), deadline: budget) else {
            try cancellation?.check(); try budget.check()
            throw ToolError("The browser bridge closed the connection.")
        }
        BrowserOperation.record(phase, started: stageStarted, outcome: "ok")
        phase = "transport.read"; stageStarted = ProcessInfo.processInfo.systemUptime
        let line = try BridgeLineReader().line(fd, timeout: budget.remaining)
        try cancellation?.check()
        try budget.check()
        guard let line,
              let response = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            throw ToolError("The browser did not answer within \(Int(timeout)) s.")
        }
        if let error = response["error"] {
            throw ToolError("Browser: \(error)")
        }
        BrowserOperation.record(phase, started: stageStarted, outcome: "ok"); completed = true
        return response["result"] ?? NSNull()
    }

    static func requestAsync(_ socketPath: String, method: String, params: [String: Any] = [:], timeout: TimeInterval = 30) async throws -> Any {
        let cancellation = BrowserRequestCancellation()
        let trace = BrowserOperation.traceID, budget = BrowserOperation.deadline
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await Task.detached {
                try BrowserOperation.$traceID.withValue(trace) {
                    try BrowserOperation.$deadline.withValue(budget) {
                        try request(socketPath, method: method, params: params, timeout: timeout, cancellation: cancellation)
                    }
                }
            }.value
            try Task.checkCancellation()
            return result
        } onCancel: {
            cancellation.cancel()
        }
    }

    /// Sockets are named after the browser's pid.
    static func browserAlive(_ socketPath: String) -> Bool {
        guard let pid = pid_t(URL(fileURLWithPath: socketPath).deletingPathExtension().lastPathComponent), pid > 1 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    /// Live browsers with the extension connected; stale sockets are removed.
    public static func connectedBrowsers() -> [ConnectedBrowser] { connectedBrowsers(deadline: nil) }

    static func connectedBrowsers(deadline: BrowserDeadline?) -> [ConnectedBrowser] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: socketDirectory.path)) ?? []
        return files.filter { $0.hasSuffix(".sock") }.compactMap { file in
            let path = socketDirectory.appendingPathComponent(file).path
            guard (deadline?.remaining ?? 3) > 0,
                  let info = try? request(path, method: "hello", timeout: min(3, deadline?.remaining ?? 3)) as? [String: Any] else { return nil }
            let pid = info["pid"] as? Int ?? Int(file.dropLast(5)) ?? 0
            let name = (info["browser"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? NSRunningApplication(processIdentifier: pid_t(pid))?.localizedName ?? "Browser"
            return ConnectedBrowser(socketPath: path, name: name, pid: pid, version: info["version"] as? String,
                                    snapshotProtocol: info["snapshotProtocol"] as? Int)
        }
    }
}

// MARK: - Installation

extension BrowserBridge {
    /// Where each Chromium browser looks for per-user native messaging hosts.
    static let browserSupportDirectories = [
        "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Google/Chrome for Testing",
        "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Vivaldi", "Arc/User Data"
    ]

    static func hostManifest(executable: String) -> [String: Any] {
        [
            "name": hostName,
            "description": "skfiy browser bridge",
            "path": executable,
            "type": "stdio",
            "allowed_origins": ["chrome-extension://\(extensionID)/"]
        ]
    }

    /// The Chromium browsers installed for this user (their support folders).
    static func installedBrowserFolders(support: URL = SkfiyPaths.applicationSupport) -> [URL] {
        browserSupportDirectories
            .map { support.appendingPathComponent($0, isDirectory: true) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    static func manifestFile(in browserFolder: URL) -> URL {
        browserFolder.appendingPathComponent("NativeMessagingHosts/\(hostName).json")
    }

    /// Writes the host manifest for every installed Chromium browser, or only
    /// for the given --user-data-dir folders. Returns the manifests that now
    /// point at `executable`; files that already did are left untouched.
    public static func install(executable: String, extraUserDataDirectories: [String] = [],
                               support: URL = SkfiyPaths.applicationSupport) throws -> [String] {
        let targets = extraUserDataDirectories.isEmpty
            ? installedBrowserFolders(support: support)
            : extraUserDataDirectories.map { URL(fileURLWithPath: expandingTilde($0), isDirectory: true) }
        let data = try JSONSerialization.data(withJSONObject: hostManifest(executable: executable), options: [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys])
        var written: [String] = []
        for directory in targets {
            let file = manifestFile(in: directory)
            if (try? Data(contentsOf: file)) != data {
                try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: file, options: .atomic)
            }
            written.append(file.path)
        }
        return written
    }

    /// The host manifests present, with the binary each one launches.
    public static func installedHosts(support: URL = SkfiyPaths.applicationSupport) -> [(manifest: String, executable: String?)] {
        installedBrowserFolders(support: support).compactMap { folder in
            let file = manifestFile(in: folder)
            guard let data = try? Data(contentsOf: file) else { return nil }
            let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return (file.path, manifest?["path"] as? String)
        }
    }

    /// Whether a browser can connect at all: a host manifest in a Chromium
    /// browser's folder, or a bridge socket (a profile registered with
    /// --user-data-dir). Without either, the browser tools are not listed.
    public static var isRegistered: Bool { registered(support: SkfiyPaths.applicationSupport, sockets: socketDirectory) }

    static func registered(support: URL, sockets: URL) -> Bool {
        !installedHosts(support: support).isEmpty
            || ((try? FileManager.default.contentsOfDirectory(atPath: sockets.path)) ?? []).contains { $0.hasSuffix(".sock") }
    }

    /// Removes the skfiy host manifests except those whose binary `keep`
    /// accepts; returns the files removed.
    public static func uninstall(support: URL = SkfiyPaths.applicationSupport,
                                 keep: (String?) -> Bool = { _ in false }) -> [String] {
        installedHosts(support: support).compactMap { host in
            keep(host.executable) || (try? FileManager.default.removeItem(atPath: host.manifest)) == nil ? nil : host.manifest
        }
    }

    /// ~ and ~/… against $HOME, which NSString's expansion ignores.
    static func expandingTilde(_ path: String) -> String {
        if path == "~" { return SkfiyPaths.home.path }
        if path.hasPrefix("~/") { return SkfiyPaths.home.path + path.dropFirst() }
        return path
    }
}
