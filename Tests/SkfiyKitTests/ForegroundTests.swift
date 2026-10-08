import Testing
@testable import SkfiyKit

struct ForegroundTests {
    /// run_in_front does one of three things; anything else is refused
    /// before the user is asked.
    @Test func runInFrontTakesAKeyAMenuItemOrAClick() throws {
        let parse = { (arguments: [String: Any]) in try FrontRequest.parse(Arguments(arguments)) }
        #expect(try parse(["key": "cmd+b"]) == .key("cmd+b"))
        #expect(try parse(["element_index": "3", "menu_item": "Share > Mail"]) == .menu(index: 3, path: ["Share", "Mail"]))
        #expect(try parse(["element_index": 3, "menu_item": " Share ›Mail› "]) == .menu(index: 3, path: ["Share", "Mail"]))
        #expect(try parse(["element_index": "[7]"]) == .click(index: 7))
        #expect(try parse(["x": 10, "y": 20]) == .click(index: nil))
        // An index wins over x/y, as before.
        #expect(try parse(["element_index": "7", "x": 10, "y": 20]) == .click(index: 7))
        // A menu_item with no item in it counts as none.
        #expect(try parse(["menu_item": " > ", "key": "cmd+z"]) == .key("cmd+z"))
        #expect(FrontRequest.key("cmd+c").key == "cmd+c" && FrontRequest.click(index: 1).key == nil)

        let refused: [[String: Any]] = [
            [:], ["reason": "make it bold"], ["menu_item": "Share"], ["key": "cmd+b", "element_index": "3"], ["key": "cmd+b", "x": 1],
            ["menu_item": "Share", "element_index": "3", "key": "cmd+b"], ["menu_item": "Share", "element_index": "3", "y": 2]
        ]
        for arguments in refused {
            #expect(throws: ToolError.self) { try parse(arguments) }
        }
        #expect(throws: ToolError.self) { try parse(["element_index": "three"]) }
    }
}
