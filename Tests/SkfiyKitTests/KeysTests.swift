import CoreGraphics
import Testing
@testable import SkfiyKit

struct KeysTests {
    @Test func namedKeys() throws {
        #expect(try parseKeyChord("Return") == KeyChord(key: .code(0x24)))
        #expect(try parseKeyChord("return") == KeyChord(key: .code(0x24)))
        #expect(try parseKeyChord("Tab") == KeyChord(key: .code(0x30)))
        #expect(try parseKeyChord("BackSpace") == KeyChord(key: .code(0x33)))
        #expect(try parseKeyChord("Delete") == KeyChord(key: .code(0x75)))
        #expect(try parseKeyChord("Up") == KeyChord(key: .code(0x7E)))
        #expect(try parseKeyChord("Page_Down") == KeyChord(key: .code(0x79)))
        #expect(try parseKeyChord("Next") == KeyChord(key: .code(0x79)))
        #expect(try parseKeyChord("F5") == KeyChord(key: .code(0x60)))
        #expect(try parseKeyChord("KP_0") == KeyChord(key: .code(0x52)))
        #expect(try parseKeyChord("space") == KeyChord(key: .code(0x31)))
    }

    @Test func characters() throws {
        #expect(try parseKeyChord("a") == KeyChord(key: .code(0x00)))
        #expect(try parseKeyChord("A") == KeyChord(key: .code(0x00), modifiers: .shift))
        #expect(try parseKeyChord("5") == KeyChord(key: .code(0x17)))
        #expect(try parseKeyChord("?") == KeyChord(key: .code(0x2C), modifiers: .shift))
        #expect(try parseKeyChord("minus") == KeyChord(key: .code(0x1B)))
        #expect(try parseKeyChord("comma") == KeyChord(key: .code(0x2B)))
        #expect(try parseKeyChord("é") == KeyChord(key: .character("é")))
    }

    @Test func combinations() throws {
        #expect(try parseKeyChord("super+c") == KeyChord(key: .code(0x08), modifiers: .command))
        #expect(try parseKeyChord("cmd+shift+t") == KeyChord(key: .code(0x11), modifiers: [.command, .shift]))
        #expect(try parseKeyChord("ctrl+alt+Delete") == KeyChord(key: .code(0x75), modifiers: [.control, .option]))
        #expect(try parseKeyChord("alt+Tab") == KeyChord(key: .code(0x30), modifiers: .option))
        #expect(try parseKeyChord("Command+Left") == KeyChord(key: .code(0x7B), modifiers: .command))
        #expect(try parseKeyChord(" ctrl + e ") == KeyChord(key: .code(0x0E), modifiers: .control))
    }

    @Test func plusKey() throws {
        #expect(try parseKeyChord("+") == KeyChord(key: .code(0x18), modifiers: .shift))
        #expect(try parseKeyChord("cmd++") == KeyChord(key: .code(0x18), modifiers: [.command, .shift]))
        #expect(try parseKeyChord("ctrl+plus") == KeyChord(key: .code(0x18), modifiers: [.control, .shift]))
    }

    @Test func modifierAlone() throws {
        #expect(try parseKeyChord("shift") == KeyChord(key: .code(0x38)))
        #expect(try parseKeyChord("cmd+shift") == KeyChord(key: .code(0x38), modifiers: .command))
    }

    @Test func errors() {
        #expect(throws: KeyParseError.self) { try parseKeyChord("") }
        #expect(throws: KeyParseError.self) { try parseKeyChord("hyper+a") }
        #expect(throws: KeyParseError.self) { try parseKeyChord("NotAKey") }
        #expect(throws: KeyParseError.self) { try parseKeyChord("cmd+é") }
        #expect(throws: KeyParseError.self) { try parseKeyChord("cmd+") }
    }

    @Test func modifierList() throws {
        #expect(try parseModifierList(nil) == [])
        #expect(try parseModifierList("cmd") == .command)
        #expect(try parseModifierList("shift+alt") == [.shift, .option])
        #expect(throws: KeyParseError.self) { try parseModifierList("cmd+a") }
    }

    @Test func eventFlags() {
        let modifiers: Modifiers = [.command, .shift]
        #expect(modifiers.eventFlags == [.maskCommand, .maskShift])
    }

    @Test func menuShortcuts() {
        #expect(menuShortcut(char: "S", modifiers: 0) == "cmd+s")
        #expect(menuShortcut(char: "S", modifiers: 1) == "shift+cmd+s")
        #expect(menuShortcut(char: "F", modifiers: 2 | 4) == "ctrl+alt+cmd+f")
        #expect(menuShortcut(char: "Q", modifiers: 8 | 4) == "ctrl+q")
        #expect(menuShortcut(char: "+", modifiers: 0) == "cmd+plus")
        // Every rendered shortcut must round-trip through press_key.
        for shortcut in ["cmd+s", "shift+cmd+s", "ctrl+alt+cmd+f", "ctrl+q", "cmd+plus", "cmd+,"] {
            #expect(throws: Never.self) { try parseKeyChord(shortcut) }
        }
    }

    @Test func textProducingKeys() throws {
        #expect(try parseKeyChord("comma").producesText)
        #expect(try parseKeyChord("A").producesText)
        #expect(try parseKeyChord("space").producesText)
        #expect(try parseKeyChord("é").producesText)
        #expect(try !parseKeyChord("cmd+a").producesText)
        #expect(try !parseKeyChord("ctrl+e").producesText)
        #expect(try !parseKeyChord("Return").producesText)
        #expect(try !parseKeyChord("Up").producesText)
    }

    @Test func typedTextFollowsTheUSLayout() throws {
        #expect(try parseKeyChord("comma").typedText == ",")
        #expect(try parseKeyChord("shift+comma").typedText == "<")
        #expect(try parseKeyChord("A").typedText == "A")
        #expect(try parseKeyChord("shift+2").typedText == "@")
        #expect(try parseKeyChord("KP_5").typedText == "5")
        #expect(try parseKeyChord("space").typedText == " ")
        #expect(try parseKeyChord("é").typedText == "é")
        #expect(try parseKeyChord("alt+e").typedText == nil)
        #expect(try parseKeyChord("cmd+c").typedText == nil)
        #expect(try parseKeyChord("Return").typedText == nil)
    }
}
