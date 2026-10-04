import AppKit
import ApplicationServices
import CryptoKit
import Foundation

/// The facts one capability query depends on, gathered fresh on every call.
/// Kept as plain values so the decisions below can be tested without an app.
struct CapabilityInputs: Equatable {
    enum Session: String { case unlocked, locked, unknown }
    enum Mode: String { case normal, direct, directEnded = "direct-ended", guardian }
    enum Protection: String { case terminal, host, system }

    struct Window: Equatable {
        var id: CGWindowID?
        var title: String
        var minimized = false
        var onScreen = true
    }

    var session: Session
    var mode: Mode
    var emergencyStopped = false
    var accessibility = true
    var screenRecording = true
    var clientCanAsk = false

    var appName: String
    var bundleID: String?
    var pid: pid_t?
    var hidden = false
    var frontmost = false
    var protection: Protection?
    var chromium = false
    var browserApp = false

    var windows: [Window] = []
    /// The window the query is about: the one named by `window`, else the focused one.
    var inspected: Window?
    /// Locked: windows that are active keyboard destinations of the process.
    var keyboardWindows: Int?
    /// Unlocked: content elements in the inspected window (nil when not measured).
    var accessibilityElements: Int?
    var webContent = false
    var hasFocusedElement: Bool?
    /// Locked direct mode: the age of the latest screenshot coordinates, when still valid.
    var screenshotAge: Double?

    var connectedBrowsers: [String] = []
    var browserConnected = false
}

struct Capability: Equatable {
    let name: String
    let available: Bool
    /// How it works now, or why not.
    let detail: String
    var limits: [String] = []

    var json: [String: Any] { ["available": available, "detail": detail, "limits": limits] }
}

struct CapabilityReport {
    let inputs: CapabilityInputs
    let channels: [Capability]
    let tools: [String]

    subscript(_ name: String) -> Capability? { channels.first { $0.name == name } }

    /// Changes whenever anything a decision depends on changes.
    var version: String {
        let data = try! JSONSerialization.data(withJSONObject: json(includeVersion: false), options: [.sortedKeys])
        return SHA256.hash(data: data).prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    func json(includeVersion: Bool = true) -> [String: Any] {
        var object: [String: Any] = [
            "app": inputs.appName, "session": inputs.session.rawValue, "mode": inputs.mode.rawValue,
            "permissions": ["accessibility": inputs.accessibility, "screenRecording": inputs.screenRecording],
            "windows": inputs.windows.map { window -> [String: Any] in
                var row: [String: Any] = ["title": window.title, "minimized": window.minimized, "onScreen": window.onScreen]
                if let id = window.id { row["id"] = Int(id) }
                return row
            },
            "channels": Dictionary(uniqueKeysWithValues: channels.map { ($0.name, $0.json) }),
            "tools": tools,
            "connectedBrowsers": inputs.connectedBrowsers,
            "emergencyStop": inputs.emergencyStopped
        ]
        if let pid = inputs.pid { object["pid"] = Int(pid) }
        if let id = inputs.bundleID { object["bundleID"] = id }
        if let window = inputs.inspected { object["inspectedWindow"] = window.title }
        if let count = inputs.keyboardWindows { object["activeKeyboardWindows"] = count }
        if includeVersion { object["version"] = version }
        return object
    }

    /// Names of what differs from an earlier report of the same app.
    func changes(since previous: CapabilityReport) -> [String] {
        var changed: [String] = []
        if previous.inputs.session != inputs.session { changed.append("session") }
        if previous.inputs.mode != inputs.mode { changed.append("mode") }
        if previous.inputs.accessibility != inputs.accessibility || previous.inputs.screenRecording != inputs.screenRecording {
            changed.append("permissions")
        }
        if previous.inputs.windows != inputs.windows || previous.inputs.keyboardWindows != inputs.keyboardWindows { changed.append("windows") }
        if previous.inputs.connectedBrowsers != inputs.connectedBrowsers { changed.append("browsers") }
        if previous.inputs.pid != inputs.pid { changed.append("process") }
        for channel in channels where previous[channel.name]?.available != channel.available {
            changed.append(channel.name)
        }
        return changed
    }

    /// Decides what works for this app right now, and why not otherwise.
    static func evaluate(_ facts: CapabilityInputs, lockedTools: Set<String> = DirectLockedUse.lockedTools) -> CapabilityReport {
        let unlocked = facts.session == .unlocked
        let lockedDirect = facts.session == .locked && facts.mode == .direct
        let running = facts.pid != nil
        var blocker: String?
        if facts.emergencyStopped {
            blocker = "Emergency stop is on (skfiy resume or ⌃⌥⌘. turns it off); every action is refused."
        } else if facts.session == .unknown {
            blocker = "The console session's lock state is unknown (another user, fast user switching, or loginwindow)."
        } else if facts.session == .locked && facts.mode == .directEnded {
            blocker = "Direct locked use ended for this MCP session (locked_use_end); a new session is needed."
        } else if facts.session == .locked && facts.mode == .normal {
            blocker = "macOS is locked and this MCP session was not started with SKFIY_LOCKED_USE=direct, so app windows cannot be read or operated until the user unlocks."
        } else if !running {
            blocker = unlocked
                ? "\(facts.appName) is not running; get_app_state launches it in the background."
                : "\(facts.appName) is not running, and apps are not launched while macOS is locked."
        }
        func blocked(_ name: String) -> Capability { Capability(name: name, available: false, detail: blocker ?? "") }
        let protectionNote: String? = switch facts.protection {
        case .terminal?: "\(facts.appName) is a terminal: skfiy reads and scrolls it but never clicks or types there (SKFIY_ALLOW_TERMINALS=1 allows it)."
        case .host?: "\(facts.appName) hosts this agent, so it never receives input from skfiy."
        case .system?: "\(facts.appName) is a system authentication interface; skfiy never operates it."
        case nil: nil
        }
        let shown = facts.inspected
        var channels: [Capability] = []

        // Accessibility tree and element actions.
        if blocker != nil {
            channels.append(blocked("ax"))
        } else if !unlocked {
            channels.append(Capability(name: "ax", available: false, detail: "macOS is locked: direct mode works from window screenshots, without accessibility element indices."))
        } else if !facts.accessibility {
            channels.append(Capability(name: "ax", available: false, detail: "Accessibility permission is missing for the app hosting skfiy (skfiy doctor)."))
        } else if facts.windows.isEmpty {
            channels.append(Capability(name: "ax", available: true, detail: "Only the menu bar: the app has no windows.", limits: ["Open a window with the menu bar or a shortcut such as cmd+n."]))
        } else if facts.accessibilityElements == 0 {
            channels.append(Capability(name: "ax", available: false, detail: "The window publishes no accessibility elements (custom-drawn UI or an embedded web view).",
                                       limits: ["Menu bar items still have element indices.", "Use OCR text positions with x/y instead."]))
        } else {
            var limits: [String] = []
            if facts.chromium && !facts.webContent {
                limits.append("No web content in the tree yet: Chromium builds it after the first get_app_state; call get_app_state again.")
            }
            if facts.hasFocusedElement == false {
                limits.append("The app reports no focused element, so keystrokes may be lost: click the field first, or use set_value.")
            }
            let count = facts.accessibilityElements.map { " (\($0) content elements in the window)" } ?? ""
            channels.append(Capability(name: "ax", available: true, detail: "Accessibility tree with element indices\(count).", limits: limits))
        }

        // Screenshot and text recognition.
        let screenshot: Capability
        if blocker != nil {
            screenshot = blocked("screenshot")
        } else if !facts.screenRecording {
            screenshot = Capability(name: "screenshot", available: false, detail: "Screen Recording permission is missing for the app hosting skfiy (skfiy doctor).")
        } else if lockedDirect {
            screenshot = facts.windows.isEmpty
                ? Capability(name: "screenshot", available: false, detail: "No capturable window of the app in the locked session.")
                : Capability(name: "screenshot", available: true, detail: "Single-window capture while macOS stays locked (get_app_state).",
                             limits: facts.windows.count > 1 ? ["\(facts.windows.count) windows: pass window (title or id) to choose one."] : [])
        } else if facts.session == .locked {
            screenshot = Capability(name: "screenshot", available: false, detail: "macOS is locked.")
        } else if facts.hidden {
            screenshot = Capability(name: "screenshot", available: false, detail: "The app is hidden, and skfiy does not unhide it; element actions still work.")
        } else if shown?.minimized == true {
            screenshot = Capability(name: "screenshot", available: false, detail: "The window is minimized, and skfiy does not restore it; element actions still work.")
        } else if !facts.windows.contains(where: { $0.onScreen && !$0.minimized }) {
            screenshot = Capability(name: "screenshot", available: false, detail: "None of the app's windows is on screen (another desktop, full screen, or no window).")
        } else {
            screenshot = Capability(name: "screenshot", available: true, detail: "ScreenCaptureKit capture of the app's own windows, even when covered.")
        }
        channels.append(screenshot)
        channels.append(Capability(name: "ocr", available: screenshot.available,
                                   detail: screenshot.available ? "Vision text recognition of the screenshot, with x/y positions." : screenshot.detail))

        // Pointer input at screenshot coordinates.
        if blocker != nil {
            channels.append(blocked("pointer"))
        } else if let protectionNote, facts.protection != .terminal {
            channels.append(Capability(name: "pointer", available: false, detail: protectionNote))
        } else if facts.protection == .terminal {
            channels.append(Capability(name: "pointer", available: false, detail: protectionNote ?? "", limits: ["scroll still works."]))
        } else if lockedDirect {
            var limits = ["Coordinates must come from a get_app_state screenshot of the same window within 30 s; a moved or resized window needs a new one."]
            limits.append(facts.screenshotAge.map { "Current screenshot coordinates are \(Int($0)) s old." } ?? "No valid screenshot coordinates now: call get_app_state first.")
            if facts.chromium { limits.append("Chromium may ignore pointer events in a window that is not active; check the screenshot afterwards.") }
            channels.append(Capability(name: "pointer", available: screenshot.available, detail: screenshot.available
                ? "Mouse events posted to the process for the captured window (click, scroll, drag)." : screenshot.detail, limits: limits))
        } else if facts.session == .locked {
            channels.append(Capability(name: "pointer", available: false, detail: "macOS is locked."))
        } else if facts.hidden {
            channels.append(Capability(name: "pointer", available: false, detail: "The app is hidden; use element actions or the keyboard."))
        } else {
            var limits: [String] = []
            if facts.chromium || facts.webContent {
                limits.append("Web content ignores pointer events in background windows: prefer element_index or the browser_* tools; click with focus: true (asks once) or run_in_front for pixels.")
            }
            channels.append(Capability(name: "pointer", available: screenshot.available,
                                       detail: screenshot.available ? "Mouse events posted to the app at screenshot x/y, without moving the cursor." : "Needs a screenshot: " + screenshot.detail,
                                       limits: limits))
        }

        // Keyboard.
        if blocker != nil {
            channels.append(blocked("keyboard"))
        } else if let protectionNote {
            channels.append(Capability(name: "keyboard", available: false, detail: protectionNote))
        } else if lockedDirect {
            let count = facts.keyboardWindows ?? 0
            channels.append(count == 1
                ? Capability(name: "keyboard", available: true, detail: "Key events posted to the process; its one active window receives them.",
                             limits: ["Clipboard shortcuts are refused while locked.", "Any window change during input stops it."])
                : Capability(name: "keyboard", available: false,
                             detail: count == 0 ? "The app has no active window to receive keys." : "\(count) active windows: the keyboard destination cannot be verified while locked.",
                             limits: ["Leave one window open before locking, or unlock manually."]))
        } else if facts.session == .locked {
            channels.append(Capability(name: "keyboard", available: false, detail: "macOS is locked."))
        } else {
            var limits: [String] = []
            if facts.hasFocusedElement == false {
                limits.append("The app reports no focused element: keys may be lost until a field is clicked.")
            }
            if !facts.frontmost {
                limits.append("Menu commands that act on the document (formatting, Print, Undo) are disabled in the background: run_in_front.")
            }
            channels.append(Capability(name: "keyboard", available: true, detail: "Key events posted to the app in the background, unaffected by the user's input method.", limits: limits))
        }

        // Browser extension.
        if !facts.browserApp {
            channels.append(Capability(name: "browser", available: false, detail: "Not a Chromium browser; browser_* tools work on browsers with the skfiy extension.",
                                       limits: facts.connectedBrowsers.isEmpty ? [] : ["Connected: " + facts.connectedBrowsers.joined(separator: ", ") + "."]))
        } else if facts.emergencyStopped {
            channels.append(blocked("browser"))
        } else if facts.browserConnected {
            channels.append(Capability(name: "browser", available: true, detail: "browser_* tools through the skfiy extension: tabs by id, in background tabs, independent of the screen lock.",
                                       limits: facts.connectedBrowsers.count > 1 ? ["Several browsers are connected: pass browser (name or pid)."] : []))
        } else {
            channels.append(Capability(name: "browser", available: false, detail: "The skfiy extension is not connected in this browser (make install, then load it in chrome://extensions).",
                                       limits: facts.connectedBrowsers.isEmpty ? [] : ["Connected: " + facts.connectedBrowsers.joined(separator: ", ") + "."]))
        }

        // Foreground, file panels, clipboard: the user's visible desktop only.
        let desktop = blocker == nil && unlocked && facts.mode != .guardian
        if !desktop {
            let why = blocker ?? (facts.mode == .guardian ? "Unavailable under locked-use protection." : "macOS is locked.")
            channels.append(Capability(name: "foreground", available: false, detail: why))
            channels.append(Capability(name: "file_dialog", available: false, detail: why))
            channels.append(Capability(name: "clipboard", available: false, detail: why))
        } else {
            if protectionNote != nil {
                channels.append(Capability(name: "foreground", available: false, detail: protectionNote ?? ""))
            } else if facts.frontmost {
                channels.append(Capability(name: "foreground", available: false, detail: "The app is already frontmost: press_key reaches it directly."))
            } else if !facts.clientCanAsk {
                channels.append(Capability(name: "foreground", available: false, detail: "run_in_front needs the user's approval, and this client cannot ask them."))
            } else {
                channels.append(Capability(name: "foreground", available: true, detail: "run_in_front brings the app forward for about a second after the user approves."))
            }
            channels.append(Capability(name: "file_dialog", available: protectionNote == nil, detail: protectionNote ?? "file_dialog fills Open/Save panels through accessibility; open_file and save_document need none."))
            channels.append(Capability(name: "clipboard", available: protectionNote == nil, detail: protectionNote ?? "skfiy's own clipboard for cmd+c/x/v; read_clipboard asks the user."))
        }

        // Tools usable now, from the same decisions.
        let usable = Dictionary(uniqueKeysWithValues: channels.map { ($0.name, $0.available) })
        var tools: [String] = ["list_apps", "get_app_capabilities"]
        if facts.mode == .direct || facts.mode == .directEnded { tools += ["locked_use_status", "locked_use_end"] }
        if usable["browser"] == true { tools += ["browser_*"] }
        if blocker == nil {
            if lockedDirect {
                for tool in ["get_app_state", "click", "scroll", "drag", "press_key", "type_text", "wait_for", "zoom",
                             "find_element"] where lockedTools.contains(tool) {
                    switch tool {
                    case "click", "scroll", "drag": if usable["pointer"] == true { tools.append(tool) }
                    case "press_key", "type_text": if usable["keyboard"] == true { tools.append(tool) }
                    default: if usable["screenshot"] == true { tools.append(tool) }
                    }
                }
            } else if unlocked {
                tools += ["get_app_state", "wait_for"]
                if usable["ax"] == true { tools += ["perform_secondary_action", "set_value", "select_text"] }
                if usable["screenshot"] == true { tools.append("zoom") }
                if facts.protection == nil || facts.protection == .terminal { tools.append("scroll") }
                if facts.protection == nil { tools += ["click", "drag", "press_key", "type_text", "open_file", "save_document"] }
                if usable["foreground"] == true { tools.append("run_in_front") }
                if usable["file_dialog"] == true { tools.append("file_dialog") }
                if usable["clipboard"] == true { tools.append("read_clipboard") }
            }
        }
        return CapabilityReport(inputs: facts, channels: channels, tools: tools)
    }

    /// What the model reads: a summary, then the same facts as JSON.
    func render(changes: [String]?) -> String {
        var lines = ["Capabilities of \(inputs.appName)" + (inputs.pid.map { " (pid \($0))" } ?? "") + " — version \(version)"
            + (changes.map { $0.isEmpty ? " (unchanged since the last query)" : " (changed since the last query: \($0.joined(separator: ", ")))" } ?? "")]
        lines.append("Session: \(inputs.session.rawValue), mode: \(inputs.mode.rawValue); Accessibility \(inputs.accessibility ? "granted" : "missing"), Screen Recording \(inputs.screenRecording ? "granted" : "missing").")
        if !inputs.windows.isEmpty {
            let shown = inputs.windows.prefix(8).map { quote($0.title, limit: 50) + ($0.id.map { " id \($0)" } ?? "") + ($0.minimized ? " minimized" : "") }
            lines.append("Windows (\(inputs.windows.count)): " + shown.joined(separator: "; ") + (inputs.inspected.map { ". About: \(quote($0.title, limit: 50))." } ?? ""))
        }
        for channel in channels {
            lines.append("- \(channel.name): \(channel.available ? "available" : "unavailable") — \(channel.detail)")
            for limit in channel.limits { lines.append("    · \(limit)") }
        }
        lines.append("Tools usable now: " + tools.joined(separator: ", ") + ".")
        lines.append("Query again after a lock change, a window opening or closing, or a browser connecting; the version changes with any of these.")
        let data = try! JSONSerialization.data(withJSONObject: json(), options: [.sortedKeys])
        lines.append("JSON: " + String(decoding: data, as: UTF8.self))
        return lines.joined(separator: "\n")
    }
}

extension ComputerUse {
    /// get_app_capabilities: what works for this app right now, without
    /// launching it, reading its contents, or sending it anything.
    func appCapabilities(_ args: Arguments) async throws -> ToolResult {
        let query = try args.requiredString("app")
        let windowQuery = args.string("window")?.trimmingCharacters(in: .whitespaces)
        let lock = DirectLockedUse.lockState
        var facts = CapabilityInputs(
            session: lock == .locked ? .locked : lock == .unlocked ? .unlocked : .unknown,
            mode: DirectLockedUse.enabled ? (directLockedUse.isEnded ? .directEnded : .direct) : lockedUse != nil ? .guardian : .normal,
            appName: query)
        facts.emergencyStopped = EmergencyStop.isStopped
        facts.accessibility = AXIsProcessTrusted()
        facts.screenRecording = CGPreflightScreenCaptureAccess()
        facts.clientCanAsk = clientCanAsk?() ?? (askUser != nil)

        if case .running(let app) = try directory.resolve(query), !app.isTerminated {
            let pid = app.processIdentifier
            facts.appName = app.localizedName ?? query
            facts.bundleID = app.bundleIdentifier
            facts.pid = pid
            facts.hidden = app.isHidden
            facts.frontmost = frontmostProcessID() == pid
            facts.chromium = isChromium(app)
            facts.browserApp = facts.chromium && Self.isBrowserBundle(app.bundleIdentifier)
            let identifier = app.bundleIdentifier ?? ""
            if ["com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.securityagent", "io.github.sskift.skfiy.locked-use"].contains(identifier) {
                facts.protection = .system
            } else if hostProcesses.contains(pid) {
                facts.protection = .host
            } else if isTerminal(bundleID: identifier), ProcessInfo.processInfo.environment["SKFIY_ALLOW_TERMINALS"] != "1" {
                facts.protection = .terminal
            }
            if facts.session == .locked, facts.mode == .direct {
                if facts.screenRecording, let windows = try? await directLockedWindows(pid: pid) {
                    facts.windows = windows.map { .init(id: $0.id, title: $0.title) }
                    facts.keyboardWindows = (try? await directLockedActiveWindowIDs(pid: pid))?.count
                }
                facts.screenshotAge = directLockedUse.screenshotAge(pid: pid)
                if let windowQuery, !windowQuery.isEmpty {
                    facts.inspected = facts.windows.first { $0.title.localizedCaseInsensitiveContains(windowQuery) || $0.id.map(String.init) == windowQuery }
                } else {
                    facts.inspected = facts.windows.first
                }
            } else if facts.session == .unlocked, facts.accessibility {
                gatherAccessibilityFacts(&facts, app: app, windowQuery: windowQuery)
            }
        }
        let browsers = await Task.detached { BrowserBridge.connectedBrowsers() }.value
        facts.connectedBrowsers = browsers.map { "\($0.name) (pid \($0.pid))" }
        facts.browserConnected = facts.pid.map { pid in browsers.contains { $0.pid == Int(pid) } } ?? false

        let report = CapabilityReport.evaluate(facts)
        let key = facts.bundleID ?? facts.appName
        let changes = capabilityHistory[key].map { report.changes(since: $0) }
        capabilityHistory[key] = report
        return ToolResult(text: report.render(changes: changes))
    }

    private func gatherAccessibilityFacts(_ facts: inout CapabilityInputs, app: NSRunningApplication, windowQuery: String?) {
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appElement, 1)
        let onScreen = Set((CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
            .compactMap { row -> CGWindowID? in
                guard row[kCGWindowOwnerPID as String] as? Int == Int(app.processIdentifier) else { return nil }
                return row[kCGWindowNumber as String] as? CGWindowID
            })
        let windows = appElement.elements(kAXWindowsAttribute).filter { $0.string(kAXRoleAttribute) == kAXWindowRole }
        var pairs: [(AXUIElement, CapabilityInputs.Window)] = windows.map { element in
            let id = windowID(of: element)
            return (element, .init(id: id, title: element.string(kAXTitleAttribute) ?? "",
                                   minimized: element.bool(kAXMinimizedAttribute) == true,
                                   onScreen: id.map(onScreen.contains) ?? false))
        }
        let focused = appElement.element(kAXFocusedWindowAttribute) ?? appElement.element(kAXMainWindowAttribute)
        if let focused, let index = pairs.firstIndex(where: { CFEqual($0.0, focused) }), index > 0 {
            pairs.insert(pairs.remove(at: index), at: 0)
        }
        facts.windows = pairs.map(\.1)
        let chosen: AXUIElement?
        if let windowQuery, !windowQuery.isEmpty {
            let needle = normalizeAppName(windowQuery)
            chosen = pairs.first(where: { normalizeAppName($0.1.title) == needle || $0.1.id.map(String.init) == windowQuery })?.0
                ?? pairs.first(where: { normalizeAppName($0.1.title).contains(needle) })?.0
        } else {
            chosen = pairs.first?.0
        }
        if let chosen, let pair = pairs.first(where: { CFEqual($0.0, chosen) }) {
            facts.inspected = pair.1
            let (count, web) = Self.contentElements(in: chosen, budget: 600)
            facts.accessibilityElements = count
            facts.webContent = web
        }
        facts.hasFocusedElement = appElement.element(kAXFocusedUIElementAttribute) != nil
    }

    /// Elements other than window chrome, and whether web content is among them.
    static func contentElements(in window: AXUIElement, budget: Int) -> (Int, Bool) {
        let chrome: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton", "AXToolbarButton"]
        let containers: Set<String> = ["AXWindow", "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXUnknown", "AXSplitter"]
        var queue = [window]
        var visited = 0
        var count = 0
        var web = false
        while !queue.isEmpty, visited < budget {
            let element = queue.removeFirst()
            visited += 1
            let values = element.multipleValues([kAXRoleAttribute, kAXSubroleAttribute, kAXChildrenAttribute])
            let role = values[kAXRoleAttribute].flatMap(axString) ?? ""
            let subrole = values[kAXSubroleAttribute].flatMap(axString) ?? ""
            if role == "AXWebArea" { web = true }
            if !containers.contains(role), !chrome.contains(subrole) { count += 1 }
            queue.append(contentsOf: (values[kAXChildrenAttribute] as? [AXUIElement]) ?? [])
        }
        return (count, web)
    }

    /// Chromium browsers (which can run the extension), not CEF or Electron apps.
    static func isBrowserBundle(_ bundleID: String?) -> Bool {
        let id = (bundleID ?? "").lowercased()
        return ["com.google.chrome", "org.chromium.", "com.microsoft.edgemac", "com.brave.browser", "com.vivaldi.vivaldi",
                "company.thebrowser.", "com.operasoftware.", "ai.perplexity.comet"].contains { id.hasPrefix($0) }
    }
}
