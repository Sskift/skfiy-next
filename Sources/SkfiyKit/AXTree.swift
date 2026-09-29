import ApplicationServices
import Foundation

/// The attributes of one accessibility element that matter for rendering.
public struct NodeInfo: Equatable, Sendable {
    public var role: String
    public var subrole: String?
    public var title: String?
    public var description: String?
    public var value: String?
    public var placeholder: String?
    public var enabled: Bool?
    public var focused: Bool?
    public var selected: Bool?
    public var frame: CGRect?

    public init(
        role: String,
        subrole: String? = nil,
        title: String? = nil,
        description: String? = nil,
        value: String? = nil,
        placeholder: String? = nil,
        enabled: Bool? = nil,
        focused: Bool? = nil,
        selected: Bool? = nil,
        frame: CGRect? = nil
    ) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.value = value
        self.placeholder = placeholder
        self.enabled = enabled
        self.focused = focused
        self.selected = selected
        self.frame = frame
    }

    /// The human-facing name: title, then description, then static text value.
    public var label: String? {
        if let title = nonEmpty(title) { return title }
        if let description = nonEmpty(description) { return description }
        if role == "AXStaticText" || role == "AXHeading" { return nonEmpty(value) }
        return nil
    }
}

/// A snapshot tree node. `ref` indexes the snapshot's element table.
public struct UINode: Sendable {
    public var info: NodeInfo
    public var children: [UINode]
    public var ref: Int

    public init(info: NodeInfo, children: [UINode] = [], ref: Int) {
        self.info = info
        self.children = children
        self.ref = ref
    }
}

public struct NodeDetails: Sendable {
    public var actions: [String]
    public var settable: Bool
    /// Vertical scroll position of a scroll area, 0 (top) to 1 (bottom).
    public var verticalScroll: Double?

    public init(actions: [String] = [], settable: Bool = false, verticalScroll: Double? = nil) {
        self.actions = actions
        self.settable = settable
        self.verticalScroll = verticalScroll
    }
}

/// Renders snapshot trees as compact indented text, assigning each printed
/// element a sequential index. Pure: element details come from a callback so
/// it can run against fixtures.
public struct TreeRenderer {
    public var maxLines = 1_200
    public var maxCharacters = 60_000
    public var valueLimit = 240
    public var focusedValueLimit = 4_000
    public var maxIndent = 16

    public private(set) var lines: [String] = []
    /// Printed index -> snapshot ref.
    public private(set) var indexToRef: [Int] = []
    public private(set) var truncated = false
    private var characters = 0
    private let details: (Int, NodeInfo) -> NodeDetails

    public init(details: @escaping (Int, NodeInfo) -> NodeDetails) {
        self.details = details
    }

    public var text: String { lines.joined(separator: "\n") }

    public mutating func appendLine(_ line: String) {
        guard !isFull else {
            truncated = true
            return
        }
        lines.append(line)
        characters += line.count + 1
    }

    private var isFull: Bool {
        lines.count >= maxLines || characters >= maxCharacters
    }

    /// Assigns an index to `ref` without printing a tree line.
    public mutating func register(_ ref: Int) -> Int {
        indexToRef.append(ref)
        return indexToRef.count - 1
    }

    public mutating func render(_ node: UINode, depth: Int = 0, clip: CGRect? = nil) {
        render(node, depth: depth, clip: clip, parentLabel: nil, inRow: false)
    }

    private mutating func render(_ node: UINode, depth: Int, clip: CGRect?, parentLabel: String?, inRow: Bool) {
        if isFull {
            truncated = true
            return
        }
        var info = node.info
        if Self.prunedRoles.contains(info.role) {
            return
        }
        if let clip, let frame = info.frame, frame.width >= 1, frame.height >= 1,
           !frame.insetBy(dx: -2, dy: -2).intersects(clip), !Self.clipExemptRoles.contains(info.role) {
            return
        }
        // A static text that merely repeats its parent's label adds nothing.
        if info.role == "AXStaticText", node.children.isEmpty, let parentLabel,
           info.label == parentLabel {
            return
        }

        // Table and outline rows print as one line summarizing their cells; inside
        // a row only controls print (cells flatten, texts are in the summary).
        let isRow = info.role == "AXRow"
        if isRow, info.label == nil, let summary = Self.rowSummary(node) {
            info.title = summary
        }
        // A container repeating its parent's label (Chrome's window group) is noise.
        let redundantContainer = Self.containerRoles.contains(info.role) && info.focused != true
            && info.label != nil && info.label.map(visibleText) == parentLabel.map(visibleText)
        let hiddenInRow = inRow && info.focused != true && (
            info.role == "AXCell" || info.role == "AXStaticText" || info.role == "AXTextField"
                || info.role == "AXImage" || Self.containerRoles.contains(info.role)
        )

        guard !hiddenInRow, !redundantContainer, shouldPrint(info) else {
            for child in node.children {
                render(child, depth: depth, clip: clip, parentLabel: parentLabel, inRow: inRow)
            }
            return
        }

        let index = register(node.ref)
        appendLine(line(for: info, index: index, depth: depth, details: details(node.ref, info)))
        for child in node.children {
            render(child, depth: depth + 1, clip: clip, parentLabel: info.label, inRow: inRow || isRow)
        }
    }

    /// "Name | Date | Size" from a row's static texts and text-field values.
    static func rowSummary(_ row: UINode) -> String? {
        var parts: [String] = []
        func collect(_ node: UINode) {
            guard parts.count < 8 else { return }
            let info = node.info
            if info.role == "AXStaticText" || info.role == "AXTextField" || info.role == "AXHeading",
               let text = nonEmpty(info.role == "AXTextField" ? info.value : info.label) {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if parts.last != trimmed {
                    parts.append(trimmed)
                }
                return
            }
            for child in node.children {
                collect(child)
            }
        }
        for child in row.children {
            collect(child)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " | ")
    }

    func shouldPrint(_ info: NodeInfo) -> Bool {
        if info.focused == true {
            return true
        }
        if let frame = info.frame, frame.width < 1 || frame.height < 1,
           !Self.clipExemptRoles.contains(info.role) {
            return false
        }
        let hasLabel = info.label != nil
        let hasValue = nonEmpty(info.value) != nil
        if Self.containerRoles.contains(info.role) {
            return hasLabel || hasValue
        }
        if info.role == "AXStaticText" || info.role == "AXImage" {
            return hasLabel
        }
        return true
    }

    public func line(for info: NodeInfo, index: Int, depth: Int, details: NodeDetails) -> String {
        var parts: [String] = []
        parts.append(String(repeating: "  ", count: min(depth, maxIndent)) + "[\(index)] " + Self.displayRole(info))

        let label = info.label
        if let label {
            parts.append(quote(label, limit: 160))
        }
        if let title = nonEmpty(info.title), let description = nonEmpty(info.description), title != description {
            parts.append("desc=" + quote(description, limit: 160))
        }

        let isToggle = Self.toggleRoles.contains(info.role) || info.subrole == "AXSwitch"
        if isToggle, let value = info.value {
            if value == "1" { parts.append("checked") }
            else if value == "0" { parts.append("unchecked") }
            else if value == "2" { parts.append("mixed") }
        } else if info.role != "AXStaticText", info.role != "AXHeading", let value = nonEmpty(info.value), value != label {
            let limit = info.focused == true ? focusedValueLimit : valueLimit
            parts.append("value=" + quote(value, limit: limit))
        } else if nonEmpty(info.value) == nil, let placeholder = nonEmpty(info.placeholder) {
            parts.append("placeholder=" + quote(placeholder, limit: 120))
        }

        if info.focused == true { parts.append("focused") }
        if info.selected == true { parts.append("selected") }
        if info.enabled == false { parts.append("disabled") }
        if details.settable { parts.append("settable") }
        if let position = details.verticalScroll {
            parts.append("vscroll=\(Int((min(max(position, 0), 1) * 100).rounded()))%")
        }

        let actions = details.actions
            .filter { !Self.implicitActions.contains($0) }
            .map(Self.actionDisplayName)
            .filter { !Self.noiseActions.contains($0) }
        if !actions.isEmpty {
            parts.append("actions=[" + actions.joined(separator: ", ") + "]")
        }
        return parts.joined(separator: " ")
    }

    /// "AXIncrement" → "Increment"; custom actions arrive as
    /// "Name:Move next\nTarget:0x0\nSelector:(null)" → "Move next".
    public static func actionDisplayName(_ name: String) -> String {
        if name.hasPrefix("Name:") {
            return String(name.dropFirst(5).prefix { $0 != "\n" })
        }
        return name.hasPrefix("AX") ? String(name.dropFirst(2)) : name
    }

    /// Toolbar customization actions present on every toolbar item.
    static let noiseActions: Set<String> = ["Move previous", "Move next", "Remove from toolbar"]

    static func displayRole(_ info: NodeInfo) -> String {
        let role = info.role.hasPrefix("AX") ? String(info.role.dropFirst(2)) : info.role
        guard let subrole = info.subrole, !ignoredSubroles.contains(subrole) else {
            return role
        }
        return role + "(" + (subrole.hasPrefix("AX") ? String(subrole.dropFirst(2)) : subrole) + ")"
    }

    /// Unlabeled containers are flattened: their children render in their place.
    static let containerRoles: Set<String> = [
        "AXGroup", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXUnknown",
        "AXGenericElement", "AXList", "AXSection", "AXLandmarkMain", "AXDocument"
    ]
    /// Chrome and noise roles skipped with their subtree.
    static let prunedRoles: Set<String> = [
        "AXScrollBar", "AXValueIndicator", "AXSplitter", "AXGrowArea", "AXColumn", "AXMatte"
    ]
    static let clipExemptRoles: Set<String> = [
        "AXWindow", "AXSheet", "AXMenu", "AXMenuItem", "AXMenuBar", "AXMenuBarItem"
    ]
    static let toggleRoles: Set<String> = ["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle"]
    static let ignoredSubroles: Set<String> = [
        "AXStandardWindow", "AXUnknown", "AXTextAttachment", "AXContentList", "AXSectionListSubrole"
    ]
    /// Actions implied by the role or available to every element.
    static let implicitActions: Set<String> = [
        "AXPress", "AXShowMenu", "AXRaise", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI",
        "AXScrollLeftByPage", "AXScrollRightByPage", "AXScrollUpByPage", "AXScrollDownByPage"
    ]
}

func nonEmpty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : value
}

/// Drops invisible format characters (zero-width spaces, joiners, bidi
/// marks), which some sites embed as watermarks.
func visibleText(_ value: String) -> String {
    var scalars = String.UnicodeScalarView()
    scalars.append(contentsOf: value.unicodeScalars.filter { $0.properties.generalCategory != .format })
    return String(scalars)
}

func quote(_ value: String, limit: Int) -> String {
    var text = visibleText(value)
    if text.count > limit {
        text = String(text.prefix(limit)) + "…"
    }
    text = text
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\r\n", with: "\\n")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\n")
        .replacingOccurrences(of: "\t", with: "\\t")
    return "\"" + text + "\""
}

/// Walks a live accessibility hierarchy into `UINode`s, collecting the
/// underlying elements so printed indices can be resolved later.
final class AXTreeBuilder {
    static let attributes: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
        kAXValueAttribute, "AXPlaceholderValue", kAXEnabledAttribute, kAXFocusedAttribute,
        kAXSelectedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
        "AXVisibleChildren", kAXVisibleRowsAttribute
    ]

    private(set) var elements: [AXUIElement] = []
    private(set) var truncated = false
    private var visited = 0
    let maxNodes: Int
    let maxDepth: Int
    let deadline: Date

    init(maxNodes: Int = 4_000, maxDepth: Int = 60, timeBudget: TimeInterval = 4) {
        self.maxNodes = maxNodes
        self.maxDepth = maxDepth
        self.deadline = Date().addingTimeInterval(timeBudget)
    }

    func add(_ element: AXUIElement) -> Int {
        elements.append(element)
        return elements.count - 1
    }

    /// Reads one element without its children.
    func info(_ element: AXUIElement) -> (NodeInfo, [AXUIElement]) {
        let values = element.multipleValues(Self.attributes)
        let info = NodeInfo(
            role: values[kAXRoleAttribute].flatMap(axString) ?? "AXUnknown",
            subrole: values[kAXSubroleAttribute].flatMap(axString),
            title: values[kAXTitleAttribute].flatMap(axString),
            description: values[kAXDescriptionAttribute].flatMap(axString),
            value: values[kAXValueAttribute].flatMap(axDisplayValue).map { String($0.prefix(20_000)) },
            placeholder: values["AXPlaceholderValue"].flatMap(axString),
            enabled: (values[kAXEnabledAttribute] as? NSNumber)?.boolValue,
            focused: (values[kAXFocusedAttribute] as? NSNumber)?.boolValue,
            selected: (values[kAXSelectedAttribute] as? NSNumber)?.boolValue,
            frame: axFrame(position: values[kAXPositionAttribute], size: values[kAXSizeAttribute])
        )
        let rows = (values[kAXVisibleRowsAttribute] as? [AXUIElement]) ?? []
        let visible = (values["AXVisibleChildren"] as? [AXUIElement]) ?? []
        let children = (values[kAXChildrenAttribute] as? [AXUIElement]) ?? []
        return (info, !rows.isEmpty ? rows : (!visible.isEmpty ? visible : children))
    }

    func build(_ element: AXUIElement, clip: CGRect?, depth: Int = 0, maxDepth: Int? = nil) -> UINode? {
        guard visited < maxNodes, Date() < deadline else {
            truncated = true
            return nil
        }
        visited += 1
        let (info, children) = info(element)
        if let clip, let frame = info.frame, frame.width >= 1, frame.height >= 1,
           !frame.insetBy(dx: -2, dy: -2).intersects(clip),
           !TreeRenderer.clipExemptRoles.contains(info.role) {
            return nil
        }
        if TreeRenderer.prunedRoles.contains(info.role) {
            return nil
        }
        let ref = add(element)
        var node = UINode(info: info, ref: ref)
        // Content scrolled out of a scroll area's viewport is not visible, even
        // when it still lies inside the window.
        var childClip = clip
        if info.role == "AXScrollArea", let frame = info.frame, frame.width >= 1, frame.height >= 1 {
            let narrowed = clip.map { $0.intersection(frame) } ?? frame
            childClip = narrowed.isNull ? frame : narrowed
        }
        if depth < (maxDepth ?? self.maxDepth) {
            for child in children {
                if let built = build(child, clip: childClip, depth: depth + 1, maxDepth: maxDepth) {
                    node.children.append(built)
                }
            }
        }
        return node
    }
}

/// Elements in a window besides its frame: title-bar buttons (and whatever
/// hangs off them), the title text and unlabelled containers do not count.
/// Custom-drawn UIs and embedded web views that publish no accessibility
/// (CEF, some WKWebView hosts) come out at zero.
func contentElementCount(_ node: UINode, windowTitle: String? = nil) -> Int {
    let chrome: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]
    let containers: Set<String> = ["AXGroup", "AXUnknown", "AXSplitter", "AXLayoutArea", "AXScrollArea"]
    let windowTitle = windowTitle ?? node.info.title
    var count = 0
    for child in node.children {
        let info = child.info
        if chrome.contains(info.subrole ?? "") { continue }
        count += contentElementCount(child, windowTitle: windowTitle)
        let labels = [info.title, info.description, info.value].compactMap { $0 }.filter { !$0.isEmpty }
        if labels.isEmpty && containers.contains(info.role) { continue }
        if info.role == "AXStaticText" && !labels.isEmpty && labels.allSatisfy({ $0 == windowTitle }) { continue }
        count += 1
    }
    return count
}

/// Apps such as Finder report AXFocused on many elements at once; only the
/// app's actual focused element is marked.
func markFocus(_ node: inout UINode, focusedRef: Int?) {
    node.info.focused = node.ref == focusedRef
    for index in node.children.indices {
        markFocus(&node.children[index], focusedRef: focusedRef)
    }
}

/// The lines of a rendered tree that contain `query` (case- and
/// width-insensitive), each with the lines of its ancestors for context.
public func filterTree(_ lines: [String], matching query: String) -> (lines: [String], matches: Int) {
    let needle = normalizeAppName(query)
    let indent = { (line: String) in line.prefix { $0 == " " }.count }
    var keep = Set<Int>()
    var matches = 0
    for (index, line) in lines.enumerated() where normalizeAppName(line).contains(needle) {
        matches += 1
        keep.insert(index)
        var depth = indent(line)
        var previous = index - 1
        while previous >= 0, depth > 0 {
            let level = indent(lines[previous])
            if level < depth {
                keep.insert(previous)
                depth = level
            }
            previous -= 1
        }
    }
    return (keep.sorted().map { lines[$0] }, matches)
}
