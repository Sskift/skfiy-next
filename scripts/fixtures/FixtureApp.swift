// A small app for the smoke tests (scripts/smoke_fixture.py). Its window
// opens behind every other window and never activates. It has:
// - an icon button whose only label is its tooltip,
// - "Choose file…" and "Save as…", which open the system's file panels as
//   sheets (served by another process, since the fixture is sandboxed),
// - two custom-drawn canvases that publish no accessibility, one accepting
//   the first click of an inactive window and one not,
// - a status line, and each canvas's screen frame, readable in the tree.
import AppKit

final class Canvas: NSView {
    let name: String
    let firstMouse: Bool
    var clicked: (String) -> Void = { _ in }

    init(name: String, firstMouse: Bool) {
        self.name = name
        self.firstMouse = firstMouse
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemGreen.setFill()
        NSRect(x: 0, y: 0, width: bounds.width / 2, height: bounds.height).fill()
        NSColor.systemOrange.setFill()
        NSRect(x: bounds.width / 2, y: 0, width: bounds.width / 2, height: bounds.height).fill()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { firstMouse }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        clicked("\(name) \(point.x < bounds.width / 2 ? "green" : "orange")")
    }

    override func isAccessibilityElement() -> Bool { false }

    /// The frame in screen points with a top-left origin, as skfiy uses them.
    var screenFrame: CGRect {
        guard let window, let screen = window.screen ?? NSScreen.main else { return .zero }
        let rect = window.convertToScreen(convert(bounds, to: nil))
        let top = NSScreen.screens.first?.frame.maxY ?? screen.frame.maxY
        return CGRect(x: rect.minX, y: top - rect.maxY, width: rect.width, height: rect.height)
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let status = NSTextField(labelWithString: "status: ready")
    let frames = NSTextField(labelWithString: "")
    let canvases = [Canvas(name: "canvas", firstMouse: true), Canvas(name: "strict canvas", firstMouse: false)]

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 330), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "skfiy fixture"
        window.isReleasedWhenClosed = false
        let content = NSView()
        window.contentView = content

        let archive = NSButton(image: NSImage(systemSymbolName: "archivebox", accessibilityDescription: nil)!, target: self, action: #selector(pressedArchive))
        archive.toolTip = "Archive the selected messages"

        let choose = NSButton(title: "Choose file…", target: self, action: #selector(chooseFile))
        let save = NSButton(title: "Save as…", target: self, action: #selector(saveAs))

        for canvas in canvases {
            canvas.clicked = { [weak self] what in self?.status.stringValue = "status: \(what) clicked" }
        }

        let place: [(NSView, NSRect)] = [
            (status, NSRect(x: 20, y: 292, width: 420, height: 20)),
            (archive, NSRect(x: 380, y: 262, width: 40, height: 30)),
            (choose, NSRect(x: 20, y: 220, width: 140, height: 30)),
            (save, NSRect(x: 170, y: 220, width: 140, height: 30)),
            (canvases[0], NSRect(x: 20, y: 100, width: 200, height: 70)),
            (canvases[1], NSRect(x: 240, y: 100, width: 200, height: 70)),
            (frames, NSRect(x: 20, y: 20, width: 420, height: 60))
        ]
        for (view, frame) in place {
            view.frame = frame
            content.addSubview(view)
        }
        frames.maximumNumberOfLines = 3
        window.center()
        // Behind every other window, and the app stays inactive.
        window.orderBack(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in
            frames.stringValue = canvases.map { canvas in
                let f = canvas.screenFrame
                return "\(canvas.name) at \(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))x\(Int(f.height))"
            }.joined(separator: "; ")
        }
    }

    @objc func pressedArchive() { status.stringValue = "status: archive pressed" }

    /// Copies a swatch: an image plus a type of the fixture's own, no text.
    @objc func copySwatch() {
        let item = NSPasteboardItem()
        item.setString("teal", forType: NSPasteboard.PasteboardType("com.skfiy.fixture.swatch"))
        let image = NSImage(size: NSSize(width: 8, height: 8), flipped: false) { rect in
            NSColor.systemTeal.setFill()
            rect.fill()
            return true
        }
        if let tiff = image.tiffRepresentation { item.setData(tiff, forType: .tiff) }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([item])
        status.stringValue = "status: swatch copied"
    }

    @objc func pasteSwatch() {
        let swatch = NSPasteboard.general.string(forType: NSPasteboard.PasteboardType("com.skfiy.fixture.swatch"))
        status.stringValue = "status: pasted \(swatch ?? "nothing") swatch"
    }

    @objc func chooseFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { [self] response in
            status.stringValue = response == .OK ? "status: chosen \(panel.url?.path ?? "?")" : "status: choosing cancelled"
        }
    }

    @objc func saveAs() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "fixture.txt"
        panel.beginSheetModal(for: window) { [self] response in
            guard response == .OK, let url = panel.url else {
                status.stringValue = "status: saving cancelled"
                return
            }
            do {
                try "saved by the fixture\n".write(to: url, atomically: true, encoding: .utf8)
                status.stringValue = "status: saved \(url.path)"
            } catch {
                status.stringValue = "status: save failed \(error.localizedDescription)"
            }
        }
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
// Menus whose commands stay enabled in the background (no documents or
// responder chain involved).
let mainMenu = NSMenu()
for (title, items) in [("SkfiyFixture", [NSMenuItem(title: "Quit SkfiyFixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")]),
                       ("File", [NSMenuItem(title: "Save As…", action: #selector(Delegate.saveAs), keyEquivalent: "S")]),
                       ("Edit", [NSMenuItem(title: "Copy", action: #selector(Delegate.copySwatch), keyEquivalent: "c"),
                                 NSMenuItem(title: "Paste", action: #selector(Delegate.pasteSwatch), keyEquivalent: "v")])] {
    let menu = NSMenu(title: title)
    items.forEach(menu.addItem)
    let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    holder.submenu = menu
    mainMenu.addItem(holder)
}
app.mainMenu = mainMenu
app.setActivationPolicy(.regular)
app.run()
