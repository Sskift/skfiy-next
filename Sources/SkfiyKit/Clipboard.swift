import AppKit

/// What a pasteboard holds: each item's data by type.
struct ClipboardContents: Equatable {
    var items: [[String: Data]]

    static let transientType = "org.nspasteboard.TransientType"
    static let concealedType = "org.nspasteboard.ConcealedType"
    static let textTypes: Set<String> = [NSPasteboard.PasteboardType.string.rawValue, "NSStringPboardType"]

    static func text(_ string: String) -> ClipboardContents {
        ClipboardContents(items: [[NSPasteboard.PasteboardType.string.rawValue: Data(string.utf8)]])
    }

    var isEmpty: Bool { items.allSatisfy(\.isEmpty) }

    var text: String? {
        for item in items {
            for type in [NSPasteboard.PasteboardType.string.rawValue, "NSStringPboardType"] {
                if let data = item[type], let text = String(data: data, encoding: .utf8) { return text }
            }
        }
        return nil
    }

    /// True when there is more than plain text: files, images, rich text, cells.
    var isRich: Bool {
        items.contains { item in item.keys.contains { !Self.textTypes.contains($0) && $0 != Self.transientType } }
    }

    /// Password managers mark what they copy as concealed.
    var isConcealed: Bool { items.contains { $0[Self.concealedType] != nil } }

    /// "3 files", "an image", "rich text", "text" — for messages.
    var summary: String {
        let types = Set(items.flatMap(\.keys))
        let files = items.filter { $0["public.file-url"] != nil }.count
        if files > 0 { return files == 1 ? "a file" : "\(files) files" }
        if types.contains(where: { $0.hasPrefix("public.png") || $0.hasPrefix("public.tiff") || $0 == "public.jpeg" }) { return "an image" }
        if types.contains("public.rtf") || types.contains("public.html") { return "rich text" }
        if text != nil { return "text" }
        return "data (\(types.filter { $0 != Self.transientType }.sorted().prefix(3).joined(separator: ", ")))"
    }
}

/// The system clipboard, which belongs to the user. skfiy only lends it to an
/// app for a moment — to let the app copy or paste something that is not
/// plain text — and puts the user's contents straight back.
@MainActor
struct SystemClipboard {
    let pasteboard: NSPasteboard

    init(_ pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
    }

    var changeCount: Int { pasteboard.changeCount }

    func read() -> ClipboardContents {
        ClipboardContents(items: (pasteboard.pasteboardItems ?? []).map { item in
            var types: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { types[type.rawValue] = data }
            }
            return types
        })
    }

    /// Writes `contents`, marked transient so clipboard managers skip it.
    func write(_ contents: ClipboardContents) {
        pasteboard.clearContents()
        let items = contents.items.map { types -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in types {
                item.setData(data, forType: NSPasteboard.PasteboardType(type))
            }
            item.setData(Data(), forType: NSPasteboard.PasteboardType(ClipboardContents.transientType))
            return item
        }
        if !items.isEmpty {
            pasteboard.writeObjects(items)
        }
    }

    /// Waits up to `seconds` for the clipboard to change from `count`.
    func waitForChange(from count: Int, seconds: Double = 1.5) async -> Bool {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            if pasteboard.changeCount != count { return true }
            await Input.pause(0.03)
        }
        return pasteboard.changeCount != count
    }
}
