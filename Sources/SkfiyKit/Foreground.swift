import AppKit
import ApplicationServices
import Foundation

/// What involves the user's front app, their clipboard or the user themselves:
/// run_in_front, skfiy's own clipboard for cmd+c/x/v, read_clipboard and
/// hand_over, and the menu items behind keyboard shortcuts.
extension ComputerUse {
    // MARK: - run_in_front

    /// The one exception to working in the background: a shortcut that only
    /// works in the frontmost app, run after the user approves it in the
    /// client, in a quiet moment, with their front app and top window put back.
    func runInFront(_ args: Arguments) async throws -> ToolResult {
        let query = try args.requiredString("app")
        let app = try await runningApp(query, launch: false)
        try checkInputTarget(app)
        let pid = app.processIdentifier
        let name = app.localizedName ?? query
        let request = try FrontRequest.parse(args)
        let appSession = { () throws -> AppSession in
            guard let session = self.sessions[pid] else { throw ToolError("No state for \(name) yet. Call get_app_state first.") }
            return session
        }
        var menuElement: AXUIElement?
        var clickPoint: CGPoint?
        let action: String
        switch request {
        case .key(let key):
            action = "press \(key)"
        case .menu(let index, let path):
            let element = try appSession().element(index)
            menuElement = element
            action = "choose \(quote(path.joined(separator: " › "), limit: 80)) from the menu of \(describe(element))"
        case .click(let index):
            let session = try appSession()
            if let index {
                let element = try session.element(index)
                clickPoint = try await visibleCenter(of: element, session: session)
                action = "click [\(index)] \(describe(element))"
            } else {
                clickPoint = try screenPoint(args, "x", "y", session: session)
                action = "click at (\(formatNumber(try args.double("x") ?? 0)), \(formatNumber(try args.double("y") ?? 0)))"
            }
            try checkPointerTarget(app, allowRemote: true)
        }
        let chord = try request.key.map(parseKeyChord)
        // A RustDesk remote session passes what it gets to the remote computer.
        let appElementNow = AXUIElementCreateApplication(pid)
        let remoteWindow: AXUIElement? = {
            if let clickPoint, let id = pointerWindow(pid: pid, at: clickPoint), let window = axWindow(id, pid: pid) { return window }
            return appElementNow.element(kAXFocusedWindowAttribute)
        }()
        let remoteTitle = remoteWindow.flatMap { window -> String? in
            let title = window.string(kAXTitleAttribute) ?? ""
            return RemoteSurface.isRemoteSession(bundleID: app.bundleIdentifier, title: title) ? title : nil
        }
        // cmd+c, cmd+x and cmd+v work on skfiy's clipboard here too (not in a
        // remote session, where they are the remote computer's).
        let clipboardKey = remoteTitle != nil ? nil : chord.flatMap { chord in chord.modifiers == .command ? chord.baseCharacter.flatMap { "cxv".contains($0) ? $0 : nil } : nil }
        if clipboardKey == "v", clipboard == nil {
            throw ToolError("skfiy's clipboard is empty, so there is nothing to paste. Copy with cmd+c first, or take what the user copied with read_clipboard.")
        }
        guard let userApp = frontmostProcessID() else {
            throw ToolError("Could not tell which app is in front.")
        }
        guard userApp != pid else {
            throw ToolError("\(name) is already the front app; use press_key.")
        }
        guard let askUser else {
            throw ToolError("skfiy can only bring \(name) forward after the user approves it, and this client cannot ask them. Tell the user what needs doing instead.")
        }
        let user = NSRunningApplication(processIdentifier: userApp)?.localizedName ?? "your app"
        let reason = args.string("reason").map { " (\($0))" } ?? ""
        var message = "skfiy wants to bring \(name) to the front for about a second to \(action)\(reason). \(user) and your window order are restored right after; it waits until you stop typing."
        if let remoteTitle {
            message += " This goes to RustDesk's remote session \(quote(remoteTitle, limit: 80)), so the remote computer receives it; RustDesk may keep your keyboard for the remote computer until you click elsewhere."
        }
        switch await askUser(message) {
        case nil:
            throw ToolError("skfiy can only bring \(name) forward after the user approves it, and this client cannot ask them (or no answer came). Tell the user what needs doing instead.")
        case false?:
            throw ToolError("The user declined bringing \(name) to the front. Do not ask again for the same thing; tell them what is left to do.")
        case true?:
            break
        }
        // A quiet moment: no typing or clicking for a second, within 15 s.
        var quiet = false
        for _ in 0..<60 {
            if EmergencyStop.isStopped { throw ToolError(EmergencyStop.refusal) }
            if Input.userIdleSeconds() >= 1 { quiet = true; break }
            await Input.pause(0.25)
        }
        guard quiet else {
            throw ToolError("The user kept typing or clicking, so \(name) was not brought forward. Try again later.")
        }
        let userTop = topWindow().flatMap { $0.pid == userApp ? $0.id : nil }
        let front = { SkyLight.frontProcessID() ?? frontmostProcessID() }
        // Whatever happens from here on, the user's app gets the front back.
        func restore() async {
            guard let previous = NSRunningApplication(processIdentifier: userApp), !previous.isTerminated else { return }
            for _ in 0..<3 where front() != userApp {
                _ = try? AXUIElementCreateApplication(userApp).set(kAXFrontmostAttribute, kCFBooleanTrue)
                previous.activate(options: [])
                for _ in 0..<10 where front() != userApp {
                    await Input.pause(0.05)
                }
            }
            if let userTop, topWindow()?.id != userTop,
               let window = AXUIElementCreateApplication(userApp).elements(kAXWindowsAttribute).first(where: { windowID(of: $0) == userTop }) {
                _ = guardedAXPerformAction(window, kAXRaiseAction as CFString)
            }
        }
        // Since macOS 14 a background process's activate() may be ignored;
        // the accessibility frontmost attribute is honored. Activation can take
        // a moment to land.
        let appElement = AXUIElementCreateApplication(pid)
        // Guards of this and every other skfiy process leave it in front meanwhile.
        FrontGrant.grant(pid, seconds: 20)
        defer { FrontGrant.revoke() }
        _ = try? appElement.set(kAXFrontmostAttribute, kCFBooleanTrue)
        app.activate(options: [])
        for _ in 0..<40 where front() != pid {
            await Input.pause(0.05)
        }
        let system = SystemClipboard()
        var saved: ClipboardContents?
        var lent = 0
        var how: String
        // Anything that fails from here on puts the user's clipboard back (when
        // it was lent and nothing changed it since) and gives them the front.
        do {
            guard front() == pid else {
                throw ToolError("\(name) did not come to the front, so nothing was pressed.")
            }
            // Make sure the shortcut lands in the app's document window.
            if let window = appElement.element(kAXFocusedWindowAttribute) ?? appElement.elements(kAXWindowsAttribute).first {
                _ = try? window.set(kAXMainAttribute, kCFBooleanTrue)
            }
            // Let the switch settle: the window becomes key and menus revalidate.
            await Input.pause(0.3)
            saved = clipboardKey.map { _ in system.read() }
            if clipboardKey == "v", let clipboard {
                system.write(clipboard)
            }
            lent = system.changeCount
            if let clickPoint {
                guard front() == pid, let window = pointerWindow(pid: pid, at: clickPoint) else {
                    throw ToolError("\(name) lost the front, or has no window at that point, so nothing was clicked.")
                }
                // Posted to the app, now active, so the user's cursor stays where it is.
                guard await Input.click(at: clickPoint, pid: pid, windowID: window, button: .left, count: 1, modifiers: [], chromium: isChromium(app)) else {
                    throw ToolError(axMutationRefusal() ?? "The click could not be sent, so nothing was clicked.")
                }
                how = "clicked there"
            } else if let menuElement, case .menu(_, let path) = request {
                how = try await chooseFromMenu(of: menuElement, path: path, pid: pid)
            } else if let chord, let item = menuItem(for: chord, pid: pid), item.enabled {
                if guardedAXPerformAction(item.element, kAXPressAction as CFString) == .failure, let refusal = axMutationRefusal() {
                    throw ToolError(refusal)
                }
                how = "ran the menu item \(quote(item.title, limit: 60))"
            } else if let chord, front() == pid {
                // It is the front app now, so a keystroke like a real one reaches it.
                await Input.pressToFrontApp(chord)
                how = "pressed \(request.key ?? "")"
            } else {
                throw ToolError("\(name) lost the front before the shortcut, so nothing was pressed.")
            }
        } catch {
            if let saved, system.changeCount == lent { system.write(saved) }
            await restore()
            throw error
        }
        await Input.pause(0.3)
        if let saved, let clipboardKey {
            if clipboardKey == "v" {
                if system.changeCount == lent { system.write(saved) }
                how += " on skfiy's clipboard (the user's clipboard was lent for that moment and put back)"
            } else if await system.waitForChange(from: lent, seconds: 1) {
                await Input.pause(0.1)
                let copied = system.read()
                system.write(saved)
                clipboard = copied
                how += ", keeping what it copied (\(copied.summary)) in skfiy's clipboard and putting the user's clipboard back"
            } else {
                how += ", but nothing was copied"
            }
        }
        await restore()
        let restored = front() == userApp ? "gave the front back to \(user)" : "could not give the front back to \(user)"
        return try await afterAction(app, "With the user's approval, brought \(name) forward for a moment, \(how), and \(restored).")
    }

    /// Opens the context menu of `element` (or the menu of a menu button) in
    /// the front app and presses the item at `path`, e.g. ["Share", "Mail"].
    private func chooseFromMenu(of element: AXUIElement, path: [String], pid: pid_t) async throws -> String {
        let appElement = AXUIElementCreateApplication(pid)
        let opener = ["AXMenuButton", "AXPopUpButton"].contains(element.string(kAXRoleAttribute) ?? "") ? kAXPressAction : kAXShowMenuAction
        let status = guardedAXPerformAction(element, opener as CFString)
        try throwIfRefused(status)
        guard status == .success || status == .cannotComplete else {
            throw ToolError("\(describe(element)) has no menu to open.")
        }
        // Context menus hang off the application element, a button's menu off the button.
        var menu: AXUIElement?
        for _ in 0..<20 {
            let open = { (parent: AXUIElement) in
                parent.elements(kAXChildrenAttribute).first { $0.string(kAXRoleAttribute) == kAXMenuRole && self.isOpenMenu($0) }
            }
            menu = open(appElement) ?? open(element)
            if menu != nil { break }
            await Input.pause(0.05)
        }
        guard let menu else {
            throw ToolError("No menu opened for \(describe(element)).")
        }
        let close = { _ = guardedAXPerformAction(menu, kAXCancelAction as CFString) }
        var current = menu
        for (depth, title) in path.enumerated() {
            let items = current.elements(kAXChildrenAttribute)
            let titles = items.map { $0.string(kAXTitleAttribute) ?? "" }
            let wanted = title.lowercased()
            guard let index = titles.firstIndex(where: { $0.lowercased() == wanted })
                    ?? titles.firstIndex(where: { $0.lowercased().contains(wanted) }) else {
                close()
                let listing = titles.filter { !$0.isEmpty }.prefix(40).map { quote($0, limit: 40) }.joined(separator: ", ")
                throw ToolError("The menu has no item \(quote(title, limit: 60)), so nothing was chosen. Its items: \(listing).")
            }
            let item = items[index]
            if depth == path.count - 1 {
                guard item.bool(kAXEnabledAttribute) != false else {
                    close()
                    throw ToolError("\(quote(titles[index], limit: 60)) is disabled in that menu, so nothing was chosen.")
                }
                try throwIfRefused(guardedAXPerformAction(item, kAXPressAction as CFString))
                return "chose \(quote(path.dropLast().map { $0 + " › " }.joined() + titles[index], limit: 80)) from the menu of \(describe(element))"
            }
            guard let submenu = item.elements(kAXChildrenAttribute).first(where: { $0.string(kAXRoleAttribute) == kAXMenuRole }) else {
                close()
                throw ToolError("\(quote(titles[index], limit: 60)) has no submenu, so nothing was chosen.")
            }
            current = submenu
        }
        close()
        throw ToolError("No menu item was given.")
    }

    /// cmd+c, cmd+x and cmd+v work on skfiy's own clipboard, in any app. Text
    /// is copied and pasted through accessibility, without the system
    /// clipboard. Anything else (files, cells, images) goes through the app's
    /// own Copy, Cut or Paste command, with the user's clipboard lent for that
    /// moment and put straight back.
    /// `text` is the field to copy from or paste into; without one (or with
    /// rich contents) the app's own menu command is used, unless `menu` is
    /// false (it would act on the app's key window, not the one meant).
    func clipboardShortcut(_ chord: KeyChord, pid: pid_t, text: AXUIElement?, menu: Bool = true) async throws -> String? {
        guard chord.modifiers == .command, let character = chord.baseCharacter, "cxv".contains(character) else { return nil }
        switch character {
        case "c", "x":
            guard let text else {
                guard menu else { return nil }
                return try await copyThroughSystemClipboard(chord, pid: pid, cut: character == "x")
            }
            guard let selected = text.string(kAXSelectedTextAttribute), !selected.isEmpty else {
                throw ToolError("Nothing is selected in the focused field; select text first (select_text).")
            }
            clipboard = .text(selected)
            if character == "x" {
                try text.set(kAXSelectedTextAttribute, "" as CFString)
            }
            let verb = character == "x" ? "cut" : "copied"
            return "\(verb) \(quote(selected, limit: 60)) to skfiy's own clipboard (the user's clipboard is untouched); cmd+v pastes it in any app"
        default:
            guard let clipboard else {
                throw ToolError("skfiy's clipboard is empty. Copy with cmd+c first, type with type_text, or take what the user copied with read_clipboard (they are asked).")
            }
            if let text, !clipboard.isRich, let string = clipboard.text {
                try text.set(kAXSelectedTextAttribute, string as CFString)
                return "pasted \(quote(string, limit: 60)) from skfiy's own clipboard (accessibility; the user's clipboard is untouched)"
            }
            guard menu else { return nil }
            return try await pasteThroughSystemClipboard(clipboard, chord, pid: pid)
        }
    }

    /// Runs the app's Copy or Cut command and keeps what it copied, putting
    /// the user's clipboard back right after.
    private func copyThroughSystemClipboard(_ chord: KeyChord, pid: pid_t, cut: Bool) async throws -> String {
        let key = cut ? "cmd+x" : "cmd+c"
        guard let item = menuItem(for: chord, pid: pid) else {
            throw ToolError("The focused element is not text, and the app has no menu command for \(key) to copy it with.")
        }
        guard item.enabled else {
            throw ToolError("\(quote(item.title, limit: 30)) is disabled while the app is in the background (nothing selected, or the command only works in the front app). run_in_front with key \"\(key)\" runs it with the user's approval; skfiy then keeps what was copied and puts the user's clipboard back.")
        }
        let system = SystemClipboard()
        let saved = system.read()
        let before = system.changeCount
        try throwIfRefused(guardedAXPerformAction(item.element, kAXPressAction as CFString))
        guard await system.waitForChange(from: before) else {
            throw ToolError("Pressed \(quote(item.title, limit: 30)), but the app copied nothing (is something selected?). The user's clipboard was not touched.")
        }
        await Input.pause(0.15)  // the app may still be adding representations
        let copied = system.read()
        system.write(saved)
        clipboard = copied
        return "\(cut ? "cut" : "copied") \(copied.summary) into skfiy's own clipboard with the app's \(quote(item.title, limit: 30)) command; the user's clipboard was lent for that moment and put back. cmd+v pastes it in any app"
    }

    /// Runs the app's Paste command on skfiy's clipboard, with the user's
    /// clipboard lent for that moment.
    private func pasteThroughSystemClipboard(_ contents: ClipboardContents, _ chord: KeyChord, pid: pid_t) async throws -> String {
        guard let item = menuItem(for: chord, pid: pid) else {
            throw ToolError("skfiy's clipboard holds \(contents.summary), which only the app's Paste command can paste, and the app has none for cmd+v.")
        }
        guard item.enabled else {
            throw ToolError("\(quote(item.title, limit: 30)) is disabled while the app is in the background. run_in_front with key \"cmd+v\" pastes skfiy's clipboard with the user's approval.")
        }
        let system = SystemClipboard()
        let saved = system.read()
        system.write(contents)
        let lent = system.changeCount
        if guardedAXPerformAction(item.element, kAXPressAction as CFString) == .failure, let refusal = axMutationRefusal() {
            if system.changeCount == lent { system.write(saved) }
            throw ToolError(refusal)
        }
        await Input.pause(0.5)  // the app reads the clipboard while pasting
        let putBack = system.changeCount == lent
        if putBack {
            system.write(saved)
        }
        return "pasted \(contents.summary) from skfiy's own clipboard with the app's \(quote(item.title, limit: 30)) command; "
            + (putBack ? "the user's clipboard was lent for that moment and put back" : "the clipboard changed meanwhile (the user may have copied something), so it was left as it is")
    }

    // MARK: - hand_over

    /// Hands a step to the user (signing in, a code, a confirmation) and
    /// waits until they say it is done, then optionally checks the app.
    func handOver(_ args: Arguments) async throws -> ToolResult {
        let message = try args.requiredText("message").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            throw ToolError("\"message\" must say what the user should do.")
        }
        guard let waitForUser else {
            throw ToolError("This client cannot ask the user. Tell them in the conversation what to do, and wait for their reply.")
        }
        switch await waitForUser("Your turn: \(message)\nConfirm when it is done, or decline if you cannot or do not want to.") {
        case nil:
            throw ToolError("No answer came from the user (or this client cannot ask). Tell them in the conversation what is left to do.")
        case false?:
            throw ToolError("The user did not do it. Do not try to do it yourself; stop and tell them what is left.")
        case true?:
            break
        }
        guard let app = args.string("app"), !app.isEmpty else {
            return ToolResult(text: "The user says it is done.")
        }
        if let expect = args.string("expect"), !expect.isEmpty {
            var result = try await waitFor(Arguments(["app": app, "text": expect, "timeout": 10]))
            result.text = "The user says it is done. " + result.text
            return result
        }
        var state = try await getAppState(Arguments(["app": app]))
        state.text = "The user says it is done. The app now:\n" + state.text
        return state
    }

    // MARK: - read_clipboard

    /// Takes what the user copied into skfiy's clipboard, once they approve.
    func readClipboard(_ args: Arguments) async throws -> ToolResult {
        let contents = SystemClipboard().read()
        guard !contents.isEmpty else {
            throw ToolError("The user's clipboard is empty.")
        }
        guard !contents.isConcealed else {
            throw ToolError("The user's clipboard holds something their password manager marked as secret; skfiy does not read it.")
        }
        guard let askUser else {
            throw ToolError("Reading the user's clipboard needs their approval, and this client cannot ask them. Ask the user to paste it into the conversation instead.")
        }
        let reason = args.string("reason").map { " (\($0))" } ?? ""
        switch await askUser("skfiy wants to use what you copied (\(contents.summary))\(reason).") {
        case nil:
            throw ToolError("Reading the user's clipboard needs their approval, and this client cannot ask them (or no answer came). Ask the user to paste it into the conversation instead.")
        case false?:
            throw ToolError("The user declined sharing their clipboard. Do not ask again.")
        case true?:
            break
        }
        clipboard = contents
        var text = "With the user's approval, took what they copied (\(contents.summary)) into skfiy's own clipboard; cmd+v pastes it in any app."
        if let string = contents.text {
            text += "\nIts text:\n" + String(string.prefix(20_000))
        }
        return ToolResult(text: text)
    }

    /// Finds the menu item whose shortcut is `chord`, preferring enabled ones.
    func menuItem(for chord: KeyChord, pid: pid_t) -> (element: AXUIElement, title: String, enabled: Bool)? {
        guard case .code(let code) = chord.key,
              let menuBar = AXUIElementCreateApplication(pid).element(kAXMenuBarAttribute) else {
            return nil
        }
        let character = chord.baseCharacter
        var wantedModifiers = 0
        if chord.modifiers.contains(.shift) { wantedModifiers |= 1 }
        if chord.modifiers.contains(.option) { wantedModifiers |= 2 }
        if chord.modifiers.contains(.control) { wantedModifiers |= 4 }
        if !chord.modifiers.contains(.command) { wantedModifiers |= 8 }

        var disabled: (AXUIElement, String, Bool)?
        func search(_ menu: AXUIElement, depth: Int) -> (AXUIElement, String, Bool)? {
            for item in menu.elements(kAXChildrenAttribute) {
                let values = item.multipleValues([
                    kAXTitleAttribute, kAXEnabledAttribute, kAXMenuItemCmdCharAttribute,
                    kAXMenuItemCmdModifiersAttribute, kAXMenuItemCmdVirtualKeyAttribute, kAXChildrenAttribute
                ])
                let modifiers = (values[kAXMenuItemCmdModifiersAttribute] as? NSNumber)?.intValue ?? 0
                let itemChar = values[kAXMenuItemCmdCharAttribute].flatMap(axString)?.lowercased()
                let itemKey = (values[kAXMenuItemCmdVirtualKeyAttribute] as? NSNumber)?.intValue
                let keyMatches = (itemChar != nil && !itemChar!.isEmpty && itemChar == character)
                    || (itemChar == nil || itemChar!.isEmpty) && itemKey == Int(code)
                if keyMatches, modifiers == wantedModifiers {
                    let enabled = (values[kAXEnabledAttribute] as? NSNumber)?.boolValue != false
                    let title = values[kAXTitleAttribute].flatMap(axString) ?? ""
                    if enabled {
                        return (item, title, true)
                    }
                    disabled = disabled ?? (item, title, false)
                }
                if depth < 3, let submenu = ((values[kAXChildrenAttribute] as? [AXUIElement]) ?? []).first,
                   let found = search(submenu, depth: depth + 1) {
                    return found
                }
            }
            return nil
        }
        for barItem in menuBar.elements(kAXChildrenAttribute) {
            if let menu = barItem.elements(kAXChildrenAttribute).first, let found = search(menu, depth: 0) {
                return found
            }
        }
        return disabled
    }
}

/// What run_in_front is asked to do: press a key, choose an item from an
/// element's menu, or click an element (or x/y without one).
enum FrontRequest: Equatable {
    case key(String)
    case menu(index: Int, path: [String])
    case click(index: Int?)

    var key: String? {
        if case .key(let key) = self { return key }
        return nil
    }

    /// One of: key; element_index with menu_item ("Share > Mail"); element_index or x/y alone.
    static func parse(_ args: Arguments) throws -> FrontRequest {
        let key = args.string("key")
        let path = (args.string("menu_item") ?? "").components(separatedBy: CharacterSet(charactersIn: ">›"))
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let index = try args.elementIndex()
        let point = args.values["x"] != nil || args.values["y"] != nil
        if !path.isEmpty, key == nil, !point, let index { return .menu(index: index, path: path) }
        if path.isEmpty, let key, index == nil, !point { return .key(key) }
        if path.isEmpty, key == nil, index != nil || point { return .click(index: index) }
        throw ToolError("Pass one of: key; element_index with menu_item; or element_index or x/y alone to click.")
    }
}
