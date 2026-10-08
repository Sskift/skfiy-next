import CoreGraphics
import Foundation

/// A description of a control, resolved against the current UI each time:
/// its name, kind, where in the window it is, what it sits in or near.
struct Locator: Equatable {
    enum Area: Equatable {
        case named(String)      // top-left … bottom-right, center
        case pixels(CGRect)     // in pixels of the latest screenshot
    }

    var name: String?
    var role: String?
    var area: Area?
    /// A container (group, box, section, form) whose label contains this text.
    var within: String?
    /// Closest to a text; below / right of a text.
    var near: String?
    var below: String?
    var rightOf: String?

    static let areaNames: [String: String] = [
        "top-left": "top-left", "top left": "top-left", "左上": "top-left", "左上角": "top-left",
        "top": "top", "上": "top", "顶部": "top", "上方": "top",
        "top-right": "top-right", "top right": "top-right", "右上": "top-right", "右上角": "top-right",
        "left": "left", "左": "left", "左侧": "left", "左边": "left",
        "center": "center", "middle": "center", "中间": "center", "中央": "center",
        "right": "right", "右": "right", "右侧": "right", "右边": "right",
        "bottom-left": "bottom-left", "bottom left": "bottom-left", "左下": "bottom-left", "左下角": "bottom-left",
        "bottom": "bottom", "下": "bottom", "底部": "bottom", "下方": "bottom",
        "bottom-right": "bottom-right", "bottom right": "bottom-right", "右下": "bottom-right", "右下角": "bottom-right"
    ]

    /// Text that labels things rather than being a control.
    static let textRoles: Set<String> = ["AXStaticText", "AXHeading", "heading", "statictext"]

    /// Kinds a model may ask for, and the roles that count as each.
    static let roleAliases: [String: Set<String>] = [
        "button": ["AXButton", "button", "submit", "reset"],
        "text field": ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField", "text", "textarea", "search", "email",
                       "password", "url", "tel", "number", "textbox", "searchbox", "combobox", "editable"],
        "checkbox": ["AXCheckBox", "checkbox", "switch"],
        "radio": ["AXRadioButton", "radio"],
        "link": ["AXLink", "link"],
        "menu item": ["AXMenuItem", "AXMenuBarItem", "menuitem"],
        "pop-up": ["AXPopUpButton", "AXMenuButton", "select", "listbox"],
        "tab": ["AXTab", "AXRadioButton", "tab"],
        "row": ["AXRow", "AXCell", "AXOutlineRow", "row", "option", "treeitem", "listitem"],
        "slider": ["AXSlider", "AXIncrementor", "range", "slider"],
        "text": textRoles,
        "image": ["AXImage", "img", "image"],
        "file input": ["file"]
    ]

    var isEmpty: Bool { name == nil && role == nil && area == nil && within == nil && near == nil && below == nil && rightOf == nil }

    init() {}

    init(_ object: [String: Any]) throws {
        let text = { (key: String) -> String? in
            (object[key] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        let known: Set<String> = ["name", "role", "region", "within", "near", "below", "right_of"]
        if let unknown = object.keys.first(where: { !known.contains($0) }) {
            throw ToolError("A target has no \"\(unknown)\"; use name, role, region, within, near, below, right_of.")
        }
        name = text("name")
        if let role = text("role") {
            let key = Self.normalizedRole(role)
            guard key != nil else {
                throw ToolError("role \(quote(role, limit: 30)) is not one of: \(Self.roleAliases.keys.sorted().joined(separator: ", ")).")
            }
            self.role = key
        }
        if let region = object["region"] {
            if let named = region as? String {
                guard let area = Self.areaNames[named.lowercased().trimmingCharacters(in: .whitespaces)] else {
                    throw ToolError("region is one of top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right (or 右下角…), or [x, y, width, height] in screenshot pixels.")
                }
                self.area = .named(area)
            } else if let values = region as? [Any], values.count == 4 {
                let numbers = values.compactMap { ($0 as? NSNumber)?.doubleValue }
                guard numbers.count == 4, numbers.allSatisfy(\.isFinite), numbers[2] > 0, numbers[3] > 0 else {
                    throw ToolError("region [x, y, width, height] needs four positive numbers in screenshot pixels.")
                }
                area = .pixels(CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3]))
            } else {
                throw ToolError("region is a name such as bottom-right, or [x, y, width, height].")
            }
        }
        within = text("within")
        near = text("near")
        below = text("below")
        rightOf = text("right_of")
        guard !isEmpty else { throw ToolError("Describe the target with at least one of name, role, region, within, near, below, right_of.") }
    }

    /// A target argument: an object, or just a name.
    static func parse(_ value: Any?) throws -> Locator? {
        guard let value, !(value is NSNull) else { return nil }
        if let name = value as? String { return try Locator(["name": name]) }
        guard let object = value as? [String: Any] else {
            throw ToolError("target is an object such as {\"name\": \"Save\", \"role\": \"button\", \"region\": \"bottom-right\"}, or a name.")
        }
        return try Locator(object)
    }

    static func normalizedRole(_ role: String) -> String? {
        let key = role.lowercased().replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        let synonyms = ["textfield": "text field", "input": "text field", "field": "text field", "check box": "checkbox", "menuitem": "menu item",
                        "popup": "pop-up", "pop up": "pop-up", "dropdown": "pop-up", "select": "pop-up", "label": "text", "static text": "text",
                        "按钮": "button", "输入框": "text field", "文本框": "text field", "复选框": "checkbox", "链接": "link", "标签页": "tab"]
        let resolved = synonyms[key] ?? key
        return roleAliases[resolved] != nil ? resolved : nil
    }

    var summary: String {
        var parts: [String] = []
        if let role { parts.append(role) }
        if let name { parts.append(quote(name, limit: 40)) }
        switch area {
        case .named(let value)?: parts.append("in the \(value)")
        case .pixels(let rect)?: parts.append("inside x=\(Int(rect.minX)) y=\(Int(rect.minY)) w=\(Int(rect.width)) h=\(Int(rect.height))")
        case nil: break
        }
        if let within { parts.append("within \(quote(within, limit: 30))") }
        if let near { parts.append("near \(quote(near, limit: 30))") }
        if let below { parts.append("below \(quote(below, limit: 30))") }
        if let rightOf { parts.append("right of \(quote(rightOf, limit: 30))") }
        return parts.joined(separator: " ")
    }
}

/// Something on screen a locator may mean: an AX element, a DOM element, or
/// recognized text. Frames are in the same space as `bounds` (screen points,
/// or viewport pixels for a tab).
struct LocatorCandidate: Equatable {
    var label: String
    var role: String
    var frame: CGRect
    /// Labels of the containers it sits in, innermost first.
    var containers: [String] = []
    var index: Int?
    /// True when the role is known (AX, DOM); false for recognized text.
    var roleKnown = true
}

struct LocatorMatch: Equatable {
    let candidate: LocatorCandidate
    /// 1 exact, 0.8 starts or ends with the name, 0.6 contains it; 0.5 without a name.
    let nameScore: Double
    /// To the closest `near` text, in the candidates' units.
    let distance: Double?
    let area: String
}

extension Locator {
    /// The area a point is in: thirds of the bounds, each way.
    static func area(of point: CGPoint, in bounds: CGRect) -> String {
        let column = point.x < bounds.minX + bounds.width / 3 ? "left" : point.x > bounds.minX + bounds.width * 2 / 3 ? "right" : "center"
        let row = point.y < bounds.minY + bounds.height / 3 ? "top" : point.y > bounds.minY + bounds.height * 2 / 3 ? "bottom" : "middle"
        switch (row, column) {
        case ("middle", "center"): return "center"
        case ("middle", _): return column
        case (_, "center"): return row
        default: return "\(row)-\(column)"
        }
    }

    /// Whether a point is in a named area: "bottom-right" is the bottom-right
    /// third each way; "bottom" the bottom third; "right" the right third.
    static func point(_ point: CGPoint, isIn named: String, of bounds: CGRect) -> Bool {
        let x = (point.x - bounds.minX) / max(bounds.width, 1), y = (point.y - bounds.minY) / max(bounds.height, 1)
        let left = x < 1.0 / 3, right = x > 2.0 / 3, top = y < 1.0 / 3, bottom = y > 2.0 / 3
        switch named {
        case "top-left": return top && left
        case "top": return top
        case "top-right": return top && right
        case "left": return left
        case "center": return !left && !right && !top && !bottom
        case "right": return right
        case "bottom-left": return bottom && left
        case "bottom": return bottom
        case "bottom-right": return bottom && right
        default: return false
        }
    }

    static func textScore(_ label: String, _ wanted: String) -> Double? {
        let a = TextMatch.normalized(label), b = TextMatch.normalized(wanted)
        guard !b.isEmpty, !a.isEmpty else { return nil }
        if a == b { return 1 }
        if a.hasPrefix(b) || a.hasSuffix(b) { return 0.8 }
        if TextMatch.contains(label, wanted) { return 0.6 }
        return nil
    }

    /// Text a reader would take for the heading of the section a candidate
    /// is in: the closest text above it, in or near its column (a box title
    /// sits at the box's left edge, left of a centered button label). Used
    /// for `within` where there is no container to ask (recognized text,
    /// flat layouts).
    static func sectionLabel(of candidate: LocatorCandidate, among candidates: [LocatorCandidate]) -> String? {
        let frame = candidate.frame
        let reach = max(80, frame.width * 2)
        let gap = { (other: CGRect) in max(0, other.minX - frame.maxX, frame.minX - other.maxX) }
        let cost = { (other: CGRect) in frame.minY - other.maxY + 2 * gap(other) }
        return candidates.filter { other in
            other != candidate && (!other.roleKnown || textRoles.contains(other.role))
                && other.frame.maxY <= frame.minY + 2 && gap(other.frame) <= reach
        }.min { cost($0.frame) < cost($1.frame) }?.label
    }

    /// Recognized text sometimes comes back in pieces ("item:" and "apple"):
    /// neighbouring pieces on one row are offered joined as well, up to three.
    static func joiningRows(_ pieces: [LocatorCandidate]) -> [LocatorCandidate] {
        let text = pieces.filter { !$0.roleKnown }
        var rows: [[LocatorCandidate]] = []
        for piece in text.sorted(by: { $0.frame.midY < $1.frame.midY }) {
            if let first = rows.last?.first, abs(piece.frame.midY - first.frame.midY) <= first.frame.height / 2 {
                rows[rows.count - 1].append(piece)
            } else {
                rows.append([piece])
            }
        }
        var joined: [LocatorCandidate] = []
        for row in rows.map({ $0.sorted { $0.frame.minX < $1.frame.minX } }) where row.count > 1 {
            for start in row.indices {
                var run = [row[start]]
                for next in row[(start + 1)...] {
                    guard run.count < 3, next.frame.minX - run.last!.frame.maxX <= 2 * max(next.frame.height, run.last!.frame.height) else { break }
                    run.append(next)
                    joined.append(LocatorCandidate(label: run.map(\.label).joined(separator: " "), role: "text",
                                                   frame: run.dropFirst().reduce(run[0].frame) { $0.union($1.frame) }, roleKnown: false))
                }
            }
        }
        return pieces + joined
    }

    /// The candidates this locator describes, best first. `bounds` is the
    /// window (or viewport) the areas refer to; `pixelArea` converts a
    /// screenshot-pixel region into the candidates' space.
    func matches(_ candidates: [LocatorCandidate], bounds: CGRect, pixelArea: ((CGRect) -> CGRect)? = nil) -> [LocatorMatch] {
        let anchors = { (text: String) in candidates.filter { Self.textScore($0.label, text) != nil } }
        let nearAnchors = near.map(anchors) ?? []
        let belowAnchors = below.map(anchors) ?? []
        let rightAnchors = rightOf.map(anchors) ?? []
        var matches: [LocatorMatch] = []
        for candidate in candidates {
            let center = CGPoint(x: candidate.frame.midX, y: candidate.frame.midY)
            var nameScore = 0.5
            if let name {
                guard let score = Self.textScore(candidate.label, name) else { continue }
                nameScore = score
            }
            if let role, candidate.roleKnown, Self.roleAliases[role]?.contains(candidate.role) != true { continue }
            switch area {
            case .named(let value)?: guard bounds.contains(center), Self.point(center, isIn: value, of: bounds) else { continue }
            case .pixels(let rect)?: guard (pixelArea?(rect) ?? rect).contains(center) else { continue }
            case nil: break
            }
            if let within {
                let sections = candidate.containers + [Self.sectionLabel(of: candidate, among: candidates)].compactMap { $0 }
                guard sections.contains(where: { Self.textScore($0, within) != nil }) else { continue }
            }
            // Relations to other text: the anchor is never the candidate itself.
            let others = { (list: [LocatorCandidate]) in list.filter { $0 != candidate } }
            var distance: Double?
            if near != nil {
                guard let closest = others(nearAnchors).map({ Double(hypot($0.frame.midX - center.x, $0.frame.midY - center.y)) }).min() else { continue }
                distance = closest
            }
            if below != nil {
                guard others(belowAnchors).contains(where: { $0.frame.maxY <= candidate.frame.minY + 2 && abs($0.frame.midX - center.x) < max(bounds.width / 3, $0.frame.width) }) else { continue }
            }
            if rightOf != nil {
                guard others(rightAnchors).contains(where: { $0.frame.maxX <= candidate.frame.minX + 2 && abs($0.frame.midY - center.y) < max($0.frame.height, 12) }) else { continue }
            }
            matches.append(LocatorMatch(candidate: candidate, nameScore: nameScore, distance: distance, area: Self.area(of: center, in: bounds)))
        }
        return matches.sorted {
            if $0.nameScore != $1.nameScore { return $0.nameScore > $1.nameScore }
            return ($0.distance ?? 0) < ($1.distance ?? 0)
        }
    }

    /// The one match meant, or nil when there is none or a choice would be a
    /// guess. An exact name beats partial ones ("Save" over "Save As…"); among
    /// equals, `near` decides only when one is clearly closest.
    func unique(_ matches: [LocatorMatch]) -> LocatorMatch? {
        guard let best = matches.first else { return nil }
        let equals = best.nameScore >= 1 ? matches.filter { $0.nameScore >= 1 } : matches
        // A control's own label shows as text with the same words ("Email"
        // next to its field): that text is not a second thing to act on.
        let controls = equals.filter { $0.candidate.roleKnown && !Self.textRoles.contains($0.candidate.role) }
        if controls.count == 1, let control = controls.first,
           equals.allSatisfy({ $0 == control || ($0.candidate.roleKnown && Self.textRoles.contains($0.candidate.role)
                                                && TextMatch.normalized($0.candidate.label) == TextMatch.normalized(control.candidate.label)) }) {
            return control
        }
        guard equals.count > 1 else { return best }
        guard near != nil, let first = equals[0].distance, let second = equals[1].distance else { return nil }
        return first <= second * 0.6 && second - first >= 10 ? best : nil
    }

    /// Without the parts that narrow by position or relation: what the name
    /// and kind alone match, to say where those are when nothing matched.
    var loosened: Locator? {
        guard area != nil || within != nil || near != nil || below != nil || rightOf != nil, name != nil || role != nil else { return nil }
        var loose = Locator()
        loose.name = name
        loose.role = role
        return loose
    }
}
