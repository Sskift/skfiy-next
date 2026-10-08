import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Web page tools backed by the browser bridge extension. They address tabs by
/// id, so they work on background tabs and never switch what the user sees.
@MainActor
final class BrowserTools {
    /// Viewport CSS pixels per screenshot pixel, per tab, from its last screenshot.
    private var screenshotScale: [Int: Double] = [:]

    nonisolated static let toolNames = [
        "browser_tabs", "browser_open", "browser_state", "browser_locate", "browser_click", "browser_type",
        "browser_select", "browser_press_key", "browser_scroll", "browser_navigate", "browser_close_tab",
        "browser_upload", "browser_hover", "browser_downloads", "browser_wait"
    ]
    /// Tools that accept `target` instead of index or x/y.
    nonisolated static let targetTools: Set<String> = [
        "browser_click", "browser_type", "browser_select", "browser_press_key", "browser_scroll", "browser_hover", "browser_upload"
    ]
    /// Asks the user a yes/no question through the client; nil when it cannot.
    var askUser: ((String) async -> Bool?)?
    /// The last typing went into a password field (for the action log).
    var lastInputWasSecret = false

    static let notConnected = """
    No browser is connected to skfiy. To enable the browser tools, run `skfiy setup` in a terminal, then in Chrome open chrome://extensions, turn on Developer mode, click "Load unpacked", and choose ~/Library/Application Support/skfiy/browser-extension.
    A running Chrome with no window open has its extensions unloaded until a window opens again.
    Until then, drive the browser with get_app_state and the other app tools.
    """

    func call(_ name: String, _ args: Arguments) async throws -> ToolResult {
        switch name {
        case "browser_tabs":
            return try await tabs(args)
        case "browser_open":
            guard let url = args.string("url"), !url.isEmpty else { throw ToolError("Missing required argument \"url\".") }
            let tabID = try args.int("tab_id")
            let browser = try await browser(for: args, tabID: tabID)
            var params: [String: Any] = ["url": url]
            if let tabID { params["tab_id"] = tabID }
            let result = try await send(browser, "open", params, timeout: 30) as? [String: Any] ?? [:]
            guard let opened = result["tabId"] as? Int else { throw ToolError("The browser did not report the tab.") }
            let verb = tabID == nil ? "Opened \(url) in background tab \(opened) (in the \"skfiy\" tab group)." : "Navigated tab \(opened) to \(url)."
            return try await state(browser, tabID: opened, prefix: verb, screenshot: false)
        case "browser_state":
            let tabID = try requiredTab(args)
            let browser = try await browser(for: args, tabID: tabID)
            return try await state(browser, tabID: tabID, prefix: nil, screenshot: args.bool("screenshot") ?? true,
                                   background: args.bool("background_screenshot") ?? false)
        case "browser_locate":
            let tabID = try requiredTab(args)
            guard let locator = try Locator.parse(args.values["target"]) else { throw ToolError("Missing required argument \"target\".") }
            let browser = try await browser(for: args, tabID: tabID)
            let found = try await locate(locator, browser: browser, tabID: tabID)
            return ToolResult(text: describe(found, locator: locator, tabID: tabID, acting: false), isError: found.matches.isEmpty)
        case "browser_navigate":
            let tabID = try requiredTab(args)
            let action = try args.requiredString("action")
            let browser = try await browser(for: args, tabID: tabID)
            _ = try await send(browser, "navigate", ["tab_id": tabID, "action": action], timeout: 30)
            return try await state(browser, tabID: tabID, prefix: "Went \(action) in tab \(tabID).", screenshot: false)
        case "browser_close_tab":
            let tabID = try requiredTab(args)
            let browser = try await browser(for: args, tabID: tabID)
            _ = try await send(browser, "close", ["tab_id": tabID])
            return ToolResult(text: "Closed tab \(tabID).")
        case "browser_click", "browser_type", "browser_select", "browser_press_key", "browser_scroll", "browser_hover":
            return try await act(name, args)
        case "browser_upload":
            return try await upload(args)
        case "browser_wait":
            return try await wait(args)
        case "browser_downloads":
            return try await downloads(args)
        default:
            throw ToolError("Unknown tool \(name).")
        }
    }

    private func requiredTab(_ args: Arguments) throws -> Int {
        guard let tabID = try args.int("tab_id") else {
            throw ToolError("Missing required argument \"tab_id\" (see browser_tabs).")
        }
        return tabID
    }

    private func act(_ name: String, _ args: Arguments) async throws -> ToolResult {
        let tabID = try requiredTab(args)
        var params: [String: Any] = ["tab_id": tabID]
        if let index = try args.elementIndex("index") { params["index"] = index }
        var located: String?
        if let locator = try Locator.parse(args.values["target"]) {
            let resolved = try await resolve(locator, args: args, tabID: tabID, pointAllowed: ["browser_click", "browser_hover"].contains(name))
            params.merge(resolved.params) { _, new in new }
            located = resolved.note
        }
        if args.bool("trusted") == true { params["trusted"] = true }
        switch name {
        case "browser_hover":
            params["action"] = "hover"
            try addPoint(&params, args, tabID: tabID, verb: "hover")
        case "browser_click":
            params["action"] = "click"
            if let dialog = args.string("dialog") {
                guard ["accept", "dismiss"].contains(dialog) else { throw ToolError("dialog must be accept or dismiss.") }
                params["dialog"] = dialog
            }
            if let text = args.string("prompt_text") {
                params["dialog"] = params["dialog"] ?? "accept"
                params["prompt_text"] = text
            }
            try addPoint(&params, args, tabID: tabID, verb: "click")
        case "browser_type":
            params["action"] = "type"
            params["text"] = try args.requiredText("text")
            params["clear"] = args.bool("clear") ?? false
            params["submit"] = args.bool("submit") ?? false
        case "browser_select":
            guard params["index"] != nil else { throw ToolError("Missing required argument \"index\".") }
            params["action"] = "select"
            params["option"] = try args.requiredText("option")
        case "browser_press_key":
            params["action"] = "key"
            params["key"] = try args.requiredString("key")
        default:
            params["action"] = "scroll"
            let direction = try args.requiredString("direction").lowercased()
            guard ["up", "down", "left", "right"].contains(direction) else {
                throw ToolError("direction must be up, down, left, or right.")
            }
            params["direction"] = direction
            params["pages"] = try args.double("pages") ?? 1
        }
        let browser = try await browser(for: args, tabID: tabID)
        let result = try await send(browser, "act", params, timeout: 30) as? [String: Any] ?? [:]
        lastInputWasSecret = result["secret"] as? Bool == true
        let message = (result["message"] as? String) ?? "Done"
        return try await state(browser, tabID: tabID, prefix: (located.map { $0 + "\n" } ?? "") + message + ".", screenshot: false)
    }

    /// Without an index (or a target resolved to a point): x/y of the tab's
    /// latest screenshot, as viewport CSS pixels.
    private func addPoint(_ params: inout [String: Any], _ args: Arguments, tabID: Int, verb: String) throws {
        guard params["index"] == nil, params["x"] == nil else { return }
        guard let x = try args.double("x"), let y = try args.double("y") else {
            throw ToolError("Pass index, or x and y from the tab's latest screenshot.")
        }
        guard let scale = screenshotScale[tabID] else {
            throw ToolError("x/y need a screenshot of this tab first (browser_state; for a background tab with background_screenshot: true); otherwise \(verb) by index.")
        }
        params["x"] = x * scale
        params["y"] = y * scale
    }

    /// Sends a file to the page in pieces and attaches it to a file input,
    /// once the user has approved sending it to that site.
    private func upload(_ args: Arguments) async throws -> ToolResult {
        let tabID = try requiredTab(args)
        var index = try args.elementIndex("index")
        if let locator = try Locator.parse(args.values["target"]) {
            index = try await resolve(locator, args: args, tabID: tabID, pointAllowed: false).params["index"] as? Int
        }
        guard let index else { throw ToolError("Missing required argument \"index\" (or a target).") }
        var requested = (args.string("path") ?? "") as NSString
        if let downloadID = try args.int("download_id") {
            // A finished download hands its file straight on.
            let browser = try await browser(for: args, tabID: tabID)
            let item = try await send(browser, "download_get", ["id": downloadID]) as? [String: Any] ?? [:]
            guard let ready = DownloadInfo(item), ready.usable else {
                throw ToolError("Download \(downloadID) is not a finished file yet (\(DownloadInfo(item)?.status ?? "unknown")). Wait for it with browser_downloads action wait.")
            }
            requested = ready.path as NSString
        }
        guard requested.length > 0 else { throw ToolError("Pass path, or download_id of a finished download.") }
        let path = requested.expandingTildeInPath
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw ToolError("No file at \(path).")
        }
        let data: Data
        do { data = try Data(contentsOf: URL(fileURLWithPath: path)) } catch {
            throw ToolError("Could not read \(path): \(error.localizedDescription)")
        }
        guard data.count <= 20_000_000 else { throw ToolError("\(path) is larger than 20 MB.") }
        let browser = try await browser(for: args, tabID: tabID)
        let windows = (try? await send(browser, "tabs", [:]) as? [[String: Any]]) ?? []
        let url = windows.flatMap { ($0["tabs"] as? [[String: Any]]) ?? [] }.first { $0["id"] as? Int == tabID }?["url"] as? String
        let site = url.flatMap { URL(string: $0)?.host } ?? "tab \(tabID)"
        let name = (path as NSString).lastPathComponent
        let size = ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
        let allowed: Bool?
        if ProcessInfo.processInfo.environment["SKFIY_UPLOAD_WITHOUT_ASKING"] == "1" {
            allowed = true
        } else {
            allowed = await askUser?("skfiy wants to upload \(name) (\(size), from \(path)) to \(site).")
        }
        switch allowed {
        case nil: throw ToolError("Uploading sends a file to a website, so the user must approve it, and this client cannot ask them. Tell the user which file to attach.")
        case false?: throw ToolError("The user declined uploading \(name). Do not ask again; tell them what is left to do.")
        case true?: break
        }
        let token = UUID().uuidString
        let encoded = data.base64EncodedString()
        var offset = encoded.startIndex
        while offset < encoded.endIndex {
            let end = encoded.index(offset, offsetBy: 400_000, limitedBy: encoded.endIndex) ?? encoded.endIndex
            _ = try await send(browser, "act", ["tab_id": tabID, "index": index, "action": "upload-chunk",
                                                "token": token, "data": String(encoded[offset..<end])], timeout: 30)
            offset = end
        }
        let mime = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let result = try await send(browser, "act", ["tab_id": tabID, "index": index, "action": "upload-commit",
                                                     "token": token, "name": name, "mime": mime], timeout: 30) as? [String: Any] ?? [:]
        return try await state(browser, tabID: tabID, prefix: ((result["message"] as? String) ?? "Attached \(name)") + ", with the user's approval.", screenshot: false)
    }

    /// Asks the page a few times a second, sending it nothing, until a text
    /// shows up (or goes away), or without a text until it is loaded and quiet.
    private func wait(_ args: Arguments) async throws -> ToolResult {
        let tabID = try requiredTab(args)
        let timeout = try args.double("timeout") ?? 10
        guard (0.5...60).contains(timeout) else {
            throw ToolError("timeout must be between 0.5 and 60 seconds.")
        }
        let text = args.string("text")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let gone = args.bool("gone") ?? false
        if gone, text.isEmpty {
            throw ToolError("gone needs a text to wait for the disappearance of.")
        }
        let browser = try await browser(for: args, tabID: tabID)
        let started = Date()
        var met = false
        while !met {
            if EmergencyStop.isStopped { throw ToolError(EmergencyStop.refusal) }
            // A cancelled request stops here; otherwise the sleep below would
            // return at once and the page be probed back to back until timeout.
            try Task.checkCancellation()
            let probe = (try? await send(browser, "probe", ["tab_id": tabID, "text": text]) as? [String: Any]) ?? [:]
            let loading = probe["loading"] as? Bool ?? true
            if text.isEmpty {
                met = !loading && ((probe["quietMs"] as? NSNumber)?.doubleValue ?? 0) >= 500
            } else if let found = probe["found"] as? Bool {
                met = found != gone
            }
            if !met {
                if Date().timeIntervalSince(started) >= timeout { break }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        let waited = formatNumber((Date().timeIntervalSince(started) * 10).rounded() / 10)
        var state = try await state(browser, tabID: tabID, prefix: nil, screenshot: false)
        let subject = quote(text, limit: 60)
        let outcome = switch (text.isEmpty, gone, met) {
        case (true, _, true): "The page finished loading and stopped changing after \(waited) s."
        case (true, _, false): "The page was still loading or changing after \(waited) s."
        case (false, false, true): "\(subject) appeared after \(waited) s."
        case (false, false, false): "\(subject) did not appear within \(waited) s."
        case (false, true, true): "\(subject) was gone after \(waited) s."
        case (false, true, false): "\(subject) was still there after \(waited) s."
        }
        state.text = outcome + "\n" + state.text
        state.isError = !met
        return state
    }

    // MARK: Downloads

    /// Downloads skfiy caused in a browser: list them, wait for one to end,
    /// start one from a URL, or cancel one. Only a complete download whose
    /// file exists yields a path to hand on.
    private func downloads(_ args: Arguments) async throws -> ToolResult {
        let action = (args.string("action") ?? "list").lowercased()
        let browser = try await browser(for: args, tabID: nil)
        switch action {
        case "list":
            let items = try await downloadList(browser).items
            guard !items.isEmpty else { return ToolResult(text: "No downloads started by skfiy in \(browser.name) yet (the user's own downloads are not listed).") }
            return ToolResult(text: (["Downloads skfiy started in \(browser.name), newest first:"] + items.map { "  " + $0.line }).joined(separator: "\n"))
        case "start":
            guard let url = args.string("url"), !url.isEmpty else { throw ToolError("start needs a url.") }
            var params: [String: Any] = ["url": url]
            if let name = args.string("filename"), !name.isEmpty { params["filename"] = name }
            let started = try await send(browser, "download_start", params) as? [String: Any] ?? [:]
            guard let id = started["id"] as? Int else { throw ToolError("The browser did not start the download.") }
            return try await waitDownload(browser, id: id, timeout: try args.double("timeout") ?? 30, prefix: "Started download \(id) of \(url).")
        case "cancel":
            guard let id = try args.int("download_id") else { throw ToolError("cancel needs a download_id.") }
            let item = DownloadInfo(try await send(browser, "download_cancel", ["id": id]) as? [String: Any] ?? [:])
            return ToolResult(text: "Download \(id): \(item?.status ?? "unknown"). No file is handed on from a cancelled download.")
        case "wait":
            let timeout = try args.double("timeout") ?? 30
            if let id = try args.int("download_id") {
                return try await waitDownload(browser, id: id, timeout: timeout, prefix: nil)
            }
            // The download caused by skfiy's latest action in a tab: one that
            // started after it. An older download is not what this wait is about.
            let started = Date()
            while Date().timeIntervalSince(started) < min(timeout, 10) {
                let list = try await downloadList(browser)
                if let fresh = list.items.first(where: { ($0.started ?? 0) >= list.lastAct - 1 }) {
                    return try await waitDownload(browser, id: fresh.id, timeout: max(0.5, timeout - Date().timeIntervalSince(started)), prefix: nil)
                }
                try await Task.sleep(nanoseconds: 300_000_000)
            }
            throw ToolError("No download started after skfiy's last action in this browser. If that was a click on a download link, the browser may have blocked it: Chrome lets a site start one download without a real user gesture, then blocks further automatic downloads. Download the link's URL with action start instead, or check the page.")
        default:
            throw ToolError("action must be list, wait, start or cancel.")
        }
    }

    private func downloadList(_ browser: ConnectedBrowser) async throws -> (items: [DownloadInfo], lastAct: Double) {
        let reply = try await send(browser, "downloads", [:]) as? [String: Any] ?? [:]
        let items = ((reply["downloads"] as? [[String: Any]]) ?? []).compactMap(DownloadInfo.init)
        return (items, ((reply["lastAct"] as? NSNumber)?.doubleValue ?? 0) / 1000)
    }

    private func waitDownload(_ browser: ConnectedBrowser, id: Int, timeout: Double, prefix: String?) async throws -> ToolResult {
        guard timeout.isFinite, (0.5...600).contains(timeout) else { throw ToolError("timeout must be between 0.5 and 600 seconds.") }
        let started = Date()
        var item: DownloadInfo?
        while true {
            if EmergencyStop.isStopped { throw ToolError(EmergencyStop.refusal) }
            try Task.checkCancellation()
            item = DownloadInfo(try await send(browser, "download_get", ["id": id]) as? [String: Any] ?? [:])
            if let item, item.state != "in_progress" || Date().timeIntervalSince(started) >= timeout { break }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        guard let item else { throw ToolError("Download \(id) disappeared from the browser's list.") }
        let lead = prefix.map { $0 + "\n" } ?? ""
        if item.usable {
            return ToolResult(text: lead + "Download \(id) finished: \(item.path) (\(item.size)). Hand it on with open_file(path) or browser_upload(download_id: \(id)); the file is only handed on now that it is complete.")
        }
        return ToolResult(text: lead + "Download \(id) did not finish: \(item.status). No file is handed on.", isError: true)
    }

    // MARK: Browsers and requests

    private func send(_ browser: ConnectedBrowser, _ method: String, _ params: [String: Any], timeout: TimeInterval = 20) async throws -> Any {
        let path = browser.socketPath
        let box = UncheckedBox(params)
        return try await Task.detached {
            try BrowserBridge.request(path, method: method, params: box.value, timeout: timeout)
        }.value
    }

    private func connected() async -> [ConnectedBrowser] {
        await Task.detached { BrowserBridge.connectedBrowsers() }.value
    }

    private func browser(for args: Arguments, tabID: Int?) async throws -> ConnectedBrowser {
        let browsers = await connected()
        guard !browsers.isEmpty else { throw ToolError(Self.notConnected) }
        if let wanted = args.string("browser"), !wanted.isEmpty {
            return try Self.matching(wanted, in: browsers)[0]
        }
        if browsers.count == 1 { return browsers[0] }
        if let tabID {
            for browser in browsers {
                let windows = (try? await send(browser, "tabs", [:]) as? [[String: Any]]) ?? []
                if windows.contains(where: { (($0["tabs"] as? [[String: Any]]) ?? []).contains { $0["id"] as? Int == tabID } }) {
                    return browser
                }
            }
            throw ToolError("No connected browser has tab \(tabID). Call browser_tabs.")
        }
        throw ToolError("Several browsers are connected (\(browsers.map(\.name).joined(separator: ", "))); pass browser.")
    }

    /// The connected browsers that `browser` names: a process id exactly (two
    /// browsers can share a name, as Chrome and Chrome for Testing do), else
    /// every one whose name contains it. Naming none is an error, not an
    /// empty list.
    nonisolated static func matching(_ wanted: String, in browsers: [ConnectedBrowser]) throws -> [ConnectedBrowser] {
        let wanted = wanted.lowercased()
        let found = Int(wanted) != nil
            ? browsers.filter { String($0.pid) == wanted }
            : browsers.filter { $0.name.lowercased().contains(wanted) }
        guard !found.isEmpty else {
            let connected = browsers.map { "\($0.name) (pid \($0.pid))" }.joined(separator: ", ")
            throw ToolError("No connected browser matches \"\(wanted)\". Connected: \(connected).")
        }
        return found
    }

    private func tabs(_ args: Arguments) async throws -> ToolResult {
        var browsers = await connected()
        guard !browsers.isEmpty else { throw ToolError(Self.notConnected) }
        if let wanted = args.string("browser"), !wanted.isEmpty {
            browsers = try Self.matching(wanted, in: browsers)
        }
        var lines: [String] = []
        for browser in browsers {
            let windows = try await send(browser, "tabs", [:]) as? [[String: Any]] ?? []
            lines.append(contentsOf: formatTabs(browser: "\(browser.name) (pid \(browser.pid))", windows: windows))
        }
        lines.append("")
        lines.append("[shown] marks the tab the user sees in their focused window; prefer working in other tabs, or open your own with browser_open.")
        return ToolResult(text: lines.joined(separator: "\n"))
    }

    private func state(_ browser: ConnectedBrowser, tabID: Int, prefix: String?, screenshot: Bool, background: Bool = false) async throws -> ToolResult {
        let page = try await send(browser, "state", ["tab_id": tabID]) as? [String: Any] ?? [:]
        var text = formatState(browser: browser.name, page: page)
        if let prefix { text = prefix + "\n" + text }
        var image: Data?
        let shown = page["active"] as? Bool == true
        if screenshot, shown || background {
            let shot = try? await send(browser, "screenshot", ["tab_id": tabID, "background": background]) as? [String: Any]
            if let jpeg = (shot?["jpeg"] as? String).flatMap({ Data(base64Encoded: $0) }),
               let viewportWidth = (page["viewport"] as? [String: Any])?["width"] as? Int,
               let scaled = fitForModel(jpeg) {
                image = scaled.data
                screenshotScale[tabID] = Double(viewportWidth) / Double(scaled.width)
                text += "\n(Screenshot: \(scaled.width)×\(scaled.height) px of the viewport\(shot?["debugger"] as? Bool == true ? ", taken through Chrome's debugger" : ""); browser_click accepts x/y in these pixels.)"
            } else if background {
                text += "\n(No screenshot: \((shot?["unavailable"] as? String) ?? "Chrome's debugger could not capture this tab").)"
            }
        } else if screenshot {
            text += "\n(No screenshot: this tab is in the background. Pass background_screenshot: true to take one through Chrome's debugger, if the page's look matters: canvas, charts, images.)"
        }
        return ToolResult(text: text, image: image, imageMimeType: "image/jpeg")
    }
}

/// A download as the extension reports it.
struct DownloadInfo: Equatable {
    let id: Int
    let url: String
    let path: String
    let state: String
    let error: String?
    let bytes: Int
    let total: Int
    let exists: Bool
    /// Seconds since 1970 when it started.
    let started: Double?

    init?(_ item: [String: Any]) {
        guard let id = item["id"] as? Int, let state = item["state"] as? String else { return nil }
        self.id = id
        self.state = state
        url = item["url"] as? String ?? ""
        path = item["path"] as? String ?? ""
        error = item["error"] as? String
        bytes = (item["bytes"] as? NSNumber)?.intValue ?? 0
        total = (item["total"] as? NSNumber)?.intValue ?? 0
        exists = item["exists"] as? Bool ?? false
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        started = (item["started"] as? String).flatMap { iso.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }?.timeIntervalSince1970
    }

    /// Complete, and the file is there: only then is it handed on.
    var usable: Bool { state == "complete" && exists && !path.isEmpty && FileManager.default.fileExists(atPath: path) }

    var size: String { ByteCountFormatter.string(fromByteCount: Int64(max(bytes, total)), countStyle: .file) }

    var status: String {
        switch state {
        case "complete": return usable ? "complete" : "complete, but the file is gone from \(path)"
        case "in_progress":
            let share = total > 0 ? " \(Int(Double(bytes) / Double(total) * 100))%" : ""
            return "still downloading\(share) (\(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)))"
        default: return "\(Self.reason(error)) (\(error ?? "interrupted"))"
        }
    }

    var line: String {
        let name = path.isEmpty ? url : path
        return "download \(id): \(status) — \(name)"
    }

    /// Chrome's interrupt reasons, in words.
    static func reason(_ code: String?) -> String {
        switch code ?? "" {
        case "USER_CANCELED": return "cancelled"
        case "NETWORK_FAILED", "NETWORK_TIMEOUT", "NETWORK_DISCONNECTED": return "the network connection failed"
        case "NETWORK_SERVER_DOWN": return "the server could not be reached"
        case "SERVER_FAILED", "SERVER_NO_RANGE": return "the server failed"
        case "SERVER_CONTENT_LENGTH_MISMATCH": return "the transfer broke off (less arrived than the server announced)"
        case "SERVER_BAD_CONTENT": return "the server has no such file (HTTP error)"
        case "SERVER_UNAUTHORIZED", "SERVER_FORBIDDEN", "SERVER_CERT_PROBLEM": return "the server refused it"
        case "FILE_FAILED", "FILE_ACCESS_DENIED", "FILE_NO_SPACE", "FILE_NAME_TOO_LONG", "FILE_TOO_LARGE", "FILE_TRANSIENT_ERROR": return "the file could not be written"
        case "FILE_VIRUS_INFECTED", "FILE_BLOCKED", "FILE_SECURITY_CHECK_FAILED": return "the browser blocked it"
        case "CRASH", "USER_SHUTDOWN": return "the browser stopped"
        default: return "it was interrupted"
        }
    }
}

private struct UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

// MARK: - Formatting (pure)

func formatTabs(browser: String, windows: [[String: Any]]) -> [String] {
    var lines = ["\(browser):"]
    for window in windows {
        let id = window["windowId"] as? Int ?? 0
        var header = "  window \(id)"
        if window["focused"] as? Bool == true { header += " (focused)" }
        if window["minimized"] as? Bool == true { header += " (minimized)" }
        lines.append(header)
        for tab in (window["tabs"] as? [[String: Any]]) ?? [] {
            var line = "    tab \(tab["id"] as? Int ?? 0)"
            if tab["userVisible"] as? Bool == true { line += " [shown]" }
            else if tab["active"] as? Bool == true { line += " [front tab of its window]" }
            if tab["loading"] as? Bool == true { line += " [loading]" }
            line += " " + quote(tab["title"] as? String ?? "", limit: 80) + " — " + String((tab["url"] as? String ?? "").prefix(120))
            lines.append(line)
        }
    }
    return lines
}

func formatState(browser: String, page: [String: Any]) -> String {
    let tabID = page["tabId"] as? Int ?? 0
    let title = page["title"] as? String ?? ""
    let url = page["url"] as? String ?? ""
    var lines = ["Tab \(tabID) · \(browser) · \(quote(title, limit: 100)) — \(url)"]
    if let viewport = page["viewport"] as? [String: Any], let scroll = page["scroll"] as? [String: Any] {
        let y = scroll["y"] as? Int ?? 0
        let maximum = scroll["max"] as? Int ?? 0
        var line = "Viewport \(viewport["width"] as? Int ?? 0)×\(viewport["height"] as? Int ?? 0) · scrolled \(y) of \(maximum) px"
        if maximum > 0 { line += y < maximum ? " (more below)" : " (at the bottom)" }
        lines.append(line)
    }
    if let focused = page["focused"] as? Int, focused >= 0 {
        lines.append("Keyboard focus: [\(focused)]")
    }
    lines.append("")
    lines.append(contentsOf: (page["lines"] as? [String]) ?? [])
    if page["truncated"] as? Bool == true {
        lines.append("(Page text truncated; scroll or use browser_scroll to see more.)")
    }
    return lines.joined(separator: "\n")
}

/// Downscales a screenshot to the model's image limits so coordinates read
/// off it stay exact.
func fitForModel(_ data: Data) -> (data: Data, width: Int, height: Int)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    let scale = captureScale(for: CGSize(width: image.width, height: image.height))
    guard scale < 1 else { return (data, image.width, image.height) }
    let width = max(1, Int((Double(image.width) * scale).rounded()))
    let height = max(1, Int((Double(image.height) * scale).rounded()))
    guard let scaled = resized(image, width: width, height: height), let encoded = try? encode(scaled, format: "jpeg") else { return nil }
    return (encoded, width, height)
}

// MARK: - Locating

extension BrowserTools {
    struct Found {
        var viewport: CGRect
        var matches: [LocatorMatch]
        var chosen: LocatorMatch?
        var elsewhere: [LocatorMatch]
    }

    /// The tab's elements and text blocks with their boxes, read now (which
    /// refreshes element indices, as browser_state does), matched.
    func locate(_ locator: Locator, browser: ConnectedBrowser, tabID: Int) async throws -> Found {
        let page = try await send(browser, "state", ["tab_id": tabID, "locate": true, "max_chars": 200_000]) as? [String: Any] ?? [:]
        guard let raw = page["items"] as? [[String: Any]] else {
            throw ToolError("The skfiy extension in this browser is older than skfiy and cannot locate. Reload it: chrome://extensions → skfiy browser bridge → reload.")
        }
        let viewport = page["viewport"] as? [String: Any]
        let bounds = CGRect(x: 0, y: 0, width: (viewport?["width"] as? NSNumber)?.doubleValue ?? 0, height: (viewport?["height"] as? NSNumber)?.doubleValue ?? 0)
        let candidates = raw.compactMap { item -> LocatorCandidate? in
            guard let rect = (item["rect"] as? [NSNumber])?.map(\.doubleValue), rect.count == 4, rect[2] >= 1 || rect[3] >= 1 else { return nil }
            return LocatorCandidate(label: item["label"] as? String ?? "", role: item["kind"] as? String ?? "",
                                    frame: CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3]),
                                    containers: item["sections"] as? [String] ?? [], index: (item["index"] as? NSNumber)?.intValue)
        }
        let scale = screenshotScale[tabID]
        let pixelArea = scale.map { scale in { (rect: CGRect) in CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale) } }
        if case .pixels? = locator.area, scale == nil {
            throw ToolError("A region in pixels needs a screenshot of this tab first (browser_state); or name the region, e.g. bottom-right.")
        }
        let matches = locator.matches(candidates, bounds: bounds, pixelArea: pixelArea)
        let elsewhere = matches.isEmpty ? (locator.loosened.map { $0.matches(candidates, bounds: bounds) } ?? []) : []
        return Found(viewport: bounds, matches: matches, chosen: locator.unique(matches), elsewhere: elsewhere)
    }

    func line(_ match: LocatorMatch, tabID: Int, viewport: CGRect) -> String {
        let candidate = match.candidate
        var parts = [candidate.index.map { "[\($0)]" }, candidate.role + (candidate.label.isEmpty ? "" : " \(quote(candidate.label, limit: 60))")].compactMap { $0 }
        let inView = viewport.contains(CGPoint(x: candidate.frame.midX, y: candidate.frame.midY))
        parts.append(inView ? match.area : candidate.frame.midY < viewport.minY ? "above the visible part" : "out of view (scroll)")
        if inView, let scale = screenshotScale[tabID], scale > 0 {
            parts.append("x=\(Int((candidate.frame.midX / scale).rounded())) y=\(Int((candidate.frame.midY / scale).rounded()))")
        }
        if let section = candidate.containers.first { parts.append("in \(quote(section, limit: 40))") }
        if let distance = match.distance { parts.append("\(Int(distance.rounded())) px from the near text") }
        return parts.joined(separator: " ")
    }

    func describe(_ found: Found, locator: Locator, tabID: Int, acting: Bool) -> String {
        if found.matches.isEmpty {
            var text = "Nothing in tab \(tabID) matches \(locator.summary) (the page as it is now)" + (acting ? "; nothing was done." : ".")
            if !found.elsewhere.isEmpty {
                text += " Matching the name/kind alone, elsewhere:\n" + found.elsewhere.prefix(10).map { "  " + line($0, tabID: tabID, viewport: found.viewport) }.joined(separator: "\n")
            }
            return text
        }
        let listed = found.matches.prefix(15).enumerated().map { "  \($0.offset + 1). " + line($0.element, tabID: tabID, viewport: found.viewport) }
        if found.chosen == nil {
            return "\(found.matches.count) candidates match \(locator.summary) in tab \(tabID); skfiy does not choose between them" + (acting ? ", so nothing was done" : "")
                + ". Narrow the target with region, within, near, below or right_of, or act on one by its index (refreshed just now):\n" + listed.joined(separator: "\n")
        }
        return "\(found.matches.count == 1 ? "1 match" : "\(found.matches.count) matches, one clearly meant") for \(locator.summary) in tab \(tabID) (indices refreshed just now):\n"
            + listed.joined(separator: "\n")
    }

    /// The index (or, for text without one, the point in viewport CSS
    /// pixels) a target means now; otherwise why not.
    func resolve(_ locator: Locator, args: Arguments, tabID: Int, pointAllowed: Bool) async throws -> (params: [String: Any], note: String) {
        if ["index", "x", "y"].contains(where: { args.values[$0] != nil && !(args.values[$0] is NSNull) }) {
            throw ToolError("Pass either target or index / x,y — not both.")
        }
        let browser = try await browser(for: args, tabID: tabID)
        let found = try await locate(locator, browser: browser, tabID: tabID)
        guard let chosen = found.chosen else { throw ToolError(describe(found, locator: locator, tabID: tabID, acting: true)) }
        let note = "Target \(locator.summary) → " + line(chosen, tabID: tabID, viewport: found.viewport) + " (found just now)."
        if let index = chosen.candidate.index { return (["index": index], note) }
        let frame = chosen.candidate.frame
        guard pointAllowed else {
            throw ToolError("\(locator.summary) matched text, not an element that takes this action (\(line(chosen, tabID: tabID, viewport: found.viewport))). Describe the field or control itself, e.g. with role and near/right_of that text; nothing was done.")
        }
        guard found.viewport.contains(CGPoint(x: frame.midX, y: frame.midY)) else {
            throw ToolError("\(locator.summary) matched text outside the visible part of the page (\(line(chosen, tabID: tabID, viewport: found.viewport))); scroll to it first. Nothing was done.")
        }
        return (["x": Double(frame.midX.rounded()), "y": Double(frame.midY.rounded())], note)
    }
}
