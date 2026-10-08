import CoreGraphics

/// Modifier keys, in the order they are pressed.
public struct Modifiers: OptionSet, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let control = Modifiers(rawValue: 1 << 0)
    public static let option = Modifiers(rawValue: 1 << 1)
    public static let shift = Modifiers(rawValue: 1 << 2)
    public static let command = Modifiers(rawValue: 1 << 3)
    public static let function = Modifiers(rawValue: 1 << 4)

    /// (modifier, virtual key code, event flag) in press order.
    static let physical: [(Modifiers, CGKeyCode, CGEventFlags)] = [
        (.control, 0x3B, .maskControl),
        (.option, 0x3A, .maskAlternate),
        (.shift, 0x38, .maskShift),
        (.command, 0x37, .maskCommand),
        (.function, 0x3F, .maskSecondaryFn)
    ]

    public var eventFlags: CGEventFlags {
        var flags: CGEventFlags = []
        for (modifier, _, flag) in Self.physical where contains(modifier) {
            flags.insert(flag)
        }
        return flags
    }
}

/// A parsed xdotool-style key combination such as "super+shift+t" or "Return".
public struct KeyChord: Equatable, Sendable {
    public enum Key: Equatable, Sendable {
        /// A macOS virtual key code (ANSI layout).
        case code(CGKeyCode)
        /// A character with no key on the ANSI layout; delivered as Unicode input.
        case character(String)
    }

    public var key: Key
    public var modifiers: Modifiers

    public init(key: Key, modifiers: Modifiers = []) {
        self.key = key
        self.modifiers = modifiers
    }

    /// True when pressing the chord types a character (no cmd/ctrl), which an
    /// active input method would otherwise intercept.
    public var producesText: Bool {
        guard modifiers.isDisjoint(with: [.command, .control]) else { return false }
        switch key {
        case .character: return true
        case .code(let code): return textKeyCodes.contains(code)
        }
    }
}

extension KeyChord {
    /// The unshifted ANSI character of the key, e.g. "s" for cmd+shift+s.
    public var baseCharacter: String? {
        guard case .code(let code) = key,
              let character = characterCodes.first(where: { $0.value == code })?.key else {
            return nil
        }
        return String(character)
    }

    /// The character this chord types on a US layout, when that is unambiguous.
    public var typedText: String? {
        guard producesText, !modifiers.contains(.option) else { return nil }
        switch key {
        case .character(let text):
            return text
        case .code(let code):
            if let character = keypadCharacters[code] {
                return String(character)
            }
            guard let base = baseCharacter, let character = base.first else { return nil }
            guard modifiers.contains(.shift) else { return base }
            if character.isLetter { return base.uppercased() }
            if character == " " { return " " }
            return shiftedCharacters.first(where: { $0.value == character }).map { String($0.key) }
        }
    }
}

private let keypadCharacters: [CGKeyCode: Character] = [
    0x52: "0", 0x53: "1", 0x54: "2", 0x55: "3", 0x56: "4", 0x57: "5", 0x58: "6", 0x59: "7",
    0x5B: "8", 0x5C: "9", 0x41: ".", 0x43: "*", 0x45: "+", 0x4E: "-", 0x4B: "/", 0x51: "="
]

private let textKeyCodes: Set<CGKeyCode> = Set(characterCodes.values).union(keypadCharacters.keys)

public struct KeyParseError: Error, Equatable, CustomStringConvertible {
    public let description: String
}

/// Parses xdotool `key` syntax: "a", "Return", "Tab", "super+c", "ctrl+shift+Tab",
/// "KP_0", "F5", "ctrl+plus", "cmd++". Key names are case-insensitive except
/// single characters, where "A" means shift+a (as in xdotool).
public func parseKeyChord(_ raw: String) throws -> KeyChord {
    let input = raw.trimmingCharacters(in: .whitespaces)
    guard !input.isEmpty else {
        throw KeyParseError(description: "Empty key.")
    }

    var parts = input.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    let keyName: String
    if parts.count >= 2, parts[parts.count - 1].isEmpty, parts[parts.count - 2].isEmpty {
        // "+" itself, or a trailing "++" such as "cmd++".
        keyName = "+"
        parts.removeLast(2)
    } else {
        keyName = parts.removeLast().trimmingCharacters(in: .whitespaces)
    }

    var modifiers: Modifiers = []
    for part in parts {
        let name = part.trimmingCharacters(in: .whitespaces).lowercased()
        guard let modifier = modifierNames[name] else {
            throw KeyParseError(description: "Unknown modifier '\(part)' in '\(raw)'. Use ctrl, alt/option, shift, super/cmd, or fn.")
        }
        modifiers.insert(modifier)
    }

    guard !keyName.isEmpty else {
        throw KeyParseError(description: "Missing key in '\(raw)'.")
    }

    // A modifier on its own ("shift", "super") is a tap of that modifier key.
    if keyName.count > 1, let modifier = modifierNames[keyName.lowercased()] {
        if let code = Modifiers.physical.first(where: { $0.0 == modifier })?.1 {
            return KeyChord(key: .code(code), modifiers: modifiers.subtracting(modifier))
        }
    }

    if let chord = chordForName(keyName) {
        return KeyChord(key: chord.key, modifiers: modifiers.union(chord.modifiers))
    }

    if keyName.count == 1 {
        if modifiers.isEmpty {
            return KeyChord(key: .character(keyName))
        }
        throw KeyParseError(description: "Key '\(keyName)' has no key code on the ANSI layout, so it cannot be combined with modifiers.")
    }
    throw KeyParseError(description: "Unknown key '\(keyName)' in '\(raw)'. Examples: Return, Tab, Escape, BackSpace, Delete, Up, Page_Down, F5, a, super+c.")
}

private let modifierNames: [String: Modifiers] = [
    "shift": .shift, "shift_l": .shift, "shift_r": .shift,
    "ctrl": .control, "control": .control, "control_l": .control, "control_r": .control,
    "alt": .option, "option": .option, "opt": .option, "alt_l": .option, "alt_r": .option,
    "super": .command, "super_l": .command, "super_r": .command,
    "cmd": .command, "command": .command, "meta": .command, "meta_l": .command, "meta_r": .command,
    "win": .command, "windows": .command,
    "fn": .function, "function": .function
]

/// Unshifted characters on the ANSI layout.
private let characterCodes: [Character: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
    "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
    "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
    "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
    "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32, " ": 0x31
]

/// Shifted characters on the ANSI layout, mapped to their unshifted key.
private let shiftedCharacters: [Character: Character] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
    "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";",
    "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`"
]

private let namedCodes: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24, "kp_enter": 0x4C,
    "tab": 0x30, "iso_left_tab": 0x30, "space": 0x31,
    "backspace": 0x33, "delete": 0x75, "forwarddelete": 0x75, "escape": 0x35, "esc": 0x35,
    "home": 0x73, "end": 0x77,
    "page_up": 0x74, "pageup": 0x74, "prior": 0x74,
    "page_down": 0x79, "pagedown": 0x79, "next": 0x79,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "insert": 0x72, "help": 0x72, "caps_lock": 0x39,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62,
    "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F, "f13": 0x69,
    "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40, "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
    "kp_0": 0x52, "kp_1": 0x53, "kp_2": 0x54, "kp_3": 0x55, "kp_4": 0x56,
    "kp_5": 0x57, "kp_6": 0x58, "kp_7": 0x59, "kp_8": 0x5B, "kp_9": 0x5C,
    "kp_decimal": 0x41, "kp_multiply": 0x43, "kp_add": 0x45, "kp_subtract": 0x4E,
    "kp_divide": 0x4B, "kp_equal": 0x51, "clear": 0x47, "num_lock": 0x47,
    "volumeup": 0x48, "xf86audioraisevolume": 0x48,
    "volumedown": 0x49, "xf86audiolowervolume": 0x49,
    "mute": 0x4A, "xf86audiomute": 0x4A
]

/// xdotool keysym names for punctuation.
private let namedCharacters: [String: Character] = [
    "minus": "-", "equal": "=", "bracketleft": "[", "bracketright": "]", "backslash": "\\",
    "semicolon": ";", "apostrophe": "'", "quoteright": "'", "grave": "`", "quoteleft": "`",
    "comma": ",", "period": ".", "slash": "/",
    "exclam": "!", "at": "@", "numbersign": "#", "dollar": "$", "percent": "%",
    "asciicircum": "^", "ampersand": "&", "asterisk": "*", "parenleft": "(", "parenright": ")",
    "underscore": "_", "plus": "+", "braceleft": "{", "braceright": "}", "bar": "|",
    "colon": ":", "quotedbl": "\"", "less": "<", "greater": ">", "question": "?",
    "asciitilde": "~"
]

private func chordForName(_ name: String) -> KeyChord? {
    if name.count == 1, let character = name.first {
        return chordForCharacter(character)
    }
    let lower = name.lowercased()
    if let code = namedCodes[lower] {
        return KeyChord(key: .code(code))
    }
    if let character = namedCharacters[lower] {
        return chordForCharacter(character)
    }
    return nil
}

private func chordForCharacter(_ character: Character) -> KeyChord? {
    if let code = characterCodes[character] {
        return KeyChord(key: .code(code))
    }
    if character.isUppercase, character.isASCII,
       let code = characterCodes[Character(character.lowercased())] {
        return KeyChord(key: .code(code), modifiers: .shift)
    }
    if let base = shiftedCharacters[character], let code = characterCodes[base] {
        return KeyChord(key: .code(code), modifiers: .shift)
    }
    return nil
}
