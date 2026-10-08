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
    public static func encode(_ payload: Data) -> Data {
        var length = UInt32(payload.count).littleEndian
        return Data(bytes: &length, count: 4) + payload
    }

    /// Splits complete frames off the front of `buffer`.
    public static func decode(_ buffer: inout Data) -> [Data] {
        var messages: [Data] = []
        while buffer.count >= 4 {
            let length = buffer.prefix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
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

private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if written <= 0 { return false }
            offset += written
        }
        return true
    }
}

/// Reads one newline-terminated line, waiting at most `timeout` seconds.
private func readLine(_ fd: Int32, timeout: TimeInterval) -> Data? {
    var line = Data()
    var byte: UInt8 = 0
    let deadline = Date().addingTimeInterval(timeout)
    while true {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { return nil }
        var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard poll(&poller, 1, Int32(min(remaining, 3600) * 1000)) > 0 else { return nil }
        guard read(fd, &byte, 1) == 1 else { return nil }
        if byte == 0x0A { return line }
        line.append(byte)
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
        private var pending: [Int: (fd: Int32, id: Any)] = [:]
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
                noSigPipe(client)
                Thread { self.serve(client) }.start()
            }
        }

        /// One JSON request per line; the reply comes back on the same connection.
        private func serve(_ client: Int32) {
            while let line = readLine(client, timeout: 3600) {
                guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                let clientID = request["id"] ?? NSNull()
                let method = request["method"] as? String ?? ""
                if method == "hello" {
                    lock.lock()
                    let info = hello
                    lock.unlock()
                    reply(client, ["id": clientID, "result": info])
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
                FileHandle.standardOutput.write(NativeMessage.encode(payload))
                lock.unlock()
            }
            lock.lock()
            pending = pending.filter { $0.value.fd != client }
            lock.unlock()
            close(client)
        }

        private func reply(_ fd: Int32, _ object: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
            _ = writeAll(fd, data + Data([0x0A]))
        }

        private func readBrowser() {
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(0, &chunk, chunk.count)
                guard count > 0 else { return }
                buffer.append(contentsOf: chunk[0..<count])
                for payload in NativeMessage.decode(&buffer) {
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
                    reply(waiter.fd, response)
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
}

extension BrowserBridge {
    /// One request to one browser host; blocking, so call off the main actor.
    static func request(_ socketPath: String, method: String, params: [String: Any] = [:], timeout: TimeInterval = 30) throws -> Any {
        guard var address = socketAddress(socketPath) else { throw ToolError("Bad browser socket path.") }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ToolError("Could not open a socket.") }
        defer { close(fd) }
        noSigPipe(fd)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else {
            // Stale only when its browser is gone; a live one may just be busy.
            if errno == ECONNREFUSED || errno == ENOENT, !browserAlive(socketPath) { unlink(socketPath) }
            throw ToolError("The browser bridge at \(socketPath) is not running.")
        }
        let request: [String: Any] = ["id": 1, "method": method, "params": params]
        let data = try JSONSerialization.data(withJSONObject: request)
        guard writeAll(fd, data + Data([0x0A])) else { throw ToolError("The browser bridge closed the connection.") }
        guard let line = readLine(fd, timeout: timeout),
              let response = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            throw ToolError("The browser did not answer within \(Int(timeout)) s.")
        }
        if let error = response["error"] {
            throw ToolError("Browser: \(error)")
        }
        return response["result"] ?? NSNull()
    }

    /// Sockets are named after the browser's pid.
    static func browserAlive(_ socketPath: String) -> Bool {
        guard let pid = pid_t(URL(fileURLWithPath: socketPath).deletingPathExtension().lastPathComponent), pid > 1 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    /// Live browsers with the extension connected; stale sockets are removed.
    public static func connectedBrowsers() -> [ConnectedBrowser] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: socketDirectory.path)) ?? []
        return files.filter { $0.hasSuffix(".sock") }.compactMap { file in
            let path = socketDirectory.appendingPathComponent(file).path
            guard let info = try? request(path, method: "hello", timeout: 3) as? [String: Any] else { return nil }
            let pid = info["pid"] as? Int ?? Int(file.dropLast(5)) ?? 0
            let name = (info["browser"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? NSRunningApplication(processIdentifier: pid_t(pid))?.localizedName ?? "Browser"
            return ConnectedBrowser(socketPath: path, name: name, pid: pid, version: info["version"] as? String)
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

    /// Removes every skfiy host manifest; returns the files removed.
    public static func uninstall(support: URL = SkfiyPaths.applicationSupport) -> [String] {
        installedHosts(support: support).compactMap { host in
            (try? FileManager.default.removeItem(atPath: host.manifest)) == nil ? nil : host.manifest
        }
    }

    /// ~ and ~/… against $HOME, which NSString's expansion ignores.
    static func expandingTilde(_ path: String) -> String {
        if path == "~" { return SkfiyPaths.home.path }
        if path.hasPrefix("~/") { return SkfiyPaths.home.path + path.dropFirst() }
        return path
    }
}
