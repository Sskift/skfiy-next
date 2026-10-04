import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

/// The scenario window as accessibility shows it: 700×520 at (100, 100),
/// Save at the top and at the bottom right, Edit in the Profile and Billing boxes.
private let window = CGRect(x: 100, y: 100, width: 700, height: 520)

private func element(_ label: String, _ role: String, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat = 100, _ h: CGFloat = 30,
                     in containers: [String] = []) -> LocatorCandidate {
    LocatorCandidate(label: label, role: role, frame: CGRect(x: window.minX + x, y: window.minY + y, width: w, height: h), containers: containers)
}

private func text(_ label: String, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat = 60, _ h: CGFloat = 16) -> LocatorCandidate {
    LocatorCandidate(label: label, role: "text", frame: CGRect(x: window.minX + x, y: window.minY + y, width: w, height: h), roleKnown: false)
}

private let scenario: [LocatorCandidate] = [
    element("status: ready", "AXStaticText", 20, 12, 420, 22),
    element("Save", "AXButton", 460, 10),
    element("Scenario input", "AXTextField", 20, 82, 320, 26),
    element("Submit", "AXButton", 350, 80),
    element("Edit", "AXButton", 45, 160, 90, 30, in: ["Profile"]),
    element("Edit", "AXButton", 275, 160, 90, 30, in: ["Billing"]),
    element("Cancel", "AXButton", 470, 470),
    element("Save", "AXButton", 580, 470)
]

private func locator(_ object: [String: Any]) throws -> Locator { try Locator(object) }

struct LocatorTests {
    @Test func parsesTargets() throws {
        #expect(try Locator.parse("Save")?.name == "Save")
        #expect(try Locator.parse(nil) == nil)
        let full = try locator(["name": "Save", "role": "Button", "region": "右下角", "within": "Dialog"])
        #expect(full.role == "button" && full.area == .named("bottom-right") && full.within == "Dialog")
        #expect(try locator(["role": "input"]).role == "text field")
        #expect(try locator(["region": [10, 20, 30, 40]]).area == .pixels(CGRect(x: 10, y: 20, width: 30, height: 40)))
        #expect(throws: ToolError.self) { try locator(["name": "Save", "colour": "blue"]) }
        #expect(throws: ToolError.self) { try locator(["role": "spaceship"]) }
        #expect(throws: ToolError.self) { try locator(["region": "upstairs"]) }
        #expect(throws: ToolError.self) { try locator(["region": [1, 2, 0, 4]]) }
        #expect(throws: ToolError.self) { try locator(["name": "  "]) }
        #expect(throws: ToolError.self) { try Locator.parse(42) }
        #expect(full.summary == "button \"Save\" in the bottom-right within \"Dialog\"")
    }

    @Test func namesAreasInThirds() {
        let bounds = CGRect(x: -300, y: 50, width: 300, height: 300)
        #expect(Locator.area(of: CGPoint(x: -10, y: 340), in: bounds) == "bottom-right")
        #expect(Locator.area(of: CGPoint(x: -150, y: 200), in: bounds) == "center")
        #expect(Locator.area(of: CGPoint(x: -290, y: 200), in: bounds) == "left")
        #expect(Locator.point(CGPoint(x: -10, y: 340), isIn: "bottom", of: bounds))
        #expect(Locator.point(CGPoint(x: -10, y: 340), isIn: "right", of: bounds))
        #expect(!Locator.point(CGPoint(x: -150, y: 340), isIn: "bottom-right", of: bounds))
    }

    @Test func twoSaveButtonsAreListedNotGuessed() throws {
        let save = try locator(["name": "Save", "role": "button"])
        let matches = save.matches(scenario, bounds: window)
        #expect(matches.count == 2)
        #expect(save.unique(matches) == nil)
        #expect(Set(matches.map(\.area)) == ["top-right", "bottom-right"])

        let bottomRight = try locator(["name": "Save", "region": "bottom-right"])
        let one = bottomRight.matches(scenario, bounds: window)
        #expect(bottomRight.unique(one)?.candidate.frame.minX == window.minX + 580)
    }

    @Test func aMovedButtonIsFoundWhereItIsNowOrReportedElsewhere() throws {
        // The bottom-right Save moved to the middle of the right side.
        var swapped = scenario
        swapped[7] = element("Save", "AXButton", 460, 305)
        let bottomRight = try locator(["name": "Save", "region": "bottom-right"])
        #expect(bottomRight.matches(swapped, bounds: window).isEmpty)
        let loose = try #require(bottomRight.loosened)
        #expect(Set(loose.matches(swapped, bounds: window).map(\.area)) == ["top-right", "right"])
        // Near Cancel, the moved one is clearly the closest.
        let nearCancel = try locator(["name": "Save", "near": "Cancel"])
        let chosen = try #require(nearCancel.unique(nearCancel.matches(swapped, bounds: window)))
        #expect(chosen.candidate.frame.minY == window.minY + 305)
    }

    @Test func exactBeatsPartialButPartialsAloneAreAmbiguous() throws {
        let candidates = [element("Save", "AXButton", 20, 20), element("Save As…", "AXButton", 140, 20), element("Saved drafts", "AXStaticText", 20, 80)]
        let save = try locator(["name": "save"])
        #expect(save.unique(save.matches(candidates, bounds: window))?.candidate.label == "Save")
        let partial = try locator(["name": "sav"])
        #expect(partial.matches(candidates, bounds: window).count == 3)
        #expect(partial.unique(partial.matches(candidates, bounds: window)) == nil)
        let onlyOne = try locator(["name": "drafts"])
        #expect(onlyOne.unique(onlyOne.matches(candidates, bounds: window))?.candidate.label == "Saved drafts")
    }

    @Test func withinUsesContainersOrTheHeadingAbove() throws {
        let profile = try locator(["name": "Edit", "within": "Profile"])
        #expect(profile.unique(profile.matches(scenario, bounds: window))?.candidate.containers == ["Profile"])

        // Recognized text only: the box titles are the closest text above each Edit.
        // As recognized in the scenario window: each title left of its Edit, not above it.
        let ocr = [text("Profile", 28, 161, 40), text("Billing", 256, 161, 40), text("Edit", 78, 215, 24), text("Edit", 309, 215, 24),
                   text("Scenario input", 30, 120, 80), text("Submit", 380, 120, 40), text("status: ready", 20, 45, 90)]
        let billing = try locator(["name": "Edit", "within": "billing"])
        let match = try #require(billing.unique(billing.matches(ocr, bounds: window)))
        #expect(match.candidate.frame.minX == window.minX + 309)
        #expect(Locator.sectionLabel(of: ocr[2], among: ocr) == "Profile")
    }

    @Test func nearDecidesOnlyWhenClearlyCloser() throws {
        let candidates = [element("OK", "AXButton", 100, 100), element("OK", "AXButton", 500, 100), element("Delete account?", "AXStaticText", 80, 60, 150, 20),
                          element("Rename", "AXStaticText", 300, 60, 100, 20)]
        let nearDelete = try locator(["name": "OK", "near": "Delete account"])
        #expect(nearDelete.unique(nearDelete.matches(candidates, bounds: window))?.candidate.frame.minX == window.minX + 100)
        // Halfway between both: a guess, so nothing.
        let nearRename = try locator(["name": "OK", "near": "Rename"])
        #expect(nearRename.unique(nearRename.matches(candidates, bounds: window)) == nil)
        // A near text that is not there excludes everything.
        #expect(try locator(["name": "OK", "near": "Nope"]).matches(candidates, bounds: window).isEmpty)
    }

    @Test func belowAndRightOfFollowTheLayout() throws {
        let form = [element("Email", "AXStaticText", 20, 100, 60, 20), element("", "AXTextField", 90, 98, 200, 24),
                    element("Password", "AXStaticText", 20, 140, 80, 20), element("", "AXTextField", 110, 138, 200, 24)]
        let email = try locator(["role": "text field", "right_of": "Email"])
        #expect(email.unique(email.matches(form, bounds: window))?.candidate.frame.minY == window.minY + 98)
        let underEmail = try locator(["role": "text field", "below": "Email"])
        #expect(underEmail.unique(underEmail.matches(form, bounds: window))?.candidate.frame.minY == window.minY + 138)
    }

    @Test func roleFiltersKnownKindsOnly() throws {
        let candidates = [element("Save", "AXStaticText", 20, 20), element("Save", "AXButton", 20, 200)]
        let button = try locator(["name": "Save", "role": "button"])
        #expect(button.unique(button.matches(candidates, bounds: window))?.candidate.role == "AXButton")
        // Recognized text has no kind to check: it stays a candidate.
        let ocr = [text("Save", 20, 20), text("Save", 400, 400)]
        #expect(button.matches(ocr, bounds: window).count == 2)
        // Page elements use the page's kinds.
        let page = [LocatorCandidate(label: "Send", role: "submit", frame: CGRect(x: 10, y: 10, width: 60, height: 20), index: 3),
                    LocatorCandidate(label: "Send", role: "link", frame: CGRect(x: 10, y: 50, width: 60, height: 20), index: 4)]
        let pageButton = try locator(["name": "send", "role": "button"])
        #expect(pageButton.unique(pageButton.matches(page, bounds: CGRect(x: 0, y: 0, width: 800, height: 600)))?.candidate.index == 3)
    }

    @Test func regionsInPixelsMapToTheCandidatesSpace() throws {
        // A 2× screenshot of the window: pixel region (1160, 940, 200, 60) is the bottom-right Save.
        let inPixels = try locator(["name": "Save", "region": [1160, 940, 200, 60]])
        let toPoints = { (rect: CGRect) in CGRect(x: window.minX + rect.minX / 2, y: window.minY + rect.minY / 2, width: rect.width / 2, height: rect.height / 2) }
        let match = try #require(inPixels.unique(inPixels.matches(scenario, bounds: window, pixelArea: toPoints)))
        #expect(match.candidate.frame.minX == window.minX + 580)
    }

    @Test func namedAreasExcludeThingsOutsideTheWindow() throws {
        let scrolledAway = [element("Save", "AXButton", 580, 900)]
        #expect(try locator(["name": "Save", "region": "bottom"]).matches(scrolledAway, bounds: window).isEmpty)
        #expect(try locator(["name": "Save"]).matches(scrolledAway, bounds: window).count == 1)
    }

    @Test func piecesOfALineAreAlsoTriedJoined() throws {
        // Recognition split "item: apple" into two pieces on one row.
        let pieces = [text("item:", 40, 100, 34), text("apple", 80, 100, 36), text("item: banana", 40, 116, 80), text("Far away", 400, 100, 60)]
        let all = Locator.joiningRows(pieces)
        #expect(all.map(\.label).contains("item: apple"))
        #expect(!all.map(\.label).contains("apple Far away"))
        let apple = try locator(["name": "item: apple"])
        let match = try #require(apple.unique(apple.matches(all, bounds: window)))
        #expect(match.candidate.frame == pieces[0].frame.union(pieces[1].frame))
        // A single word still matches its own piece exactly.
        let word = try locator(["name": "apple"])
        #expect(word.unique(word.matches(all, bounds: window))?.candidate.label == "apple")
    }
}
