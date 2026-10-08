import AppKit
import ApplicationServices
import CoreServices
import Foundation

/// A running or installed app, as `list_apps` and app resolution see it.
public struct AppRecord: Equatable, Sendable {
    public var name: String
    public var bundleID: String?
    public var path: String?
    /// Other names the app answers to (bundle name, file name).
    public var aliases: [String]
    public var pid: pid_t?
    public var isFrontmost: Bool
    public var isHidden: Bool
    /// A regular app with a Dock icon, as opposed to a menu-bar or helper process.
    public var isRegular: Bool
    public var lastUsed: Date?
    public var useCount: Int?

    public init(
        name: String,
        bundleID: String? = nil,
        path: String? = nil,
        aliases: [String] = [],
        pid: pid_t? = nil,
        isFrontmost: Bool = false,
        isHidden: Bool = false,
        isRegular: Bool = true,
        lastUsed: Date? = nil,
        useCount: Int? = nil
    ) {
        self.name = name
        self.bundleID = bundleID
        self.path = path
        self.aliases = aliases
        self.pid = pid
        self.isFrontmost = isFrontmost
        self.isHidden = isHidden
        self.isRegular = isRegular
        self.lastUsed = lastUsed
        self.useCount = useCount
    }

    var names: [String] { [name] + aliases }
}

public enum AppMatch: Equatable {
    case one(AppRecord)
    case none
    case ambiguous([AppRecord])
}

/// Resolves "App name, full app path, or unambiguous bundle identifier".
/// Tiers, strongest first: bundle id, path, exact name, name prefix, name
/// substring. The first tier with a unique app wins; a tier with several
/// different apps is ambiguous, unless only one of them is a regular app
/// (WeChat vs. its background mini-program helper, also named "WeChat").
public func matchApp(_ query: String, in records: [AppRecord]) -> AppMatch {
    let needle = normalizeAppName(query)
    guard !needle.isEmpty else { return .none }
    let standardizedPath = query.hasPrefix("/") || query.hasPrefix("~")
        ? (query as NSString).expandingTildeInPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        : nil

    let tiers: [(AppRecord) -> Bool] = [
        { $0.bundleID.map { $0.lowercased() == query.lowercased() } ?? false },
        { record in
            guard let standardizedPath, let path = record.path else { return false }
            return path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == standardizedPath
        },
        { $0.names.contains { normalizeAppName($0) == needle } },
        { $0.names.contains { normalizeAppName($0).hasPrefix(needle) } },
        { needle.count >= 3 && $0.names.contains { normalizeAppName($0).contains(needle) } }
    ]

    for tier in tiers {
        let hits = records.filter(tier)
        guard !hits.isEmpty else { continue }
        var distinct: [AppRecord] = []
        for hit in hits where !distinct.contains(where: { sameApp($0, hit) }) {
            distinct.append(hit)
        }
        if distinct.count == 1 {
            // Several instances of one app: prefer a running, frontmost one,
            // then the regular (Dock) instance over a helper of the same
            // bundle (RustDesk's `--server` process is an accessory copy).
            let best = hits.sorted { lhs, rhs in
                if (lhs.pid != nil) != (rhs.pid != nil) { return lhs.pid != nil }
                if lhs.isFrontmost != rhs.isFrontmost { return lhs.isFrontmost }
                return lhs.isRegular && !rhs.isRegular
            }[0]
            return .one(best)
        }
        let regular = distinct.filter(\.isRegular)
        if regular.count == 1 {
            return .one(regular[0])
        }
        return .ambiguous(distinct)
    }
    return .none
}

/// The process id in an app query of the form "pid:1234" (or "pid 1234").
func parsePIDQuery(_ query: String) -> pid_t? {
    let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard trimmed.hasPrefix("pid") else { return nil }
    let rest = trimmed.dropFirst(3).drop { $0 == ":" || $0 == " " || $0 == "=" }
    guard !rest.isEmpty, rest.allSatisfy(\.isNumber), let pid = pid_t(rest), pid > 0 else { return nil }
    return pid
}

private func sameApp(_ lhs: AppRecord, _ rhs: AppRecord) -> Bool {
    if let left = lhs.bundleID, let right = rhs.bundleID {
        return left == right
    }
    if let left = lhs.path, let right = rhs.path {
        return left == right
    }
    return lhs.name == rhs.name
}

func normalizeAppName(_ name: String) -> String {
    var value = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.lowercased().hasSuffix(".app") {
        value = String(value.dropLast(4))
    }
    return value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
}

/// Live app inventory backed by NSWorkspace, the app folders, and Spotlight.
@MainActor
final class AppDirectory {
    private var installedCache: (date: Date, records: [AppRecord])?

    func runningApps() -> [AppRecord] {
        let frontmost = frontmostProcessID()
        return NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy != .prohibited && !$0.isTerminated }
            .map { app in
                AppRecord(
                    name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
                    bundleID: app.bundleIdentifier,
                    path: app.bundleURL?.path,
                    aliases: app.bundleURL.map(bundleAliases) ?? [],
                    pid: app.processIdentifier,
                    isFrontmost: app.processIdentifier == frontmost,
                    isHidden: app.isHidden,
                    isRegular: app.activationPolicy == .regular
                )
            }
    }

    func installedApps() -> [AppRecord] {
        if let cache = installedCache, Date().timeIntervalSince(cache.date) < 120 {
            return cache.records
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let roots = [
            "/Applications", "/Applications/Utilities", "/System/Applications",
            "/System/Applications/Utilities", "/System/Library/CoreServices/Applications",
            home + "/Applications"
        ]
        var seen = Set<String>()
        var records: [AppRecord] = []
        for root in roots {
            for url in appBundles(in: URL(fileURLWithPath: root), depth: 2) where seen.insert(url.path).inserted {
                let bundle = Bundle(url: url)
                var record = AppRecord(
                    name: FileManager.default.displayName(atPath: url.path)
                        .replacingOccurrences(of: ".app", with: ""),
                    bundleID: bundle?.bundleIdentifier,
                    path: url.path,
                    aliases: bundleAliases(url)
                )
                if let item = MDItemCreateWithURL(kCFAllocatorDefault, url as CFURL) {
                    record.lastUsed = MDItemCopyAttribute(item, "kMDItemLastUsedDate" as CFString) as? Date
                    record.useCount = (MDItemCopyAttribute(item, "kMDItemUseCount" as CFString) as? NSNumber)?.intValue
                }
                records.append(record)
            }
        }
        installedCache = (Date(), records)
        return records
    }

    private func appBundles(in directory: URL, depth: Int) -> [URL] {
        guard depth > 0,
              let entries = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
              ) else {
            return []
        }
        var bundles: [URL] = []
        for entry in entries {
            if entry.pathExtension == "app" {
                bundles.append(entry)
            } else if (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                bundles.append(contentsOf: appBundles(in: entry, depth: depth - 1))
            }
        }
        return bundles
    }

    enum Resolution {
        case running(NSRunningApplication)
        case installed(URL)
    }

    func resolve(_ query: String) throws -> Resolution {
        // "pid:1234" names one process when an app runs as several (list_apps shows pids).
        if let pid = parsePIDQuery(query) {
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated, app.activationPolicy != .prohibited else {
                throw ToolError("No app runs as pid \(pid). Call list_apps to see the running apps and their pids.")
            }
            return .running(app)
        }
        let running = runningApps()
        switch matchApp(query, in: running) {
        case .one(let record):
            if let pid = record.pid, let app = NSRunningApplication(processIdentifier: pid) {
                return .running(app)
            }
        case .ambiguous(let records):
            throw ambiguity(query, records)
        case .none:
            break
        }
        switch matchApp(query, in: installedApps()) {
        case .one(let record):
            guard let path = record.path else { break }
            // An installed match may already be running under another name.
            if let app = NSWorkspace.shared.runningApplications.first(where: {
                $0.bundleURL?.path == path || ($0.bundleIdentifier != nil && $0.bundleIdentifier == record.bundleID)
            }) {
                return .running(app)
            }
            return .installed(URL(fileURLWithPath: path))
        case .ambiguous(let records):
            throw ambiguity(query, records)
        case .none:
            break
        }
        if query.hasPrefix("/"), query.hasSuffix(".app"), FileManager.default.fileExists(atPath: query) {
            return .installed(URL(fileURLWithPath: query))
        }
        throw ToolError("No app matches \"\(query)\". Call list_apps to see available apps.")
    }

    private func ambiguity(_ query: String, _ records: [AppRecord]) -> ToolError {
        let options = records.prefix(8).map { record in
            record.bundleID.map { "\(record.name) (\($0))" } ?? record.name
        }
        return ToolError("\"\(query)\" matches several apps: \(options.joined(separator: ", ")). Pass a bundle identifier instead.")
    }

    func launch(_ url: URL) async throws -> NSRunningApplication {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        do {
            return try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        } catch {
            throw ToolError("Could not launch \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }
}

private func bundleAliases(_ url: URL) -> [String] {
    var aliases = [url.deletingPathExtension().lastPathComponent]
    if let info = Bundle(url: url)?.infoDictionary {
        for key in ["CFBundleName", "CFBundleDisplayName"] {
            if let name = info[key] as? String, !aliases.contains(name) {
                aliases.append(name)
            }
        }
    }
    return aliases
}

/// The app receiving keyboard input, per the accessibility system.
func frontmostProcessID() -> pid_t? {
    let systemWide = AXUIElementCreateSystemWide()
    if let app = systemWide.element(kAXFocusedApplicationAttribute), let pid = app.pid {
        return pid
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func isScreenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return true
    }
    guard session[kCGSessionOnConsoleKey as String] as? Bool == true else { return true }
    return (session["CGSSessionScreenIsLocked"] as? Bool) == true
}

/// Why no screenshot can be taken right now, if that is the case. Screen
/// capture refuses ("the user declined") or stalls meanwhile.
func screenUnavailableReason() -> String? {
    if isScreenLocked() { return "the screen is locked" }
    if CGDisplayIsAsleep(CGMainDisplayID()) != 0 { return "the display is asleep" }
    if NSWorkspace.shared.runningApplications.contains(where: { ($0.bundleIdentifier ?? "").hasPrefix("com.apple.ScreenSaver") }) {
        return "the screen saver is running"
    }
    return nil
}

/// Terminals run whatever is typed into them as shell commands, outside the
/// MCP client's own permission checks, and often host the agent itself.
let terminalBundleIDs: Set<String> = [
    "com.mitchellh.ghostty", "com.apple.terminal", "com.googlecode.iterm2", "dev.warp.warp-stable",
    "dev.warp.warp", "io.alacritty", "org.alacritty", "net.kovidgoyal.kitty", "com.github.wez.wezterm",
    "co.zeit.hyper", "org.tabby", "com.raphaelamorim.rio", "com.termius-dmg.mac"
]

func isTerminal(bundleID: String?) -> Bool {
    bundleID.map { terminalBundleIDs.contains($0.lowercased()) } ?? false
}

/// The login window, authorization prompts and locked-use's own covers:
/// skfiy never reads or operates them for the agent.
func isProtectedInterface(bundleID: String?, executable: String?) -> Bool {
    let id = (bundleID ?? "").lowercased()
    return ["com.apple.loginwindow", "io.github.sskift.skfiy.locked-use"].contains(id)
        || id.hasPrefix("com.apple.securityagent") || id.hasPrefix("com.apple.authorizationhost")
        || ["loginwindow", "SecurityAgent", "authorizationhost"].contains(executable ?? "")
}

func isProtectedInterface(_ app: NSRunningApplication) -> Bool {
    isProtectedInterface(bundleID: app.bundleIdentifier, executable: app.executableURL?.lastPathComponent)
}

/// This process and its ancestors (the shell, the agent, the terminal or
/// editor hosting them).
func ancestorProcessIDs() -> Set<pid_t> {
    var pids: Set<pid_t> = []
    var pid = getpid()
    while pid > 1, pids.insert(pid).inserted {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { break }
        pid = info.kp_eproc.e_ppid
    }
    return pids
}

/// Whether Apple Events to `bundleID` are already allowed, without asking:
/// a consent prompt would pop up over the user's work.
func mayAutomate(_ bundleID: String) -> Bool {
    var address = AEAddressDesc()
    let created = bundleID.withCString { pointer in
        AECreateDesc(typeApplicationBundleID, pointer, strlen(pointer), &address)
    }
    guard created == noErr else { return false }
    defer { AEDisposeDesc(&address) }
    return AEDeterminePermissionToAutomateTarget(&address, typeWildCard, typeWildCard, false) == noErr
}
