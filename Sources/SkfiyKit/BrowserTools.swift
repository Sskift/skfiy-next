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
        "browser_tabs", "browser_open", "browser_state", "browser_click", "browser_type",
        "browser_select", "browser_press_key", "browser_scroll", "browser_navigate", "browser_close_tab",
        "browser_upload"
    ]
    /// Asks the user a yes/no question through the client; nil when it cannot.
    var askUser: ((String) async -> Bool?)?

    static let notConnected = """
    No browser is connected to skfiy. To enable the browser tools, run `make install` in the skfiy repository (or `skfiy install-browser-bridge`), then in Chrome open chrome://extensions, turn on Developer mode, click "Load unpacked", and choose ~/Library/Application Support/skfiy/browser-extension.
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
            return try await state(browser, tabID: tabID, prefix: nil, screenshot: (args.values["screenshot"] as? Bool) ?? true)
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
        case "browser_click", "browser_type", "browser_select", "browser_press_key", "browser_scroll":
            return try await act(name, args)
        case "browser_upload":
            return try await upload(args)
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
        if (args.values["trusted"] as? Bool) == true { params["trusted"] = true }
        switch name {
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
            if params["index"] == nil {
                guard let x = try args.double("x"), let y = try args.double("y") else {
                    throw ToolError("Pass index, or x and y from the tab's latest screenshot.")
                }
                guard let scale = screenshotScale[tabID] else {
                    throw ToolError("x/y need a screenshot of this tab first (browser_state on the tab the user sees); otherwise click by index.")
                }
                params["x"] = x * scale
                params["y"] = y * scale
            }
        case "browser_type":
            params["action"] = "type"
            params["text"] = try args.requiredText("text")
            params["clear"] = (args.values["clear"] as? Bool) ?? false
            params["submit"] = (args.values["submit"] as? Bool) ?? false
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
        let message = (result["message"] as? String) ?? "Done"
        return try await state(browser, tabID: tabID, prefix: message + ".", screenshot: false)
    }

    /// Sends a file to the page in pieces and attaches it to a file input,
    /// once the user has approved sending it to that site.
    private func upload(_ args: Arguments) async throws -> ToolResult {
        let tabID = try requiredTab(args)
        guard let index = try args.elementIndex("index") else { throw ToolError("Missing required argument \"index\".") }
        let path = (try args.requiredString("path") as NSString).expandingTildeInPath
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
        if let wanted = args.string("browser")?.lowercased(), !wanted.isEmpty {
            guard let match = browsers.first(where: { $0.name.lowercased().contains(wanted) }) else {
                throw ToolError("No connected browser matches \"\(wanted)\". Connected: \(browsers.map(\.name).joined(separator: ", ")).")
            }
            return match
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

    private func tabs(_ args: Arguments) async throws -> ToolResult {
        var browsers = await connected()
        guard !browsers.isEmpty else { throw ToolError(Self.notConnected) }
        if let wanted = args.string("browser")?.lowercased(), !wanted.isEmpty {
            browsers = browsers.filter { $0.name.lowercased().contains(wanted) }
        }
        var lines: [String] = []
        for browser in browsers {
            let windows = try await send(browser, "tabs", [:]) as? [[String: Any]] ?? []
            lines.append(contentsOf: formatTabs(browser: browser.name, windows: windows))
        }
        lines.append("")
        lines.append("[shown] marks the tab the user sees in their focused window; prefer working in other tabs, or open your own with browser_open.")
        return ToolResult(text: lines.joined(separator: "\n"))
    }

    private func state(_ browser: ConnectedBrowser, tabID: Int, prefix: String?, screenshot: Bool) async throws -> ToolResult {
        let page = try await send(browser, "state", ["tab_id": tabID]) as? [String: Any] ?? [:]
        var text = formatState(browser: browser.name, page: page)
        if let prefix { text = prefix + "\n" + text }
        var image: Data?
        if screenshot, page["active"] as? Bool == true,
           let shot = try? await send(browser, "screenshot", ["tab_id": tabID]) as? [String: Any],
           let jpeg = (shot["jpeg"] as? String).flatMap({ Data(base64Encoded: $0) }),
           let viewportWidth = (page["viewport"] as? [String: Any])?["width"] as? Int,
           let scaled = fitForModel(jpeg) {
            image = scaled.data
            screenshotScale[tabID] = Double(viewportWidth) / Double(scaled.width)
            text += "\n(Screenshot: \(scaled.width)×\(scaled.height) px of the viewport; browser_click accepts x/y in these pixels.)"
        }
        return ToolResult(text: text, image: image, imageMimeType: "image/jpeg")
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
    guard let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return nil }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage(), let encoded = try? encode(scaled, format: "jpeg") else { return nil }
    return (encoded, width, height)
}
