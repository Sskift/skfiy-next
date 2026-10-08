import AppKit
import ApplicationServices
import Foundation

/// click, perform_secondary_action, set_value, scroll and drag, with the
/// helpers they share: accessibility first, then pointer events posted to the
/// app; brief focus only with the user's approval.
extension ComputerUse {
    // MARK: - Actions
    //
    // Nothing here activates the target, raises a window, or moves the user's
    // cursor. Clipboard shortcuts that need the app's own Copy or Paste lend
    // it the user's clipboard for a moment and put it straight back.
    // Accessibility is tried first; pointer and keyboard events are posted to
    // the target process only.

    static let pressRoles: Set<String> = [
        "AXButton", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle", "AXLink", "AXDockItem",
        "AXTab", "AXSegment"
    ]
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    static let menuAlternatives = "Its commands are usually in the menu bar (click a menu bar item to list its items without opening it) or have keyboard shortcuts; to open a file, use open_file. A command found only in this menu can be run with run_in_front, element_index and menu_item, which asks the user first."
    static let backgroundMenuRefusal = "A context menu of a background app would be drawn over the user's screen, so skfiy does not open one. " + menuAlternatives

    func click(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        let buttonName = args.string("mouse_button") ?? "left"
        guard let button = MouseButton(rawValue: buttonName.lowercased()) else {
            throw ToolError("mouse_button must be left, right, or middle.")
        }
        let count = try args.int("click_count") ?? 1
        guard (1...3).contains(count) else {
            throw ToolError("click_count must be 1, 2, or 3.")
        }
        let modifiers = try parseModifierList(args.string("modifiers"))
        let pid = app.processIdentifier

        let element: AXUIElement?
        let point: CGPoint?
        let described: String
        if let index = try args.elementIndex() {
            let indexed = try session.element(index)
            element = indexed
            point = nil
            described = "[\(index)] \(describe(indexed))"
        } else {
            let screen = try screenPoint(args, "x", "y", session: session)
            element = hitTest(pid: pid, at: screen)
            point = screen
            described = "(\(formatNumber(try args.double("x") ?? 0)), \(formatNumber(try args.double("y") ?? 0)))"
                + (element.map { " on \(describe($0))" } ?? "")
        }

        // A status item's menu would open over the user's screen; its items
        // can only be listed when the app built the menu in advance.
        if let element, element.string(kAXRoleAttribute) == "AXMenuBarItem",
           element.element(kAXParentAttribute)?.string(kAXRoleAttribute) != kAXMenuBarRole
            || element.string(kAXSubroleAttribute) == "AXMenuExtra",
           element.elements(kAXChildrenAttribute).first?.string(kAXRoleAttribute) != kAXMenuRole {
            throw ToolError("\(described) is a status item in the menu bar; clicking it would open its menu over the user's screen, and the app does not expose the menu in advance, so it was not clicked. Use the app's own windows or menu bar instead.")
        }
        let inBackground = frontmostProcessID() != pid
        // Opening a background app's menu would draw it over the user's screen;
        // list the items instead, ready to be pressed by index.
        if let element, button == .left, count == 1, inBackground,
           ["AXMenuBarItem", "AXMenuItem"].contains(element.string(kAXRoleAttribute) ?? ""),
           let menu = element.elements(kAXChildrenAttribute).first,
           menu.string(kAXRoleAttribute) == kAXMenuRole {
            var lines: [String] = []
            listMenu(menu, pid: pid, depth: 1, lines: &lines)
            let title = element.string(kAXTitleAttribute) ?? ""
            let intro = "Menu \(quote(title, limit: 60)) of \(app.localizedName ?? "the app") — listed, not opened, so nothing appeared on screen. Click an item's index to run it. Enabled/checked states are as of when the app was last in front; items marked disabled cannot run while it is in the background."
            return ToolResult(text: ([intro] + lines).joined(separator: "\n"))
        }

        if let element, button == .left, count == 1, inBackground,
           element.string(kAXRoleAttribute) == "AXPopUpButton" {
            let options = popupOptions(element)
            let current = element.string(kAXValueAttribute).map { " Current value: \(quote($0, limit: 60))." } ?? ""
            let listing = options.isEmpty ? "" : " Options: " + options.map { quote($0.title, limit: 40) }.joined(separator: ", ") + "."
            return ToolResult(text: "\(described) is a pop-up menu; opening it would draw over the user's screen, so it was not opened.\(current)\(listing) Choose an option with set_value(element_index, value: \"<option text>\").")
        }
        if inBackground {
            if button == .right || modifiers.contains(.control) && button == .left {
                throw ToolError(Self.backgroundMenuRefusal)
            }
            if let element, button == .left, element.string(kAXRoleAttribute) == "AXMenuButton" {
                throw ToolError("\(described) opens a menu, and opening it in a background app would draw the menu over the user's screen, so it was not pressed. \(Self.menuAlternatives)")
            }
        }
        if let element, element.string(kAXRoleAttribute) == "AXMenuItem", element.bool(kAXEnabledAttribute) == false {
            throw ToolError("That menu item is disabled. A background app keeps its menus as they were when it was last in front, so items that act on the current document or selection stay disabled; use the equivalent control in the window or a keyboard shortcut instead.")
        }
        // x/y in a remote session: not even an accessibility press on what a hit test finds there.
        if let point, let remote = remoteSessionTitle(app, receiver: pointerWindow(pid: pid, at: point), point: point, aimed: true) {
            throw ToolError(RemoteSurface.refusal(remote, what: "a click"))
        }
        // The agent cursor goes there first, so the user sees where it acts.
        if let shown = point ?? element?.frame.map({ CGPoint(x: $0.midX, y: $0.midY) }) {
            await VirtualCursor.move(to: shown, pid: pid, window: pointerWindow(pid: pid, at: shown, element: point == nil ? element : nil))
        }
        if let element, let how = try await accessibilityClick(element, at: point, button: button, count: count, modifiers: modifiers, exact: point == nil) {
            VirtualCursor.show(.click(count: count, button: button), pid: pid)
            return try await afterAction(app, "Clicked \(described): \(how).")
        }
        let target: CGPoint
        if let point {
            target = point
        } else if let element {
            target = try await visibleCenter(of: element, session: session)
        } else {
            throw ToolError("Nothing to click.")
        }
        // Checked before the cursor moves there: nothing happens on a refusal.
        let indexed = point == nil ? element : nil
        try checkPointerTarget(app, window: indexed.flatMap(containingWindow(of:)))
        if point == nil { await VirtualCursor.move(to: target, pid: pid) }
        let how = try await pointerClick(app, at: target, element: indexed, button: button, count: count, modifiers: modifiers,
                                         focus: args.bool("focus") ?? false)
        VirtualCursor.show(.click(count: count, button: button), pid: pid)
        return try await afterAction(app, "Clicked \(described): \(how).")
    }

    /// Performs a click semantically. Returns what was done, or nil when only a
    /// pointer event can do it. `exact` means the element was chosen by index
    /// rather than hit-tested, so its ancestors are not candidates. A refused
    /// action throws: no other way of clicking is tried then.
    private func accessibilityClick(
        _ element: AXUIElement,
        at point: CGPoint?,
        button: MouseButton,
        count: Int,
        modifiers: Modifiers,
        exact: Bool
    ) async throws -> String? {
        guard modifiers.isEmpty else { return nil }
        let role = element.string(kAXRoleAttribute) ?? ""
        switch (button, count) {
        case (.left, 1):
            // A file name in a list row (Finder) is a text field: a click on a
            // row that is not selected selects it, as a real click does.
            if !exact, Self.textRoles.contains(role), let row = ancestor(of: element, levels: 3, where: {
                $0.string(kAXRoleAttribute) == "AXRow" && $0.isSettable(kAXSelectedAttribute)
            }), row.bool(kAXSelectedAttribute) == false {
                let status = guardedAXSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                try throwIfRefused(status)
                if status == .success { return "selected the row (accessibility)" }
            }
            if Self.textRoles.contains(role) {
                try throwIfRefused(guardedAXSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue))
                if let pid = element.pid { typingTargets[pid] = element }
                // A click lands the caret under the pointer; by index, at the end.
                let length = (element.string(kAXValueAttribute) as NSString?)?.length ?? 0
                let location = point.flatMap { textIndex(in: element, at: $0) } ?? length
                let returned = workInWindow(of: element)
                let keyboard = await makeFieldWindowKey(element)
                setCaret(element, location)
                return "focused the field and placed the caret (accessibility)" + keyboard + returned
            }
            // In web content AXPress only dispatches a click event: plain text or a
            // canvas would not take focus the way a real click does, so those
            // get a real (background) mouse click instead.
            if let pressable = ancestor(of: element, levels: exact ? 0 : 3, where: {
                Self.pressRoles.contains($0.string(kAXRoleAttribute) ?? "") && $0.actionNames().contains(kAXPressAction)
            }) ?? (element.actionNames().contains(kAXPressAction) && !isInWebContent(element) ? element : nil) {
                let name = describe(pressable)
                let status = guardedAXPerformAction(pressable, kAXPressAction as CFString)
                try throwIfRefused(status)
                // Menus and pop-ups run a tracking loop, so AXPress often times out while one opens.
                if status == .success || status == .cannotComplete {
                    return "pressed \(name) (accessibility)"
                }
            }
            if let row = ancestor(of: element, levels: exact ? 0 : 3, where: {
                $0.string(kAXRoleAttribute) == "AXRow" && $0.isSettable(kAXSelectedAttribute)
            }) {
                let status = guardedAXSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                try throwIfRefused(status)
                if status == .success { return "selected the row (accessibility)" }
            }
        case (.left, 2):
            if let openable = ancestor(of: element, levels: exact ? 1 : 3, where: { $0.actionNames().contains("AXOpen") }) {
                let name = describe(openable)
                let status = guardedAXPerformAction(openable, "AXOpen" as CFString)
                try throwIfRefused(status)
                if status == .success {
                    return "opened \(name) (accessibility)"
                }
            }
        case (.right, 1):
            if let target = ancestor(of: element, levels: exact ? 0 : 2, where: { $0.actionNames().contains(kAXShowMenuAction) }) {
                let name = describe(target)
                let status = guardedAXPerformAction(target, kAXShowMenuAction as CFString)
                try throwIfRefused(status)
                if status == .success || status == .cannotComplete {
                    return "opened the context menu of \(name) (accessibility)"
                }
            }
        default:
            break
        }
        return nil
    }

    /// A real mouse click posted to the process (never through the user's cursor).
    private func pointerClick(
        _ app: NSRunningApplication,
        at point: CGPoint,
        element: AXUIElement? = nil,
        button: MouseButton,
        count: Int,
        modifiers: Modifiers,
        focus: Bool
    ) async throws -> String {
        let pid = app.processIdentifier
        guard let window = pointerWindow(pid: pid, at: point, element: element) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at that point.")
        }
        let windowElement = element.flatMap(containingWindow(of:)) ?? axWindow(window, pid: pid)
        try checkPointerTarget(app, window: windowElement, receiver: window, point: point, aimed: element == nil)
        let chromium = isChromium(app)
        let flutter = isFlutter(app)
        var note = ""
        if flutter, frontmostProcessID() != pid {
            // Measured with RustDesk: Flutter views ignore every kind of
            // background click; brief focus was not tried (it defocuses the user).
            guard await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers) else {
                throw ToolError(axMutationRefusal() ?? "The click could not be sent, so nothing was clicked.")
            }
            return "sent a background mouse click, but Flutter apps (such as RustDesk) ignore mouse clicks while they are in the background, so expect no effect. Click their controls by element_index instead (get_app_state lists them), or use run_in_front with the same x/y (asks the user)."
        }
        if frontmostProcessID() != pid, briefFocusEnabled || focus {
            switch await briefFocusPermission(app) {
            case true?:
                if await waitForUserIdle() {
                    let delivered = await Input.withBriefFocus(pid: pid, windowID: window) {
                        await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers, chromium: chromium)
                    }
                    if delivered {
                        return "sent a mouse click while \(app.localizedName ?? "the app") had keyboard focus for a moment (it did not come forward; the user's front app kept its place). If the screenshot shows no change, this view only takes clicks while its app is in front: run_in_front with the same x/y (asks the user)."
                    }
                } else {
                    note = " The user kept typing, so it went without focus; try again in a moment."
                }
            case false?:
                note = " The user declined giving it focus."
            case nil:
                note = " Focus needs the user's approval, which this client cannot ask for."
            }
        }
        // Input sends nothing once stopped, cancelled or locked: that is no click.
        guard await Input.click(at: point, pid: pid, windowID: window, button: button, count: count, modifiers: modifiers, chromium: chromium) else {
            throw ToolError(axMutationRefusal() ?? "The click could not be sent, so nothing was clicked.")
        }
        let inFront = " this view only takes clicks while its app is in front: run_in_front with the same x/y (asks the user)."
        if isInWebContentAt(pid: pid, point: point) {
            // Chromium takes a click during a moment of focus; WebKit only in the front app.
            let retry = chromium && !focus
                ? " Click again with focus: true (asks the user once for this app)."
                : " If the screenshot shows no change," + inFront
            return "sent a background mouse click, but web content ignores pointer input in background windows; for browser tabs prefer the browser_* tools." + retry + note
        }
        let retry = focus
            ? " If the screenshot still shows no change," + inFront
            : " If the screenshot shows no change, click again with focus: true (asks the user once for this app), or use an element_index or the keyboard; failing that," + inFront
        return "sent a background mouse click." + retry + note
    }

    /// Whether this app may get keyboard focus for a moment during pointer
    /// input: SKFIY_BRIEF_FOCUS=1, or the user approved it once for the app
    /// this session. Nil when the client cannot ask.
    private func briefFocusPermission(_ app: NSRunningApplication) async -> Bool? {
        let pid = app.processIdentifier
        if briefFocusEnabled || focusApproved.contains(pid) { return true }
        guard let askUser else { return nil }
        let name = app.localizedName ?? "the app"
        let answer = await askUser("\(name) ignores clicks while it is in the background. Allow skfiy to give it keyboard focus for about a tenth of a second when it clicks there — only while you are not typing, without bringing it forward? (Asked once for \(name) this session.)")
        if answer == true {
            focusApproved.insert(pid)
        }
        return answer
    }

    func performSecondaryAction(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\" (or a target).")
        }
        let element = try session.element(index)
        let requested = try args.requiredString("action").trimmingCharacters(in: .whitespaces)
        let available = element.actionNames()
        let squash = { (text: String) in text.lowercased().filter { $0 != "_" && $0 != " " } }
        let wanted = squash(requested)
        guard let action = available.first(where: { name in
            name.lowercased() == requested.lowercased() || squash(name) == wanted || squash(name) == "ax" + wanted
                || squash(TreeRenderer.actionDisplayName(name)) == wanted
        }) else {
            let names = available.map(TreeRenderer.actionDisplayName)
            throw ToolError("Element [\(index)] does not support \"\(requested)\". Available: \(names.isEmpty ? "none" : names.joined(separator: ", ")).")
        }
        if action == kAXRaiseAction {
            throw ToolError("Raising a window would put it over the user's windows, so skfiy does not. Inspect another window with get_app_state(app, window: \"<title>\") instead; element actions work on it without raising it.")
        }
        if action == kAXShowMenuAction, frontmostProcessID() != app.processIdentifier {
            throw ToolError(Self.backgroundMenuRefusal)
        }
        let status = guardedAXPerformAction(element, action as CFString)
        try throwIfRefused(status)
        if status != .success, status != .cannotComplete {
            try check(status, "\(action) on element \(index)")
        }
        return try await afterAction(app, "Performed \(TreeRenderer.actionDisplayName(action)) on [\(index)] \(describe(element)).")
    }

    func setValue(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\" (or a target).")
        }
        let element = try session.element(index)
        let text = try args.requiredText("value")
        let role = element.string(kAXRoleAttribute) ?? ""
        lastInputWasSecret = element.string(kAXSubroleAttribute) == "AXSecureTextField"
        if role == "AXPopUpButton" || role == "AXComboBox" && !element.isSettable(kAXValueAttribute) {
            let how = try await chooseOption(element, text, app: app)
            return try await afterAction(app, "Chose \(quote(text, limit: 60)) in [\(index)] \(describe(element)) (\(how)).")
        }
        guard element.isSettable(kAXValueAttribute) else {
            throw ToolError("Element [\(index)] \(describe(element)) has no settable value. Click it and use type_text, or use its actions.")
        }
        if Self.textRoles.contains(role), isFlutter(app) {
            // Measured with RustDesk: the value reads back as set, but only
            // Flutter's invisible stand-in field changes, not what the app has.
            throw ToolError("[\(index)] \(describe(element)) is a text field of a Flutter app, which ignores values set through accessibility (the field would only appear to change). Nothing was changed. Click it by element_index (that focuses it, and makes its window the key window), then use type_text; press cmd+a first to replace what is there.")
        }
        if let frame = element.frame {
            await VirtualCursor.move(to: CGPoint(x: frame.midX, y: frame.midY), pid: app.processIdentifier)
            VirtualCursor.show(.keys("⌨︎"), pid: app.processIdentifier)
        }
        let newValue: CFTypeRef
        switch element.value(kAXValueAttribute) {
        case let current? where CFGetTypeID(current) == CFBooleanGetTypeID():
            newValue = (["1", "true", "yes", "on"].contains(text.lowercased()) ? kCFBooleanTrue : kCFBooleanFalse)!
        case let current? where current is NSNumber:
            guard let number = Double(text.trimmingCharacters(in: .whitespaces)) else {
                throw ToolError("Element [\(index)] holds a number; \"\(text)\" is not one.")
            }
            newValue = NSNumber(value: number)
        default:
            newValue = text as CFString
        }
        let webText = Self.textRoles.contains(role) && isInWebContent(element)
        if webText {
            // WebKit applies AXValue to the selection of whatever field has
            // focus, so move focus to the target first and make sure it took.
            _ = try? element.set(kAXFocusedAttribute, kCFBooleanTrue)
            await Input.pause(0.05)
            // Chromium sets the value of the element itself; its tree only
            // reports the focus late in a window that is covered or not key.
            guard element.bool(kAXFocusedAttribute) == true || isChromium(app) else {
                throw ToolError("Could not focus [\(index)] \(describe(element)) to set its value; nothing was changed. Click it and use type_text instead.")
            }
        }
        try element.set(kAXValueAttribute, newValue)
        if webText {
            // Chromium updates the tree of a window that is not the key window
            // (or is covered) late, or not at all: then the read-back proves nothing.
            let elementWindow = containingWindow(of: element).flatMap(windowID(of:))
            let lagging = elementWindow != focusedWindowID(of: app.processIdentifier) || chromiumWindowFrozen(app, window: elementWindow)
            var now = await settledValue(element, expecting: text)
            if lagging, now != text {
                await Input.pause(0.6)
                now = await settledValue(element, expecting: text)
            }
            if let now, now != text {
                return try await afterAction(app, lagging
                    ? "Set the value of [\(index)] \(describe(element)), but could not confirm it: accessibility still reads \(quote(now, limit: 60)), and Chromium updates it late (or not at all) in a window that is not the app's key window or is covered. Check the page itself before setting it again."
                    : "Tried to set the value of [\(index)] \(describe(element)), but it now reads \(quote(now, limit: 60)); the page may have reformatted or rejected it.")
            }
        }
        return try await afterAction(app, "Set the value of [\(index)] \(describe(element)).")
    }

    func scroll(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        let direction = try args.requiredString("direction").lowercased()
        guard ["up", "down", "left", "right"].contains(direction) else {
            throw ToolError("direction must be up, down, left, or right.")
        }
        let pages = try args.double("pages") ?? 1
        guard pages > 0, pages <= 50 else {
            throw ToolError("pages must be between 0 and 50.")
        }
        let pid = app.processIdentifier
        let vertical = direction == "up" || direction == "down"

        let element: AXUIElement?
        let point: CGPoint
        let described: String
        if let index = try args.elementIndex() {
            let indexed = try session.element(index)
            element = indexed
            point = try await visibleCenter(of: indexed, session: session)
            described = "[\(index)]"
        } else if args.values["x"] != nil || args.values["y"] != nil {
            point = try screenPoint(args, "x", "y", session: session)
            element = hitTest(pid: pid, at: point)
            described = "at (\(formatNumber(try args.double("x") ?? 0)), \(formatNumber(try args.double("y") ?? 0)))"
        } else {
            throw ToolError("Pass element_index (preferred) or x/y.")
        }

        // Wheel events, a page being about 85% of what shows of the element
        // (or of the window), at least 40 pt. Not AXScroll*ByPage: TextEdit
        // reports failure for it yet scrolls, the wrong way.
        guard let window = pointerWindow(pid: pid, at: point, element: element) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at that point.")
        }
        // Not into a remote session either: the wheel would scroll the remote computer.
        try checkPointerTarget(app, window: element.flatMap(containingWindow(of:)), what: "wheel input", receiver: window, point: point,
                               aimed: args.values["x"] != nil || args.values["y"] != nil)
        // Chromium drops wheel input to a fully covered window once it stops
        // drawing it (it does so a little while after the window is covered).
        let frozen = chromiumWindowFrozen(app, window: window)
        let area = element?.frame.map { frame -> CGRect in
            let visible = frame.intersection(session.geometry?.rect ?? frame)
            return visible.isNull || visible.width < 1 ? frame : visible
        } ?? session.geometry?.rect ?? .zero
        let distance = max((vertical ? area.height : area.width) * 0.85, 40) * pages
        let delta: (Double, Double) = switch direction {
        case "up": (0, -distance)
        case "down": (0, distance)
        case "left": (-distance, 0)
        default: (distance, 0)
        }
        await VirtualCursor.move(to: point, pid: pid, window: window)
        await Input.scroll(at: point, dx: delta.0, dy: delta.1, pid: pid, windowID: window)
        VirtualCursor.show(.scroll(dx: delta.0, dy: delta.1), pid: pid)
        return try await afterAction(app, "Scrolled \(described) \(direction) \(formatNumber(pages)) page(s) (wheel event sent to the app in the background)."
            + (frozen ? " It may have done nothing: Chromium ignores wheel input to a window that is completely covered once it stops drawing it." : ""))
    }

    func drag(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        let start = try screenPoint(args, "from_x", "from_y", session: session)
        let end = try screenPoint(args, "to_x", "to_y", session: session)
        let pid = app.processIdentifier
        guard let window = pointerWindow(pid: pid, at: start) else {
            throw ToolError("No window of \(app.localizedName ?? "the app") is at the start point.")
        }
        try checkPointerTarget(app, window: axWindow(window, pid: pid), receiver: window, point: start, aimed: true)
        var how = "background mouse events"
        let focus = args.bool("focus") ?? false
        await VirtualCursor.move(to: start, pid: pid, window: window)
        // The events take about half a second; the cursor moves with them, pressed.
        VirtualCursor.glide(to: end, pid: pid, window: window, pressed: true, duration: 0.45)
        if frontmostProcessID() != pid, briefFocusEnabled || focus, await briefFocusPermission(app) == true, await waitForUserIdle(),
           await Input.withBriefFocus(pid: pid, windowID: window, { await Input.drag(from: start, to: end, pid: pid, windowID: window) }) {
            how = "mouse events while the app had keyboard focus for a moment"
        } else {
            await Input.drag(from: start, to: end, pid: pid, windowID: window)
        }
        VirtualCursor.show(.release, pid: pid)
        return try await afterAction(app, "Dragged from (\(formatNumber(try args.double("from_x") ?? 0)), \(formatNumber(try args.double("from_y") ?? 0))) to (\(formatNumber(try args.double("to_x") ?? 0)), \(formatNumber(try args.double("to_y") ?? 0))) (\(how))." + (how.hasPrefix("background") ? " Some views ignore background drags (TextEdit's text, for one): check the screenshot, and select text with select_text instead." : ""))
    }

    private var briefFocusEnabled: Bool {
        ProcessInfo.processInfo.environment["SKFIY_BRIEF_FOCUS"] == "1"
    }

    /// Waits (up to 3 s) until the user has not typed or moved the mouse for
    /// 0.8 s, so a brief focus never lands in the middle of their typing.
    private func waitForUserIdle() async -> Bool {
        for _ in 0..<15 {
            if Input.userIdleSeconds() >= 0.8 {
                return true
            }
            await Input.pause(0.2)
        }
        return false
    }

    /// The items of a pop-up button's (closed) menu.
    private func popupOptions(_ popup: AXUIElement) -> [(element: AXUIElement, title: String)] {
        guard let menu = popup.elements(kAXChildrenAttribute).first(where: { $0.string(kAXRoleAttribute) == kAXMenuRole }) else {
            return []
        }
        return menu.elements(kAXChildrenAttribute).compactMap { item in
            let values = item.multipleValues([kAXTitleAttribute, kAXValueAttribute])
            guard let title = nonEmpty(values[kAXTitleAttribute].flatMap(axString) ?? values[kAXValueAttribute].flatMap(axDisplayValue)) else {
                return nil
            }
            return (item, title)
        }
    }

    /// Selects a pop-up option without opening the pop-up: press the menu item
    /// (native pop-ups), set the value, or focus it and type the option's name
    /// (HTML selects), verifying each step.
    private func chooseOption(_ popup: AXUIElement, _ option: String, app: NSRunningApplication) async throws -> String {
        let wanted = option.trimmingCharacters(in: .whitespaces).lowercased()
        let selected = { (popup.string(kAXValueAttribute) ?? "").trimmingCharacters(in: .whitespaces).lowercased() == wanted }
        let options = popupOptions(popup)
        if let item = options.first(where: { $0.title.lowercased() == wanted })
            ?? options.first(where: { $0.title.lowercased().contains(wanted) }) {
            let status = guardedAXPerformAction(item.element, kAXPressAction as CFString)
            try throwIfRefused(status)
            if status == .success {
                await Input.pause(0.2)
                if selected() || popup.string(kAXValueAttribute) == nil {
                    return "pressed the option through accessibility"
                }
            }
        }
        if popup.isSettable(kAXValueAttribute) {
            let status = guardedAXSetAttributeValue(popup, kAXValueAttribute as CFString, option as CFString)
            try throwIfRefused(status)
            if status == .success {
                await Input.pause(0.2)
                if selected() { return "set through accessibility" }
            }
        }
        try checkInputTarget(app)
        // Typed keys go to the app's key window: only when the pop-up is in it.
        let names = options.map { quote($0.title, limit: 40) }.joined(separator: ", ")
        let popupWindow = containingWindow(of: popup).flatMap(windowID(of:))
        guard popupWindow == nil || popupWindow == focusedWindowID(of: app.processIdentifier) else {
            throw ToolError("Could not choose \(quote(option, limit: 60)) through accessibility, and typing its name would go to the app's key window, not to the window of this pop-up, so nothing was typed. The value is still \(quote(popup.string(kAXValueAttribute) ?? "?", limit: 60)).\(names.isEmpty ? "" : " Options: \(names).")")
        }
        _ = try? popup.set(kAXFocusedAttribute, kCFBooleanTrue)
        await Input.pause(0.1)
        await Input.type(option, to: app.processIdentifier)
        await Input.pause(0.3)
        if selected() { return "focused it and typed the option name" }
        throw ToolError("Could not choose \(quote(option, limit: 60)); the value is still \(quote(popup.string(kAXValueAttribute) ?? "?", limit: 60)).\(names.isEmpty ? "" : " Options: \(names).")")
    }

    private func isInWebContentAt(pid: pid_t, point: CGPoint) -> Bool {
        hitTest(pid: pid, at: point).map(isInWebContent) ?? false
    }

    private func isInWebContent(_ element: AXUIElement) -> Bool {
        var current: AXUIElement? = element
        for _ in 0..<40 {
            guard let candidate = current else { return false }
            switch candidate.string(kAXRoleAttribute) {
            case "AXWebArea": return true
            case "AXWindow", "AXApplication": return false
            default: current = candidate.element(kAXParentAttribute)
            }
        }
        return false
    }
}
