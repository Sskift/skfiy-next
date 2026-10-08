import AppKit
import ApplicationServices
import Foundation

/// select_text, press_key and type_text: keys and text go to the window the
/// model works in, or through accessibility when keys would land elsewhere.
extension ComputerUse {
    func selectText(_ args: Arguments) async throws -> ToolResult {
        let (app, session) = try target(args)
        guard let index = try args.elementIndex() else {
            throw ToolError("Missing required argument \"element_index\" (or a target).")
        }
        let element = try session.element(index)
        let target = try args.requiredText("text")
        guard !target.isEmpty else {
            throw ToolError("\"text\" must not be empty.")
        }
        let prefix = args.string("prefix") ?? ""
        let suffix = args.string("suffix") ?? ""
        let mode = args.string("selection") ?? "text"
        guard ["text", "cursor_before", "cursor_after"].contains(mode) else {
            throw ToolError("selection must be text, cursor_before, or cursor_after.")
        }
        guard let content = element.string(kAXValueAttribute) else {
            throw ToolError("Element [\(index)] \(describe(element)) has no text value to select in.")
        }
        let range = try locateText(target, in: content, prefix: prefix, suffix: suffix)
        let selection = switch mode {
        case "cursor_before": CFRange(location: range.location, length: 0)
        case "cursor_after": CFRange(location: range.location + range.length, length: 0)
        default: CFRange(location: range.location, length: range.length)
        }
        if let frame = element.frame {
            await VirtualCursor.move(to: CGPoint(x: frame.midX, y: frame.midY), pid: app.processIdentifier)
            VirtualCursor.show(.click(count: 1, button: .left), pid: app.processIdentifier)
        }
        _ = try? element.set(kAXFocusedAttribute, kCFBooleanTrue)
        try setSelection(element, selection)
        let what = mode == "text" ? "Selected \(quote(target, limit: 60))" : "Placed the cursor \(mode == "cursor_before" ? "before" : "after") \(quote(target, limit: 60))"
        return try await afterAction(app, "\(what) in [\(index)].")
    }

    func pressKey(_ args: Arguments) async throws -> ToolResult {
        let (app, _) = try target(args)
        let key = try args.requiredString("key")
        let chord = try parseKeyChord(key)
        let count = try args.int("repeat") ?? 1
        guard (1...100).contains(count) else {
            throw ToolError("repeat must be between 1 and 100.")
        }
        try checkInputTarget(app)
        let pid = app.processIdentifier
        // Key events go to the app's key window, which may not be the window
        // the model works in: it is made the key window, or no key is sent.
        let keyboard = try await keyboardTarget(app, args)
        if !keyboard.reachesIntended {
            // Shortcuts done through accessibility work on any window.
            if let how = try emulateShortcut(chord, pid: pid, window: keyboard.intendedWindow, text: keyboard.text) {
                await VirtualCursor.typing(VirtualCursor.keycaps(key), pid: pid)
                return try await afterAction(app, "Pressed \(key) in \(quote(keyboard.intendedTitle, limit: 60)): \(how) (accessibility; the app's key window \(quote(keyboard.keyTitle, limit: 60)) was left alone).")
            }
            if let text = keyboard.text, let how = try await clipboardShortcut(chord, pid: pid, text: text, menu: false) {
                await VirtualCursor.typing(VirtualCursor.keycaps(key), pid: pid)
                return try await afterAction(app, "Pressed \(key): \(how).")
            }
            throw ToolError(keyboard.refusal(app: app.localizedName ?? "the app"))
        }
        await VirtualCursor.typing(VirtualCursor.keycaps(key), pid: pid)
        if let seconds = try args.double("hold_seconds") {
            guard (0.05...10).contains(seconds), count == 1 else {
                throw ToolError("hold_seconds must be between 0.05 and 10, without repeat.")
            }
            await Input.hold(chord, seconds: seconds, to: pid)
            return try await afterAction(app, "Held \(key) for \(formatNumber(seconds)) s (sent to the app in the background).\(keyboard.note)")
        }
        let text = keyboard.text ?? focusedTextElement(pid)
        let window = keyboard.intendedWindow ?? AXUIElementCreateApplication(pid).element(kAXFocusedWindowAttribute)

        // A background app ignores menu key equivalents, so run the menu item
        // itself. Items that depend on the focused document or text (Save,
        // Select All, Close) are disabled while the app is in the background;
        // the common ones are done through accessibility instead.
        if let how = try await clipboardShortcut(chord, pid: pid, text: text) {
            return try await afterAction(app, "Pressed \(key): \(how).\(keyboard.note)")
        }
        var disabledItem: String?
        if !chord.modifiers.isDisjoint(with: [.command, .control]) {
            if let item = menuItem(for: chord, pid: pid) {
                if item.enabled {
                    var pressed = 0
                    for _ in 0..<count {
                        let status = guardedAXPerformAction(item.element, kAXPressAction as CFString)
                        try throwIfRefused(status)
                        guard status == .success || status == .cannotComplete else { break }
                        pressed += 1
                    }
                    if pressed == count {
                        return try await afterAction(app, "Pressed \(key) by invoking the menu item \(quote(item.title, limit: 60)).\(keyboard.note)")
                    }
                } else {
                    disabledItem = item.title
                }
            }
            if let how = try emulateShortcut(chord, pid: pid, window: window, text: text) {
                return try await afterAction(app, "Pressed \(key): \(how) (accessibility).\(keyboard.note)")
            }
        }
        // Keys sent to the frontmost app pass through its input method (Pinyin
        // would turn "comma" into "，"); insert such characters directly.
        if let text = chord.typedText, frontmostProcessID() == pid, Input.inputMethodActive(),
           let focused = focusedElement(pid), focused.isSettable(kAXSelectedTextAttribute) {
            try focused.set(kAXSelectedTextAttribute, String(repeating: text, count: count) as CFString)
            return try await afterAction(app, "Entered \(quote(text, limit: 10)) (accessibility).")
        }
        await Input.press(chord, repeat: count, to: pid)
        var message = "Pressed \(key)" + (count > 1 ? " ×\(count)" : "") + " (sent to the app in the background)." + keyboard.note
        if let disabledItem {
            message += " Its menu item \(quote(disabledItem, limit: 60)) is disabled while the app is in the background, so the shortcut did nothing. Commands that act on the current selection or document (formatting, Save, Undo…) only work in the frontmost app, and toolbar buttons for them are ignored in the background too. skfiy does not bring apps forward on its own; use run_in_front, which asks the user first, or say what is left to do instead of retrying."
        }
        return try await afterAction(app, message)
    }

    func typeText(_ args: Arguments) async throws -> ToolResult {
        let (app, _) = try target(args)
        let text = try args.requiredText("text")
        guard !text.isEmpty else {
            throw ToolError("\"text\" must not be empty.")
        }
        try checkInputTarget(app)
        let pid = app.processIdentifier
        // Key events go to the app's key window, which may not be the window
        // the model works in: it is made the key window, or the text goes
        // into its field through accessibility, or nothing is sent.
        let keyboard = try await keyboardTarget(app, args)
        // Flutter takes text set through accessibility only in an invisible
        // stand-in field, so for it keys are the only way.
        let flutter = isFlutter(app)
        if !keyboard.reachesIntended {
            guard !flutter, let field = keyboard.text, field.isSettable(kAXSelectedTextAttribute) else {
                throw ToolError(keyboard.refusal(app: app.localizedName ?? "the app"))
            }
            await VirtualCursor.typing("⌨︎", pid: pid)
            lastInputWasSecret = field.string(kAXSubroleAttribute) == "AXSecureTextField"
            let before = field.string(kAXValueAttribute)
            try field.set(kAXSelectedTextAttribute, text as CFString)
            guard await settledValue(field, changedFrom: before) != before || before == nil else {
                throw ToolError("Keyboard input would go to the app's key window \(quote(keyboard.keyTitle, limit: 60)), so skfiy tried to insert the text into \(describe(field)) of \(quote(keyboard.intendedTitle, limit: 60)) through accessibility, but its value did not change\(keyboard.why). " + keyboard.refusal(app: app.localizedName ?? "the app"))
            }
            return try await afterAction(app, "Entered \(text.count) character(s) into \(describe(field)) of \(quote(keyboard.intendedTitle, limit: 60)) through accessibility: key events would have gone to the app's key window \(quote(keyboard.keyTitle, limit: 60)) instead\(keyboard.why). The app may not count text entered this way as a change; save explicitly before closing the document.")
        }
        await VirtualCursor.typing("⌨︎", pid: pid)
        // Background Chromium (Electron) reports no focused element even
        // right after a click focused a field: that field is meant.
        let focused = focusedElement(pid) ?? keyboard.text ?? typingTargets[pid].flatMap { $0.string(kAXRoleAttribute) == nil ? nil : $0 }
        lastInputWasSecret = focused?.string(kAXSubroleAttribute) == "AXSecureTextField"
        var note = keyboard.note
        if let focused, !isTextLike(focused) {
            note += " Keyboard focus is on \(describe(focused)), not a text field; click the field first if the text went missing."
        } else if focused == nil {
            note += " The app reports no focused element; click the field first if the text went missing."
        }

        // Insert directly when the frontmost app's input method would compose
        // keystrokes, or when the text is long enough that keystrokes are slow.
        let imeWouldCompose = frontmostProcessID() == pid && Input.inputMethodActive()
        if imeWouldCompose || text.count > 200, !flutter, let focused, focused.isSettable(kAXSelectedTextAttribute) {
            let before = focused.string(kAXValueAttribute)
            // Some apps (TextEdit) take text set through accessibility without
            // counting it as an edit: the document stays unchanged, and closing
            // it drops the text without asking. So a space goes in after the
            // text and is taken back with a real Delete key press, which they
            // do count (an input method lets Delete through).
            if (try? focused.set(kAXSelectedTextAttribute, (text + " ") as CFString)) != nil,
               before == nil || focused.string(kAXValueAttribute) != before {
                let inserted = await settledValue(focused, changedFrom: before)
                if let backspace = try? parseKeyChord("backspace") {
                    await Input.press(backspace, to: pid)
                }
                let after = await settledValue(focused, changedFrom: inserted)
                if let inserted, after == inserted {
                    // The key did not arrive: take the space back through
                    // accessibility too, and say the app may not see an edit.
                    if let range = selectedRange(focused), range.location > 0,
                       (try? setSelection(focused, CFRange(location: range.location - 1, length: 1))) != nil {
                        try? focused.set(kAXSelectedTextAttribute, "" as CFString)
                    }
                    return try await afterAction(app, "Entered \(text.count) character(s) (accessibility). The app may not count text entered this way as a change; save explicitly before closing the document.\(note)")
                }
                return try await afterAction(app, "Entered \(text.count) character(s) (accessibility, then a Delete key press so the app counts it as a change).\(note)")
            }
        }
        let before = focused?.string(kAXValueAttribute)
        let typed = await Input.type(text, to: pid)
        if typed < text.count {
            throw ToolError("Stopped after \(typed) of \(text.count) character(s): " + EmergencyStop.refusal)
        }
        await Input.pause(0.15)
        if !flutter, let focused, let before, focused.string(kAXValueAttribute) == before {
            // The app ignored background keystrokes: insert at the caret
            // through accessibility, or set the field's value with the text
            // put where the caret is.
            if focused.isSettable(kAXSelectedTextAttribute), (try? focused.set(kAXSelectedTextAttribute, text as CFString)) != nil,
               await settledValue(focused, changedFrom: before) != before {
                return try await afterAction(app, "Entered \(text.count) character(s) (the app ignored background keystrokes, so they were inserted through accessibility).\(note)")
            }
            if focused.isSettable(kAXValueAttribute) {
                let current = before as NSString
                let range = selectedRange(focused) ?? CFRange(location: current.length, length: 0)
                let location = min(max(0, range.location), current.length)
                let length = min(max(0, range.length), current.length - location)
                let updated = current.replacingCharacters(in: NSRange(location: location, length: length), with: text)
                if (try? focused.set(kAXValueAttribute, updated as CFString)) != nil, await settledValue(focused, expecting: updated) == updated {
                    setCaret(focused, location + (text as NSString).length)
                    return try await afterAction(app, "Entered \(text.count) character(s) (the app ignored background keystrokes, so the field's value was set through accessibility, with the text at the caret).\(note)")
                }
            }
        }
        return try await afterAction(app, "Typed \(text.count) character(s) (sent to the app in the background).\(note)")
    }

    /// cmd+a, cmd+w and cmd+m through accessibility, on `window` (the window
    /// the model works in) and its text field.
    private func emulateShortcut(_ chord: KeyChord, pid: pid_t, window: AXUIElement?, text: AXUIElement?) throws -> String? {
        guard chord.modifiers == .command, let character = chord.baseCharacter else { return nil }
        switch character {
        case "a":
            guard let text else { return nil }
            let length = (text.string(kAXValueAttribute) as NSString?)?.length ?? 0
            try setSelection(text, CFRange(location: 0, length: length))
            return "selected all text in the focused field"
        case "w":
            guard let close = window?.element(kAXCloseButtonAttribute) else { return nil }
            try close.perform(kAXPressAction)
            return "pressed the window's close button"
        case "m":
            guard let window else { return nil }
            try window.set(kAXMinimizedAttribute, kCFBooleanTrue)
            return "minimized the window"
        default:
            return nil
        }
    }
}

/// Finds `text` in `content` (UTF-16 offsets, as AX expects), disambiguated by
/// the text immediately before and after it.
func locateText(_ text: String, in content: String, prefix: String, suffix: String) throws -> NSRange {
    let haystack = content as NSString
    var matches: [NSRange] = []
    var searchRange = NSRange(location: 0, length: haystack.length)
    while searchRange.length > 0 {
        let found = haystack.range(of: text, options: [], range: searchRange)
        guard found.location != NSNotFound else { break }
        let before = haystack.substring(to: found.location)
        let after = haystack.substring(from: found.location + found.length)
        if before.hasSuffix(prefix), after.hasPrefix(suffix) {
            matches.append(found)
        }
        let next = found.location + max(found.length, 1)
        searchRange = NSRange(location: next, length: haystack.length - next)
    }
    switch matches.count {
    case 0:
        throw ToolError("Text \(quote(text, limit: 80)) was not found in the element\(prefix.isEmpty && suffix.isEmpty ? "" : " with that prefix/suffix").")
    case 1:
        return matches[0]
    default:
        throw ToolError("Text \(quote(text, limit: 80)) occurs \(matches.count) times; pass prefix and/or suffix to pick one.")
    }
}
