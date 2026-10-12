import AppKit

// Own test window, ordered at the back once; never activated or restored.
final class ComplexFixture: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let root = URL(fileURLWithPath: CommandLine.arguments[1])
    var window: NSWindow!
    let table = NSTableView()
    let list = NSScrollView()
    var names = ["Alice", "Bob", "Carol"]
    var counts: [String: Int] = [:]
    var lastCommand = ""
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 80, y: 120, width: 560, height: 480),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "skfiy complex fixture"
        window.isReleasedWhenClosed = false
        let content = window.contentView!
        let icon = NSButton(frame: NSRect(x: 15, y: 430, width: 40, height: 30))
        icon.title = ""; icon.image = NSImage(systemSymbolName: "archivebox", accessibilityDescription: nil)
        icon.toolTip = "Archive fixture"; icon.identifier = NSUserInterfaceItemIdentifier("archive-icon")
        icon.setAccessibilityIdentifier("archive-icon")
        icon.setAccessibilityLabel("")
        icon.target = self; icon.action = #selector(clicked(_:)); content.addSubview(icon)
        let unnamed = NSButton(frame: NSRect(x: 75, y: 430, width: 40, height: 30))
        unnamed.title = ""; unnamed.image = NSImage(systemSymbolName: "star", accessibilityDescription: nil)
        unnamed.identifier = NSUserInterfaceItemIdentifier("unnamed-icon")
        unnamed.setAccessibilityIdentifier("unnamed-icon")
        unnamed.setAccessibilityLabel("")
        unnamed.target = self; unnamed.action = #selector(clicked(_:)); content.addSubview(unnamed)
        for (name, width) in [("Name", 130.0), ("Email", 225.0), ("Action", 120.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(name))
            column.title = name; column.width = width; table.addTableColumn(column)
        }
        table.rowHeight = 32; table.delegate = self; table.dataSource = self
        table.setAccessibilityLabel("Customers")
        let tableScroll = NSScrollView(frame: NSRect(x: 15, y: 240, width: 530, height: 175))
        tableScroll.documentView = table; tableScroll.hasVerticalScroller = true
        content.addSubview(tableScroll)
        list.frame = NSRect(x: 15, y: 20, width: 530, height: 195)
        list.hasVerticalScroller = true; list.setAccessibilityLabel("Long list")
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 510, height: 2000))
        for i in 0..<40 {
            let button = NSButton(frame: NSRect(x: 15, y: 1960 - i * 50, width: 150, height: 30))
            button.title = "Item \(i + 1)"; button.identifier = NSUserInterfaceItemIdentifier("item-\(i + 1)")
            button.setAccessibilityIdentifier("item-\(i + 1)")
            button.target = self; button.action = #selector(clicked(_:)); document.addSubview(button)
        }
        list.documentView = document; list.contentView.scroll(to: NSPoint(x: 0, y: 1805))
        content.addSubview(list)
        window.order(.below, relativeTo: 0)
        writeState()
        timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.tick() }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { names.count }
    func tableView(_ tableView: NSTableView, viewFor column: NSTableColumn?, row: Int) -> NSView? {
        guard let column else { return nil }
        let name = names[row]
        if column.identifier.rawValue == "Action" {
            let button = NSButton(title: "Edit", target: self, action: #selector(clicked(_:)))
            button.identifier = NSUserInterfaceItemIdentifier("edit-\(name)")
            button.setAccessibilityIdentifier("edit-\(name)")
            return button
        }
        return NSTextField(labelWithString: column.identifier.rawValue == "Name" ? name : "\(name.lowercased())@example.test")
    }
    @objc func clicked(_ sender: NSButton) {
        let id = sender.identifier?.rawValue ?? sender.title
        counts[id, default: 0] += 1; writeState()
    }
    func tick() {
        let command = (try? String(contentsOf: root.appendingPathComponent("command"), encoding: .utf8)) ?? ""
        if command != lastCommand {
            lastCommand = command
            if command == "reverse" { names.reverse(); table.reloadData() }
            if command == "quit" { NSApp.terminate(nil) }
        }
        writeState()
    }
    func writeState() {
        let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "window": window.windowNumber,
                                   "counts": counts, "rows": names, "scroll": list.contentView.bounds.origin.y]
        if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to: root.appendingPathComponent("state.json"), options: .atomic) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = ComplexFixture()
app.delegate = delegate
app.run()
