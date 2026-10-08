import AppKit
import ApplicationServices

/// An Open or Save panel an app is showing. Sandboxed apps get these panels
/// from a system service, and keys sent to an app in the background never
/// reach them. Their accessibility tree is the app's, though, so a path is
/// chosen the way clicks would do it: the sidebar location, then one folder
/// per column, then the panel's OK button.
@MainActor
struct FilePanel {
    let element: AXUIElement
    let isSave: Bool

    /// The panel shown by `app`, as a sheet or as a window of its own.
    static func find(in app: AXUIElement) -> FilePanel? {
        var candidates: [AXUIElement] = []
        for window in app.elements(kAXWindowsAttribute) {
            candidates.append(window)
            candidates.append(contentsOf: window.elements(kAXChildrenAttribute).filter { $0.string(kAXRoleAttribute) == kAXSheetRole })
        }
        for candidate in candidates {
            let identifier = candidate.string("AXIdentifier") ?? ""
            if identifier == "save-panel" || identifier == "open-panel" {
                return FilePanel(element: candidate, isSave: identifier == "save-panel")
            }
            if candidate.descendant(limit: 400, where: { $0.string("AXIdentifier") == "OKButton" }) != nil,
               candidate.descendant(limit: 400, where: { $0.string(kAXRoleAttribute) == "AXBrowser" || $0.string("AXIdentifier") == "saveAsNameTextField" }) != nil {
                let isSave = candidate.descendant(limit: 400, where: { $0.string("AXIdentifier") == "saveAsNameTextField" }) != nil
                return FilePanel(element: candidate, isSave: isSave)
            }
        }
        return nil
    }

    private func find(_ identifier: String) -> AXUIElement? {
        element.descendant(limit: 600, where: { $0.string("AXIdentifier") == identifier })
    }

    /// Chooses `url` in an Open panel, or saves to `url` in a Save panel.
    func choose(_ url: URL, overwrite: Bool, in app: AXUIElement) async throws -> String {
        let target = url.standardizedFileURL
        let exists = FileManager.default.fileExists(atPath: target.path)
        if isSave {
            if exists, !overwrite {
                throw ToolError("\(target.path) already exists; pass overwrite: true to replace it, or choose another name.")
            }
            if let disclosure = find("NS_OPEN_SAVE_DISCLOSURE_TRIANGLE"), (disclosure.value(kAXValueAttribute) as? NSNumber)?.intValue == 0 {
                try throwIfRefused(guardedAXPerformAction(disclosure, kAXPressAction as CFString))
                await Input.pause(0.6)
            }
        } else if !exists {
            throw ToolError("Nothing exists at \(target.path).")
        }
        let folder = isSave ? target.deletingLastPathComponent() : target
        // Panels show the real place of a link (/tmp is /private/tmp).
        let resolved = folder.resolvingSymlinksInPath()
        guard let browser = element.descendant(limit: 600, where: { $0.string(kAXRoleAttribute) == "AXBrowser" }) else {
            throw ToolError("The panel does not show its columns (it is in list or icon view, or collapsed), which is the only view skfiy can navigate. The user can switch it to column view once; it is remembered.")
        }
        let (place, row) = try sidebarPlace(for: resolved)
        try throwIfRefused(guardedAXSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue))
        await Input.pause(0.4)

        var current = place
        let components = resolved.pathComponents.dropFirst(place.pathComponents.count)
        for (column, component) in components.enumerated() {
            current.appendPathComponent(component)
            try await select(current, column: column, in: browser)
        }

        if isSave {
            guard let name = find("saveAsNameTextField") else {
                throw ToolError("The Save panel has no name field.")
            }
            try name.set(kAXValueAttribute, target.lastPathComponent as CFString)
            await Input.pause(0.2)
        }
        guard let ok = find("OKButton") else {
            throw ToolError("The panel has no OK button.")
        }
        guard ok.bool(kAXEnabledAttribute) != false else {
            throw ToolError("The panel's \(quote(ok.string(kAXTitleAttribute) ?? "OK", limit: 30)) button is disabled for \(target.lastPathComponent): the app may not accept this kind of file here.")
        }
        let button = ok.string(kAXTitleAttribute) ?? "OK"
        // The panel's elements live in another process and may report an
        // error for an action they did perform; the outcome is checked below.
        try throwIfRefused(guardedAXPerformAction(ok, kAXPressAction as CFString))
        await Input.pause(0.5)
        if isSave, exists, let still = FilePanel.find(in: app) {
            try await still.confirmReplace()
        }
        for _ in 0..<20 where FilePanel.find(in: app) != nil {
            await Input.pause(0.15)
        }
        if FilePanel.find(in: app) != nil {
            throw ToolError("Pressed \(quote(button, limit: 30)), but the panel is still open; call get_app_state to see why (a message in the panel, or a confirmation).")
        }
        if isSave {
            for _ in 0..<20 where !FileManager.default.fileExists(atPath: target.path) {
                await Input.pause(0.15)
            }
            return FileManager.default.fileExists(atPath: target.path)
                ? "Saved to \(target.path) through the app's Save panel (navigated and pressed \(quote(button, limit: 30)) through accessibility)."
                : "Pressed \(quote(button, limit: 30)) in the Save panel for \(target.path); the file is not there yet."
        }
        return "Chose \(target.path) in the app's Open panel and pressed \(quote(button, limit: 30)) (through accessibility)."
    }

    /// The sidebar entry closest to `folder`: a standard folder, the home
    /// folder, or the startup disk.
    private func sidebarPlace(for folder: URL) throws -> (URL, AXUIElement) {
        guard let sidebar = element.descendant(limit: 600, where: {
            $0.string(kAXRoleAttribute) == kAXOutlineRole && $0.ancestor(role: "AXBrowser") == nil
        }) else {
            throw ToolError("The panel's sidebar is hidden, so skfiy cannot navigate it.")
        }
        let rows = sidebar.elements(kAXRowsAttribute)
        let label = { (row: AXUIElement) -> String in
            if let text = row.descendant(limit: 20, where: { nonEmpty($0.string(kAXValueAttribute)) != nil && $0.string(kAXRoleAttribute) == kAXStaticTextRole }) {
                return text.string(kAXValueAttribute) ?? ""
            }
            return row.string(kAXTitleAttribute) ?? row.string(kAXDescriptionAttribute) ?? ""
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let places = ["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"].map { home.appendingPathComponent($0) }
            + [URL(fileURLWithPath: "/Applications"), home, URL(fileURLWithPath: "/")]
        let path = folder.path
        for place in places.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) {
            guard place.path == "/" || path == place.path || path.hasPrefix(place.path + "/") else { continue }
            let name = FileManager.default.displayName(atPath: place.path)
            if let row = rows.first(where: { label($0) == name }) {
                return (place, row)
            }
        }
        throw ToolError("None of the panel's sidebar entries leads to \(path).")
    }

    /// Selects `url` in column `column` of the browser, waiting for the column
    /// to load and scrolling it when the item is further down.
    private func select(_ url: URL, column: Int, in browser: AXUIElement) async throws {
        let names = Set([FileManager.default.displayName(atPath: url.path), url.lastPathComponent])
        let hidden = url.lastPathComponent.hasPrefix(".") || (try? url.resourceValues(forKeys: [.isHiddenKey]).isHidden) == true
        if hidden {
            throw ToolError("\(url.path) is hidden in file panels (like /tmp or ~/Library), so skfiy cannot reach it there. Put the file in a visible folder such as Downloads first.")
        }
        var scrolled = 0
        for _ in 0..<60 {
            let lists = browser.descendants(limit: 3_000, where: { $0.string(kAXRoleAttribute) == kAXListRole })
            if column < lists.count {
                let list = lists[column]
                if let item = list.elements(kAXChildrenAttribute).first(where: { item in
                    item.descendant(limit: 10, where: { names.contains($0.string(kAXValueAttribute) ?? "") }) != nil
                }) {
                    // The list reports an error for files, yet selects them.
                    try throwIfRefused(guardedAXSetAttributeValue(list, kAXSelectedChildrenAttribute as CFString, [item] as CFArray))
                    await Input.pause(0.35)
                    return
                }
                // Long folders: bring later items into view.
                if scrolled < 40, let area = list.element(kAXParentAttribute),
                   guardedAXPerformAction(area, "AXScrollDownByPage" as CFString) == .success {
                    scrolled += 1
                    await Input.pause(0.1)
                    continue
                }
            }
            await Input.pause(0.1)
        }
        throw ToolError("\(url.lastPathComponent) did not show up in the panel's column for \(url.deletingLastPathComponent().path).")
    }

    /// Answers "already exists. Do you want to replace it?" (a sheet on the
    /// panel) with its first button, Replace; only called when the caller
    /// allowed overwriting.
    private func confirmReplace() async throws {
        guard let alert = element.descendant(limit: 400, where: {
            $0.string(kAXRoleAttribute) == kAXSheetRole && !CFEqual($0, element)
        }) else {
            return
        }
        let buttons = alert.descendants(limit: 60, where: { $0.string(kAXRoleAttribute) == kAXButtonRole })
        guard let replace = buttons.first(where: { $0.string("AXIdentifier") == "action-button-1" }) else {
            throw ToolError("The Save panel asked something skfiy does not recognize; call get_app_state to see it.")
        }
        try throwIfRefused(guardedAXPerformAction(replace, kAXPressAction as CFString))
        await Input.pause(0.4)
    }
}
