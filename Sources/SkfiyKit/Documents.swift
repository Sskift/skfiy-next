import AppKit
import ApplicationServices
import Foundation

/// Files without the Open and Save panels where possible: open_file,
/// save_document (Apple Events, else the app's own Save panel), and
/// file_dialog for a panel an app is already showing.
extension ComputerUse {
    // MARK: - open_file

    /// Opens a document or folder the way a double-click would, but without
    /// activating anything, so no Open panel is needed.
    func openFile(_ args: Arguments) async throws -> ToolResult {
        let path = try args.absolutePath("path")
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            throw ToolError("Nothing exists at \(path).")
        }
        let url = URL(fileURLWithPath: path)
        if url.pathExtension.lowercased() == "app" {
            throw ToolError("\(url.lastPathComponent) is an app; launch it with get_app_state instead.")
        }
        let appURL: URL
        if let query = args.string("app"), !query.trimmingCharacters(in: .whitespaces).isEmpty {
            switch try directory.resolve(query) {
            case .running(let app):
                guard let bundle = app.bundleURL else { throw ToolError("\(query) has no app bundle to open files with.") }
                appURL = bundle
            case .installed(let bundle):
                appURL = bundle
            }
        } else {
            // A double-click on an executable runs it; only open those in a named app.
            if !isDirectory.boolValue, FileManager.default.isExecutableFile(atPath: path) {
                throw ToolError("\(url.lastPathComponent) is executable, so it is not opened with its default app. Name an app (such as TextEdit) to open it for viewing.")
            }
            guard let handler = NSWorkspace.shared.urlForApplication(toOpen: url) else {
                throw ToolError("No app on this Mac opens \(url.lastPathComponent).")
            }
            appURL = handler
        }
        let bundleID = Bundle(url: appURL)?.bundleIdentifier
        if isTerminal(bundleID: bundleID)
            || NSRunningApplication.runningApplications(withBundleIdentifier: bundleID ?? "").contains(where: { hostProcesses.contains($0.processIdentifier) }) {
            throw ToolError("\(appURL.deletingPathExtension().lastPathComponent) is a terminal or hosts this agent; skfiy does not open files in it.")
        }
        if isDirectory.boolValue, bundleID == "com.apple.finder" {
            return try await openFolderInNewFinderWindow(path)
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        let app: NSRunningApplication
        do {
            app = try await NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: configuration)
        } catch {
            throw ToolError("Could not open \(url.lastPathComponent): \(error.localizedDescription)")
        }
        await Input.pause(max(settleDelay, 0.8))
        let name = app.localizedName ?? appURL.deletingPathExtension().lastPathComponent
        return ToolResult(text: "Opened \(path) in \(name) in the background. Call get_app_state with app \"\(app.bundleIdentifier ?? name)\" to see it.")
    }

    // MARK: - file_dialog

    /// Fills in the Open or Save panel an app is showing, in the background.
    func fileDialog(_ args: Arguments) async throws -> ToolResult {
        let (app, _) = try target(args)
        try checkInputTarget(app)
        let path = try args.absolutePath("path")
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        guard let panel = FilePanel.find(in: appElement) else {
            throw ToolError("\(app.localizedName ?? "The app") is not showing an Open or Save panel. Open one first (its menu item or button), or use open_file / save_document, which need no panel.")
        }
        let overwrite = args.bool("overwrite") ?? false
        let summary = try await panel.choose(URL(fileURLWithPath: path), overwrite: overwrite, in: appElement)
        return try await afterAction(app, summary)
    }

    // MARK: - save_document

    /// Saves through the app's scripting interface: the standard suite's
    /// `save … in`, which needs no Save panel and no front app.
    func saveDocument(_ args: Arguments) async throws -> ToolResult {
        let query = try args.requiredString("app")
        let app = try await runningApp(query, launch: false)
        let path = try args.absolutePath("path")
        var isDirectory: ObjCBool = false
        let parent = (path as NSString).deletingLastPathComponent
        guard FileManager.default.fileExists(atPath: parent, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ToolError("The folder \(parent) does not exist.")
        }
        let overwrite = args.bool("overwrite") ?? false
        if FileManager.default.fileExists(atPath: path), !overwrite {
            throw ToolError("\(path) already exists; pass overwrite: true to replace it, or choose another path.")
        }
        let name = app.localizedName ?? query
        guard let bundleID = app.bundleIdentifier, mayAutomate(bundleID) else {
            return try await saveThroughPanel(app, path: path, overwrite: overwrite,
                why: "skfiy may not send Apple Events to \(name) without a permission prompt (which would pop up over the user's work), so it cannot script the save.")
        }
        let escape = { (text: String) in text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        let document = args.string("document").map { "document \"\(escape($0))\"" } ?? "document 1"
        var error: NSDictionary?
        _ = NSAppleScript(source: "tell application id \"\(bundleID)\" to save \(document) in POSIX file \"\(escape(path))\"")?
            .executeAndReturnError(&error)
        if let error {
            let reason = error[NSAppleScript.errorMessage] as? String ?? "unknown error"
            guard args.string("document") == nil else {
                throw ToolError("\(name) could not save: \(reason). It may not be scriptable, or has no such document.")
            }
            return try await saveThroughPanel(app, path: path, overwrite: overwrite, why: "\(name) could not save through scripting (\(reason)).")
        }
        guard FileManager.default.fileExists(atPath: path) else {
            throw ToolError("\(app.localizedName ?? query) reported no error, but nothing was written to \(path).")
        }
        return try await afterAction(app, "Saved \(args.string("document").map { quote($0, limit: 60) } ?? "the front document") of \(app.localizedName ?? query) to \(path).")
    }

    /// Saves the front document through the app's own Save panel, opened
    /// from a menu item that always shows one: Save As…, Save… for an untitled
    /// document (for a saved one it would overwrite its file), or ⇧⌘S in apps
    /// without Save As… (in document apps that is Duplicate).
    private func saveThroughPanel(_ app: NSRunningApplication, path: String, overwrite: Bool, why: String) async throws -> ToolResult {
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        if FilePanel.find(in: appElement) == nil {
            let saveAs = menuItem(for: try parseKeyChord("cmd+alt+shift+s"), pid: pid)
            let untitled = appElement.element(kAXFocusedWindowAttribute).map { nonEmpty($0.string(kAXDocumentAttribute)) == nil } ?? false
            let candidates = [saveAs, untitled ? menuItem(for: try parseKeyChord("cmd+s"), pid: pid) : nil,
                              saveAs == nil ? menuItem(for: try parseKeyChord("cmd+shift+s"), pid: pid) : nil].compactMap { $0 }
            guard let item = candidates.first(where: \.enabled) else {
                let shortcut = saveAs != nil ? "cmd+alt+shift+s" : (untitled ? "cmd+s" : "cmd+shift+s")
                throw ToolError(candidates.isEmpty
                    ? "\(why) It has no Save menu item that opens a Save panel. Tell the user what is left to do."
                    : "\(why) Its \(quote(candidates[0].title, limit: 40)) menu item is disabled while it is in the background. Open the Save panel with run_in_front (key \"\(shortcut)\", which asks the user), then call file_dialog with this path.")
            }
            try throwIfRefused(guardedAXPerformAction(item.element, kAXPressAction as CFString))
            for _ in 0..<20 where FilePanel.find(in: appElement) == nil {
                await Input.pause(0.15)
            }
            guard FilePanel.find(in: appElement) != nil else {
                throw ToolError("\(why) Pressed its \(quote(item.title, limit: 40)) menu item, but no Save panel appeared.")
            }
        }
        guard let panel = FilePanel.find(in: appElement), panel.isSave else {
            throw ToolError("\(app.localizedName ?? "The app") is showing an Open panel, not a Save panel; finish or cancel it first.")
        }
        let summary = try await panel.choose(URL(fileURLWithPath: path), overwrite: overwrite, in: appElement)
        return try await afterAction(app, summary)
    }

    /// Finder shows a folder opened through Launch Services in one of the
    /// user's existing windows; a window of its own leaves theirs alone.
    private func openFolderInNewFinderWindow(_ path: String) async throws -> ToolResult {
        guard mayAutomate("com.apple.finder") else {
            throw ToolError("Opening a folder this way would take over one of the user's Finder windows, and skfiy is not allowed to script Finder without a permission prompt. In Finder, use New Finder Window (cmd+n) and then Go to Folder… (cmd+shift+g) instead.")
        }
        let escaped = path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        var error: NSDictionary?
        _ = NSAppleScript(source: "tell application \"Finder\" to make new Finder window to (POSIX file \"\(escaped)\" as alias)")?
            .executeAndReturnError(&error)
        if let error {
            throw ToolError("Finder could not open \(path): \(error[NSAppleScript.errorMessage] as? String ?? "unknown error").")
        }
        await Input.pause(settleDelay)
        return ToolResult(text: "Opened \(path) in a new Finder window in the background. Call get_app_state with app \"Finder\" to see it.")
    }
}
