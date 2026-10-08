import AppKit
import Carbon.HIToolbox

/// The user's emergency stop. Pressing ⌃⌥⌘. (control-option-command-period)
/// anywhere stops every running skfiy: typing in progress breaks off, and
/// every action and read (get_app_state, browser_tabs…) is refused until the
/// shortcut is pressed again or `skfiy resume` runs; only list_apps,
/// get_desktop_status, get_app_capabilities and the locked-use status tools
/// still answer. The state is a flag file, so it holds for all skfiy
/// processes even though only one of them can own the shortcut.
public enum EmergencyStop {
    public static let shortcut = "⌃⌥⌘."

    static var flag: URL {
        if let path = ProcessInfo.processInfo.environment["SKFIY_STOP_FILE"] {
            return URL(fileURLWithPath: path)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/skfiy/stopped")
    }

    public static var isStopped: Bool {
        FileManager.default.fileExists(atPath: flag.path)
    }

    /// Returns how long the confirmation sound plays. A process that exits
    /// must wait that long: a sound cut off by the process exiting stalls
    /// screen capture system-wide for a while.
    @discardableResult
    public static func set(stopped: Bool, sound: Bool = true) -> TimeInterval {
        if stopped {
            try? FileManager.default.createDirectory(at: flag.deletingLastPathComponent(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: flag.path, contents: Data())
        } else {
            try? FileManager.default.removeItem(at: flag)
        }
        guard sound, let confirmation = NSSound(named: stopped ? "Funk" : "Glass"), confirmation.play() else { return 0 }
        return confirmation.duration
    }

    static let refusal = "The user pressed \(shortcut) to stop skfiy, so nothing was done. Stop working and ask them how to continue; they resume skfiy with \(shortcut) again or `skfiy resume`."

    nonisolated(unsafe) private static var hotKey: EventHotKeyRef?
    nonisolated(unsafe) private static var handlerInstalled = false

    /// Registers the shortcut. Another skfiy may already own it, in which case
    /// this returns false and the caller should try again later.
    @MainActor @discardableResult
    public static func registerShortcut() -> Bool {
        if hotKey != nil { return true }
        if !handlerInstalled {
            var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                EmergencyStop.set(stopped: !EmergencyStop.isStopped)
                return noErr
            }, 1, &pressed, nil, nil)
            handlerInstalled = status == noErr
        }
        var reference: EventHotKeyRef?
        let id = EventHotKeyID(signature: OSType(0x736B_6679), id: 1) // "skfy"
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_Period), UInt32(cmdKey | optionKey | controlKey), id,
                                         GetApplicationEventTarget(), 0, &reference)
        guard status == noErr, let reference else { return false }
        hotKey = reference
        return true
    }
}
