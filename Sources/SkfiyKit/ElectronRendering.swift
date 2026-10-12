import AppKit
import Darwin
import Foundation

/// A short rendering lease in an Electron main process. The window is identified
/// by its WindowServer id, never its title. No window ordering or focus APIs are
/// used. The target restores its own policy even if the MCP process disappears.
@MainActor
final class ElectronRendering {
    private let owner = UUID().uuidString
    private var live: [String: Date] = [:]
    private var retryAfter: [pid_t: Date] = [:]

    func isLive(pid: pid_t, window: CGWindowID) -> Bool {
        (live["\(pid):\(window)"] ?? .distantPast) > Date()
    }

    func prepare(_ app: NSRunningApplication, window: CGWindowID) async -> Bool {
        let pid = app.processIdentifier
        guard !app.isTerminated, !Task.isCancelled, !isScreenLocked(), !EmergencyStop.isStopped,
              ProcessInfo.processInfo.environment["SKFIY_ELECTRON_RENDERING"] != "0",
              let bundle = app.bundleURL else { return false }
        let framework = bundle.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Electron Framework")
        guard FileManager.default.fileExists(atPath: framework.path) else { return false }
        if (live["\(pid):\(window)"] ?? .distantPast) > Date().addingTimeInterval(4) { return true }
        if (retryAfter[pid] ?? .distantPast) > Date() { return isLive(pid: pid, window: window) }

        // Inspector startup/teardown must not race another skfiy process. The
        // target-side leases still coexist once this short conversation ends.
        let locks = SkfiyPaths.caches.appendingPathComponent("rendering-locks")
        guard (try? FileManager.default.createDirectory(at: locks, withIntermediateDirectories: true,
                                                         attributes: [.posixPermissions: 0o700])) != nil else { return false }
        let descriptor = open(locks.appendingPathComponent(String(pid)).path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return false }
        defer { _ = flock(descriptor, LOCK_UN); Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return isLive(pid: pid, window: window) }

        var opened = false
        var socket: InspectorSocket?
        var connectedURL: URL?
        do {
            var endpoint = await Self.endpoint(pid: pid)
            if endpoint == nil {
                // Never signal an arbitrary process: SIGUSR1's default action is
                // termination. Both the Electron fuse and a caught signal are
                // required, and no binary or fuse is changed.
                // Electron 32+ has the Node module loader needed for bounded
                // cleanup. Older/unrecognized builds keep the native fallback.
                let version = Bundle(url: framework.deletingLastPathComponent())?.object(forInfoDictionaryKey: "CFBundleVersion") as? String
                guard let major = version?.split(separator: ".").first.flatMap({ Int($0) }), major >= 32,
                      let data = try? Data(contentsOf: framework, options: .mappedIfSafe),
                      Self.inspectorFuseEnabled(data), Self.catchesInspectorSignal(pid), Self.defaultInspectorStartup(pid),
                      !app.isTerminated, kill(pid, SIGUSR1) == 0 else { throw RenderError.unavailable }
                opened = true
                for _ in 0..<4 {
                    try await Task.sleep(nanoseconds: 100_000_000)
                    endpoint = await Self.endpoint(pid: pid)
                    if endpoint != nil { break }
                }
            }
            guard let endpoint else { throw RenderError.unavailable }
            connectedURL = endpoint
            let connection = InspectorSocket(endpoint)
            socket = connection
            let identity = try await connection.evaluate("({pid:process.pid,electron:process.versions.electron})")
            guard identity["pid"] as? Int == Int(pid), identity["electron"] is String else { throw RenderError.unavailable }
            let json = try JSONSerialization.data(withJSONObject: ["pid": Int(pid), "window": Int(window), "owner": owner])
            let reply = try await connection.evaluate("(\(Self.leaseScript))(\(String(decoding: json, as: UTF8.self)))")
            guard reply["rendered"] as? Bool == true, reply["window"] as? Int == Int(window) else { throw RenderError.unavailable }
            // Leave ample margin before the target's 15-second expiry. A lease
            // only proves rendering after two real animation frames completed.
            live["\(pid):\(window)"] = Date().addingTimeInterval(10)
            retryAfter[pid] = nil
        } catch {
            // A failed renewal can have restored the target's throttling;
            // never retain the previous successful frame confirmation.
            live["\(pid):\(window)"] = nil
            retryAfter[pid] = Date().addingTimeInterval(5)
        }
        socket?.close()
        if opened {
            // Unstructured and explicitly awaited: cancellation of the tool
            // must not cancel cleanup or leave an inspector started by us open.
            await Self.closeStartedInspector(pid: pid, endpoint: connectedURL)
        }
        return isLive(pid: pid, window: window)
    }

    static func closeStartedInspector(pid: pid_t, endpoint: URL?) async {
        await Task { await Self.closeInspectorSession(pid: pid, endpoint: endpoint) }.value
    }

    private static func closeInspectorSession(pid: pid_t, endpoint: URL?) async {
        var endpoint = endpoint
        for _ in 0..<5 where endpoint == nil {
            try? await Task.sleep(nanoseconds: 100_000_000)
            endpoint = await Self.endpoint(pid: pid)
        }
        guard let endpoint else { return }
        let socket = InspectorSocket(endpoint)
        defer { socket.close() }
        // Run after this websocket disconnects: inspector.close() waits for
        // clients. This method is never called for a pre-existing inspector.
        let cleanup = "(()=>{if(process.pid!==\(pid)||!process.versions.electron)return {};const r=process.getBuiltinModule?.('module')?.createRequire(process.execPath)||process.mainModule?.require?.bind(process.mainModule);if(r)setTimeout(()=>{try{r('inspector').close()}catch{}},100).unref();return {};})()"
        _ = try? await socket.evaluate(cleanup)
    }

    static func inspectorFuseEnabled(_ data: Data) -> Bool {
        let sentinel = Data("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".utf8)
        var start = data.startIndex
        var found = false
        while let range = data.range(of: sentinel, in: start..<data.endIndex) {
            let offset = range.upperBound
            guard data.count >= offset + 6, data[offset] == 1, data[offset + 1] >= 4,
                  data.count >= offset + 2 + Int(data[offset + 1]), data[offset + 5] == 0x31 else { return false }
            found = true
            start = offset + 2 + Int(data[offset + 1])
        }
        return found
    }

    private static func catchesInspectorSignal(_ pid: pid_t) -> Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        return sysctl(&mib, 4, &info, &size, nil, 0) == 0 && size == MemoryLayout<kinfo_proc>.stride
            && info.kp_proc.p_sigcatch & (UInt32(1) << UInt32(SIGUSR1 - 1)) != 0
    }

    static func defaultInspectorStartup(_ pid: pid_t) -> Bool {
        // SIGUSR1 honors --inspect-port / NODE_OPTIONS, which could bind a
        // public address. Auto-start only the default loopback configuration.
        // Process arguments/environment stay in memory; none are logged.
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4, size <= 1_048_576 else { return false }
        var bytes = Data(count: size)
        let status = bytes.withUnsafeMutableBytes { sysctl(&mib, 3, $0.baseAddress, &size, nil, 0) }
        guard status == 0 else { return false }
        return defaultInspectorStartup(bytes.prefix(size))
    }

    static func defaultInspectorStartup(_ bytes: Data) -> Bool {
        guard bytes.count > 4 else { return false }
        let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard argc > 0, argc < 65536 else { return false }
        var offset = 4
        func string() -> String? {
            guard offset < bytes.count, let end = bytes[offset...].firstIndex(of: 0) else { return nil }
            defer { offset = end + 1 }
            return String(decoding: bytes[offset..<end], as: UTF8.self)
        }
        guard let executable = string(), !executable.isEmpty else { return false }
        while offset < bytes.count, bytes[offset] == 0 { offset += 1 }
        var arguments: [String] = []
        for _ in 0..<argc {
            guard let value = string() else { return false }
            arguments.append(value)
        }
        // Unknown argv layouts or redacted environments cannot establish that
        // the inspector would use its default loopback address.
        guard let first = arguments.first,
              URL(fileURLWithPath: first).lastPathComponent == URL(fileURLWithPath: executable).lastPathComponent else { return false }
        var environment: [String] = []
        while offset < bytes.count {
            guard let value = string() else { return false }
            if !value.isEmpty { environment.append(value) }
        }
        guard !environment.isEmpty, environment.allSatisfy({ $0.contains("=") }) else { return false }
        return !arguments.contains { $0.hasPrefix("--inspect") || $0.hasPrefix("--debug") }
            && !environment.contains { $0.hasPrefix("NODE_OPTIONS=") && ($0.contains("--inspect") || $0.contains("--debug")) }
    }

    /// Only connect to loopback listeners owned by this exact process. The
    /// websocket address must use the same loopback port as the discovery URL.
    static func loopbackPorts(pid: pid_t) -> [Int] {
        let needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard needed > 0 else { return [] }
        let capacity = min(Int(needed) / MemoryLayout<proc_fdinfo>.stride + 32, 65536)
        var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: capacity)
        let size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &descriptors, Int32(capacity * MemoryLayout<proc_fdinfo>.stride))
        guard size > 0 else { return [] }
        var ports: Set<Int> = []
        for fd in descriptors.prefix(Int(size) / MemoryLayout<proc_fdinfo>.stride) where fd.proc_fdtype == PROX_FDTYPE_SOCKET {
            var info = socket_fdinfo()
            let size = proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &info, Int32(MemoryLayout<socket_fdinfo>.stride))
            guard size == MemoryLayout<socket_fdinfo>.stride, info.psi.soi_family == AF_INET,
                  info.psi.soi_kind == SOCKINFO_TCP, info.psi.soi_proto.pri_tcp.tcpsi_state == 1 else { continue }
            let local = info.psi.soi_proto.pri_tcp.tcpsi_ini
            guard UInt32(bigEndian: local.insi_laddr.ina_46.i46a_addr4.s_addr) == 0x7f000001 else { continue }
            ports.insert(Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: local.insi_lport))))
        }
        return ports.sorted()
    }

    static func inspectorURL(_ value: String, port: Int) -> URL? {
        guard let url = URL(string: value), url.scheme == "ws", url.host == "127.0.0.1", url.port == port,
              url.user == nil, url.password == nil, !url.path.isEmpty else { return nil }
        return url
    }

    private static func endpoint(pid: pid_t) async -> URL? {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 0.4
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        for port in loopbackPorts(pid: pid).prefix(8) {
            let url = URL(string: "http://127.0.0.1:\(port)/json/list")!
            guard let (data, response) = try? await session.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let targets = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { continue }
            for target in targets where target["type"] as? String == "node" {
                if let value = target["webSocketDebuggerUrl"] as? String, let endpoint = inspectorURL(value, port: port) { return endpoint }
            }
        }
        return nil
    }

    enum RenderError: Error { case unavailable }

    /// All mutations are limited to the selected window's rendering policy.
    /// Leases from different MCP processes share the original policy and are
    /// restored only after their last owner expires. No page code is executed
    /// except a pair of animation-frame callbacks used as a liveness check.
    static let leaseScript = #"""
    async function(p) {
      if(process.pid!==p.pid) return {};
      const r=process.getBuiltinModule?.('module')?.createRequire(process.execPath)
        || process.mainModule?.require?.bind(process.mainModule);
      if(!r) return {};
      const e=r('electron');
      const w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed() && w.getMediaSourceId()===`window:${p.window}:0`);
      if(!w || w.isMinimized() || !w.isVisible()) return {};
      const wc=w.webContents;
      if(!wc || wc.isDestroyed() || typeof wc.getBackgroundThrottling!=='function') return {};
      const key=Symbol.for('skfiy.rendering-leases.v1');
      let registry=globalThis[key];
      if(!registry) {
        registry={entries:new Map()};
        globalThis[key]=registry;
        registry.timer=setInterval(()=>{
          for(const [id,entry] of registry.entries) {
            for(const [owner,expires] of entry.owners) if(expires<=Date.now()) entry.owners.delete(owner);
            if(entry.wc.isDestroyed() || entry.owners.size===0) {
              // An app replacing/closing a view must not receive an uncaught
              // exception from our timer (which could open its error dialog).
              try {if(!entry.wc.isDestroyed()) entry.wc.setBackgroundThrottling(entry.previous);} catch {}
              registry.entries.delete(id);
            }
          }
          if(registry.entries.size===0) {clearInterval(registry.timer);delete globalThis[key];}
        },500);
        registry.timer.unref();
      }
      let entry=registry.entries.get(wc.id);
      if(!entry) {entry={wc,previous:wc.getBackgroundThrottling(),owners:new Map()};registry.entries.set(wc.id,entry);}
      entry.owners.set(p.owner,Date.now()+15000);
      wc.setBackgroundThrottling(false);
      let timer;
      const rendered=await Promise.race([
        wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))').catch(()=>false),
        new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1200);})
      ]);
      clearTimeout(timer);
      if(rendered!==true) {
        entry.owners.delete(p.owner);
        if(entry.owners.size===0) {
          try {if(!wc.isDestroyed()) wc.setBackgroundThrottling(entry.previous);} catch {}
          registry.entries.delete(wc.id);
        }
      }
      return {window:p.window,rendered:rendered===true};
    }
    """#
}

/// One bounded inspector conversation; all errors leave the native AX path
/// available. This transport is deliberately not a general-purpose JS tool.
private final class InspectorSocket {
    private let session: URLSession
    private let task: URLSessionWebSocketTask
    private var sequence = 0

    init(_ url: URL) {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        session = URLSession(configuration: config)
        task = session.webSocketTask(with: url)
        task.resume()
    }

    func close() { task.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }

    func evaluate(_ expression: String) async throws -> [String: Any] {
        sequence += 1
        let id = sequence
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "method": "Runtime.evaluate",
            "params": ["expression": expression, "returnByValue": true, "awaitPromise": true]])
        let timeout = Task { [task] in
            try await Task.sleep(nanoseconds: 2_000_000_000)
            task.cancel(with: .goingAway, reason: nil)
        }
        defer { timeout.cancel() }
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
        while true {
            let message = try await task.receive()
            let bytes: Data
            switch message {
            case .string(let text): bytes = Data(text.utf8)
            case .data(let data): bytes = data
            @unknown default: throw ElectronRendering.RenderError.unavailable
            }
            guard let reply = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
            guard reply["id"] as? Int == id else { continue }
            guard let result = reply["result"] as? [String: Any], result["exceptionDetails"] == nil,
                  let value = result["result"] as? [String: Any], let object = value["value"] as? [String: Any]
            else { throw ElectronRendering.RenderError.unavailable }
            return object
        }
    }
}
