import AppKit
import ApplicationServices
import Foundation

/// Apple's client exposes the remote framebuffer as AXSharedScreen, separate
/// from its local toolbar. Titles and their localized status suffixes are not
/// reliable connection identities or lock/control-state indicators.
struct SharedScreenSnapshot: Equatable {
    var window: CGWindowID
    var identifier: String
    var title: String
    var frame: CGRect

    func validate(current: SharedScreenSnapshot?, captured: Date?, now: Date = Date()) throws {
        guard let captured, (0...30).contains(now.timeIntervalSince(captured)) else {
            throw ToolError("Screen Sharing needs a screenshot from the last 30 seconds. Call get_app_state again; nothing was sent.")
        }
        guard current == self else {
            throw ToolError("The shared screen changed, moved, resized or disconnected. Call get_app_state again; nothing was sent.")
        }
    }

    func contains(_ point: CGPoint) -> Bool {
        point.x.isFinite && point.y.isFinite && frame.contains(point)
    }
}

enum ScreenSharing {
    static func isApp(_ bundleID: String?) -> Bool { bundleID?.lowercased() == "com.apple.screensharing" }

    static func surface(in window: AXUIElement?) -> AXUIElement? {
        window?.descendant(limit: 600) { $0.string(kAXRoleAttribute) == "AXSharedScreen" }
    }

    static func snapshot(in window: AXUIElement?) -> SharedScreenSnapshot? {
        guard let window, let id = windowID(of: window), let surface = surface(in: window),
              let frame = surface.frame, !frame.isNull, frame.width > 0, frame.height > 0 else { return nil }
        return SharedScreenSnapshot(window: id, identifier: surface.string(kAXIdentifierAttribute) ?? "",
                                    title: surface.string(kAXTitleAttribute) ?? "", frame: frame)
    }

    static func validateScrollDirection(_ direction: String) throws {
        guard direction == "up" || direction == "down" else {
            throw ToolError("Apple Screen Sharing's standard VNC path does not reliably forward horizontal wheel events. Nothing was sent. Vertical scrolling is supported; use a visible remote scrollbar for horizontal movement.")
        }
    }

    static let guidance = "This is an Apple Screen Sharing remote screen. Its pixels have no remote accessibility controls; use screenshot x/y for click, right-click, vertical scroll and drag. ASCII text and plain keys go directly to the shared screen, without local menu shortcuts or skfiy clipboard emulation. Unicode text is refused before any input. Modifier shortcuts need run_in_front (user approval, local focus/window order changes). The client must be in Control mode and the shared screen must be its keyboard target; skfiy never activates it or switches modes automatically. Inspect the returned screenshot to verify the remote effect. Client clipboard synchronization, if enabled by the user, still follows Screen Sharing's settings."
}

extension ComputerUse {
    /// Whether an action targets the framebuffer (not the client's toolbar).
    /// Check both the retained screenshot and live AX surface: disconnects and
    /// toolbar/layout changes must not turn a remote click into a local click.
    func sharedScreenPointer(_ app: NSRunningApplication, session: AppSession, point: CGPoint,
                             element: AXUIElement? = nil) throws -> SharedScreenSnapshot? {
        guard ScreenSharing.isApp(app.bundleIdentifier) else { return nil }
        let window = session.windowID.flatMap { axWindow($0, pid: app.processIdentifier) }
        let live = ScreenSharing.snapshot(in: window)
        let indexedSurface = element?.string(kAXRoleAttribute) == "AXSharedScreen"
        guard indexedSurface || session.sharedScreen?.contains(point) == true || live?.contains(point) == true else { return nil }
        guard let saved = session.sharedScreen else {
            throw ToolError("No shared screen in the latest screenshot. Call get_app_state with its window id; nothing was sent.")
        }
        try saved.validate(current: live, captured: session.captured)
        try checkPointerTarget(app, window: window)
        try checkWindowUnmoved(session)
        guard saved.contains(point), pointerWindow(pid: app.processIdentifier, at: point, element: element) == saved.window else {
            throw ToolError("That point does not reach the inspected shared screen. Refresh get_app_state; nothing was sent.")
        }
        return saved
    }

    func sharedScreenKeyboard(_ app: NSRunningApplication, session: AppSession) throws -> SharedScreenSnapshot? {
        guard ScreenSharing.isApp(app.bundleIdentifier) else { return nil }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        let key = root.element(kAXFocusedWindowAttribute)
        guard let saved = session.sharedScreen else {
            if ScreenSharing.surface(in: key) != nil {
                throw ToolError("Screen Sharing's keyboard target is a remote screen that was not inspected. Call get_app_state with that window id; nothing was sent.")
            }
            return nil
        }
        let window = axWindow(saved.window, pid: app.processIdentifier)
        try saved.validate(current: ScreenSharing.snapshot(in: window), captured: session.captured)
        try checkPointerTarget(app, window: window)
        try checkWindowUnmoved(session)
        guard sharedScreenHasKeyboard(app.processIdentifier, saved) else {
            throw ToolError("The inspected shared screen is not Screen Sharing's keyboard target (another window, toolbar or dialog has focus). Select that connection as the client's keyboard target manually, then inspect again; nothing was sent. skfiy does not take local keyboard focus.")
        }
        return saved
    }

    func sharedScreenHasKeyboard(_ pid: pid_t, _ saved: SharedScreenSnapshot) -> Bool {
        let root = AXUIElementCreateApplication(pid)
        guard let key = root.element(kAXFocusedWindowAttribute), windowID(of: key) == saved.window,
              let surface = ScreenSharing.surface(in: key),
              let focused = root.element(kAXFocusedUIElementAttribute) else { return false }
        return isSelfOrDescendant(focused, of: surface)
    }

    func checkSharedScreenModifiers(_ modifiers: Modifiers, foreground: Bool) throws {
        guard modifiers.isEmpty || foreground else {
            throw ToolError("Apple Screen Sharing does not forward modifier transitions reliably in the background. Nothing was sent. For a remote shortcut use run_in_front with key (asks the user and changes local focus/window order); plain keys, ASCII text and unmodified pointer actions work in the background.")
        }
    }

    func checkSharedScreenKey(_ chord: KeyChord, foreground: Bool) throws {
        guard case .code(let code) = chord.key else {
            throw ToolError("Apple Screen Sharing forwards hardware key codes and does not accept Unicode text events reliably. Nothing was sent. Use ASCII keys with the remote input method, or enter Unicode text manually.")
        }
        // Shortcuts and standalone modifiers need actual modifier transitions.
        // type_text separately sends uppercase ASCII as uppercase keysyms.
        let modifiers = Modifiers.physical.first(where: { $0.1 == code })?.0 ?? chord.modifiers
        try checkSharedScreenModifiers(modifiers, foreground: foreground)
    }

    /// Recheck connection and routing while a drag or a long string is in
    /// flight. Never resume delivery to a newly selected connection.
    func withSharedScreenInput(_ app: NSRunningApplication, screen: SharedScreenSnapshot, keyboard: Bool = false, foreground: Bool = false,
                               body: () async -> Void) async throws {
        let valid = {
            !app.isTerminated && !self.appIsHidden(app)
                && ScreenSharing.snapshot(in: self.axWindow(screen.window, pid: app.processIdentifier)) == screen
                && self.presence(of: screen.window, app: app) == .onScreen
                && (!keyboard || self.sharedScreenHasKeyboard(app.processIdentifier, screen))
                && (!foreground || frontmostProcessID() == app.processIdentifier)
        }
        guard valid() else { throw ToolError("The shared screen's input target changed; nothing was sent. Call get_app_state again.") }
        Input.remoteValidation = valid
        Input.remoteAborted = false
        defer { Input.remoteValidation = nil; Input.remoteAborted = false }
        await body()
        guard !Input.remoteAborted, Input.canSend, valid() else {
            throw ToolError("Screen Sharing input stopped because the target changed, the request was cancelled, or the desktop stopped accepting input. Some input may have reached the remote computer. Inspect get_app_state before retrying.")
        }
    }

    func afterSharedScreenInput(_ app: NSRunningApplication, screen: SharedScreenSnapshot, message: String) async throws -> ToolResult {
        await Input.pause(settleDelay)
        // Refresh the identity and coordinate lease even when pixels look the
        // same. Remote acknowledgements are not application-level receipts.
        let receipt = message + " Input was sent to Screen Sharing; verify its effect on the remote computer before repeating."
        do {
            var result = try await getAppState(Arguments(["app": "pid:\(app.processIdentifier)", "window": String(screen.window), "ocr": false]))
            result.text = receipt + "\n" + result.text
            return result
        } catch {
            return ToolResult(text: receipt + "\nThe follow-up screenshot failed: \(error). Call get_app_state before any retry; do not repeat the input blindly.", isError: true)
        }
    }
}

/// Preflight the entire string before sending anything. Apple's client maps
/// Unicode events with virtualKey 0 to "a" instead of forwarding Unicode.
func screenSharingTextChords(_ text: String) throws -> [KeyChord] {
    try text.map { character in
        guard character.unicodeScalars.allSatisfy({ $0.value < 128 }) else {
            throw ToolError("Apple Screen Sharing cannot reliably forward Unicode text events. No text was sent. Use ASCII keys with the remote input method, or enter Unicode text manually.")
        }
        switch character {
        case "\n", "\r", "\r\n": return try parseKeyChord("Return")
        case "\t": return try parseKeyChord("Tab")
        case " ": return try parseKeyChord("space")
        default:
            let chord = try parseKeyChord(String(character))
            guard case .code = chord.key else {
                throw ToolError("Screen Sharing text accepts printable ASCII, newline and tab only. No text was sent.")
            }
            return chord
        }
    }
}
