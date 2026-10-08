import ApplicationServices
import Foundation

/// An accessibility element as a dictionary key: the same UI object read
/// twice compares equal.
struct ElementKey: Hashable {
    let element: AXUIElement
    init(_ element: AXUIElement) { self.element = element }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
    static func == (a: ElementKey, b: ElementKey) -> Bool { CFEqual(a.element, b.element) }
}

/// Names for what one look at an app showed ("v12"), unique within the
/// server process, so a later look can report only what changed since.
@MainActor
enum StateVersions {
    private static var counter = 0

    static func next() -> String {
        counter += 1
        return "v\(counter)"
    }
}

/// What one look showed, kept to compare the next look with.
struct StateRecord {
    let version: String
    /// The numbering of element indices this look used (unlocked), so a
    /// comparison only happens where indices mean the same elements.
    let epoch: Int
    /// The window the look was about.
    let window: String
    let lines: [String]
    /// Recognized text lines, reused while the pixels stay the same.
    let textLines: [String]
    /// Window id (or title) -> title, all of the app's windows.
    let windows: [String: String]
    let fingerprint: PixelFingerprint?

    /// The last few looks per app are kept.
    static let kept = 6

    /// The history with a look added (alone, or with what goes with it),
    /// keeping the last `kept`.
    static func appending<Look>(_ record: Look, to history: [Look]?) -> [Look] {
        Array(((history ?? []) + [record]).suffix(kept))
    }
}

/// The difference between two looks at the same window: lines added,
/// removed or changed (the same element index, or the same recognized
/// text, with different content), and windows opened, closed or renamed.
struct StateDiff: Equatable {
    struct Change: Equatable {
        let old: String
        let new: String
    }

    var added: [String] = []
    var removed: [String] = []
    var changed: [Change] = []
    var opened: [String] = []
    var closed: [String] = []
    var renamed: [String] = []

    var size: Int { added.count + removed.count + changed.count }
    var isEmpty: Bool { size == 0 && opened.isEmpty && closed.isEmpty && renamed.isEmpty }

    /// What identifies a line across looks: its element index ("[12]"), or
    /// for recognized text the quoted text itself.
    static func key(_ line: String) -> String? {
        let trimmed = line.drop { $0 == " " }
        if trimmed.hasPrefix("["), let end = trimmed.firstIndex(of: "]"), trimmed[trimmed.index(after: trimmed.startIndex)..<end].allSatisfy(\.isNumber) {
            return String(trimmed[...end])
        }
        if trimmed.hasPrefix("\""), let close = trimmed.dropFirst().firstIndex(of: "\"") {
            return String(trimmed[...close])
        }
        return nil
    }

    static func compare(old: [String], new: [String], oldWindows: [String: String] = [:], newWindows: [String: String] = [:]) -> StateDiff {
        var diff = StateDiff()
        var removals: [(offset: Int, line: String)] = []
        var insertions: [(offset: Int, line: String)] = []
        for change in new.difference(from: old) {
            switch change {
            case .remove(let offset, let line, _): removals.append((offset, line))
            case .insert(let offset, let line, _): insertions.append((offset, line))
            }
        }
        // A line that went and came back with the same key changed in place.
        var removedByKey: [String: [Int]] = [:]
        for (position, removal) in removals.enumerated() {
            if let key = key(removal.line) { removedByKey[key, default: []].append(position) }
        }
        var paired = Set<Int>()
        for insertion in insertions.sorted(by: { $0.offset < $1.offset }) {
            if let key = key(insertion.line), var candidates = removedByKey[key], !candidates.isEmpty {
                let position = candidates.removeFirst()
                removedByKey[key] = candidates
                paired.insert(position)
                diff.changed.append(Change(old: removals[position].line, new: insertion.line))
            } else {
                diff.added.append(insertion.line)
            }
        }
        diff.removed = removals.enumerated().filter { !paired.contains($0.offset) }.sorted { $0.element.offset < $1.element.offset }.map(\.element.line)
        for (id, title) in newWindows.sorted(by: { $0.key < $1.key }) {
            if let before = oldWindows[id] {
                if before != title { diff.renamed.append("\(quote(before, limit: 60)) → \(quote(title, limit: 60)) (id \(id))") }
            } else {
                diff.opened.append("\(quote(title, limit: 60)) (id \(id))")
            }
        }
        for (id, title) in oldWindows.sorted(by: { $0.key < $1.key }) where newWindows[id] == nil {
            diff.closed.append("\(quote(title, limit: 60)) (id \(id))")
        }
        return diff
    }

    /// The change lines, at most `limit` of them.
    func render(limit: Int = 120) -> [String] {
        var lines: [String] = []
        var windows: [String] = []
        if !opened.isEmpty { windows.append("opened " + opened.joined(separator: ", ")) }
        if !closed.isEmpty { windows.append("closed " + closed.joined(separator: ", ")) }
        if !renamed.isEmpty { windows.append("renamed " + renamed.joined(separator: ", ")) }
        if !windows.isEmpty { lines.append("Windows: " + windows.joined(separator: "; ") + ".") }
        var entries: [String] = []
        for change in changed {
            entries.append("~ " + change.new)
            entries.append("    was: " + change.old.trimmingCharacters(in: .whitespaces))
        }
        entries += added.map { "+ " + $0 }
        entries += removed.map { "- " + $0 }
        lines += entries.prefix(limit)
        if entries.count > limit {
            lines.append("(\(entries.count - limit) more change lines; call get_app_state without since for everything.)")
        }
        return lines
    }

    /// One line: how much changed.
    var summary: String {
        var parts: [String] = []
        if !changed.isEmpty { parts.append("\(changed.count) changed") }
        if !added.isEmpty { parts.append("\(added.count) added") }
        if !removed.isEmpty { parts.append("\(removed.count) removed") }
        if !opened.isEmpty { parts.append("\(opened.count) window\(opened.count == 1 ? "" : "s") opened") }
        if !closed.isEmpty { parts.append("\(closed.count) window\(closed.count == 1 ? "" : "s") closed") }
        if !renamed.isEmpty { parts.append("\(renamed.count) window\(renamed.count == 1 ? "" : "s") renamed") }
        return parts.isEmpty ? "no line changed" : parts.joined(separator: ", ")
    }

    /// Too much changed for a list of changes to be shorter than the state.
    func isLarge(comparedTo lines: Int) -> Bool {
        size > max(60, lines / 2)
    }
}
