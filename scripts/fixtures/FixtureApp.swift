// A small app for the smoke tests (scripts/smoke_fixture.py). Its windows
// open behind every other window and it never activates. It has:
// - an icon button whose only label is its tooltip, with a context menu
//   (Archive all, Label > Red / Blue) for run_in_front's menu_item,
// - "Choose file…" and "Save as…", which open the system's file panels as
//   sheets (served by another process, since the fixture is sandboxed),
// - a password field,
// - two custom-drawn canvases that publish no accessibility, one accepting
//   the first click of an inactive window and one not, and a web view (as in
//   Tauri apps) with a canvas,
// - a status line, and each canvas's screen frame, readable in the tree,
// - a second window, "skfiy opaque", whose words are pixels only,
// - menus that stay enabled in the background: File > Save As…, and Edit >
//   Copy / Paste of a swatch (an image and a type of its own, no text).
import AppKit
import WebKit

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

/// Words drawn as pixels only, like custom-drawn apps (WeChat): nothing in
/// the accessibility tree, so they can only be found by recognizing text.
final class TextCanvas: NSView {
    let words = ["发送消息", "Cancel"]
    var clicked: (String) -> Void = { _ in }
    private var rects: [(String, NSRect)] = []

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        rects = []
        var x: CGFloat = 24
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 22), .foregroundColor: NSColor.black]
        for word in words {
            let size = (word as NSString).size(withAttributes: attributes)
            let rect = NSRect(x: x, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
            (word as NSString).draw(in: rect, withAttributes: attributes)
            rects.append((word, rect))
            x += size.width + 48
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        clicked(rects.first { $0.1.insetBy(dx: -4, dy: -4).contains(point) }?.0 ?? "nothing")
    }

    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }
}

/// The window's own content takes the initial keyboard focus, so it does
/// not start in the password field.
final class Content: NSView {
    override var acceptsFirstResponder: Bool { true }
}

final class Delegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    let status = NSTextField(labelWithString: "status: ready")
    let frames = NSTextField(labelWithString: "")
    let canvases = [Canvas(name: "canvas", firstMouse: true), Canvas(name: "strict canvas", firstMouse: false)]
    var web: WKWebView!
    var opaque: NSWindow!

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        status.stringValue = "status: web canvas \(message.body) clicked"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 330), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "skfiy fixture"
        window.isReleasedWhenClosed = false
        let content = Content()
        window.contentView = content
        window.initialFirstResponder = content

        let archive = NSButton(image: NSImage(systemSymbolName: "archivebox", accessibilityDescription: nil)!, target: self, action: #selector(pressedArchive))
        archive.toolTip = "Archive the selected messages"
        // A context menu with a submenu, for run_in_front's menu_item.
        let context = NSMenu()
        context.addItem(NSMenuItem(title: "Archive all", action: #selector(archiveAll), keyEquivalent: ""))
        let label = NSMenuItem(title: "Label", action: nil, keyEquivalent: "")
        label.submenu = NSMenu()
        for color in ["Red", "Blue"] {
            label.submenu?.addItem(NSMenuItem(title: color, action: #selector(labelChosen(_:)), keyEquivalent: ""))
        }
        context.addItem(label)
        context.items.forEach { $0.target = self }
        label.submenu?.items.forEach { $0.target = self }
        archive.menu = context

        let password = NSSecureTextField()
        password.placeholderString = "Password"
        let choose = NSButton(title: "Choose file…", target: self, action: #selector(chooseFile))
        let save = NSButton(title: "Save as…", target: self, action: #selector(saveAs))

        for canvas in canvases {
            canvas.clicked = { [weak self] what in self?.status.stringValue = "status: \(what) clicked" }
        }

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "clicked")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.loadHTMLString("""
            <body style="margin:0"><canvas id=c width=200 height=70></canvas><script>
            const c = document.getElementById('c'), x = c.getContext('2d');
            x.fillStyle = '#4a8'; x.fillRect(0, 0, 100, 70); x.fillStyle = '#e84'; x.fillRect(100, 0, 100, 70);
            c.addEventListener('mousedown', e => webkit.messageHandlers.clicked.postMessage(e.offsetX < 100 ? 'green' : 'orange'));
            </script></body>
            """, baseURL: nil)

        let place: [(NSView, NSRect)] = [
            (status, NSRect(x: 20, y: 292, width: 420, height: 20)),
            (archive, NSRect(x: 380, y: 262, width: 40, height: 30)),
            (choose, NSRect(x: 20, y: 220, width: 140, height: 30)),
            (save, NSRect(x: 170, y: 220, width: 140, height: 30)),
            (password, NSRect(x: 320, y: 224, width: 120, height: 24)),
            (canvases[0], NSRect(x: 20, y: 100, width: 200, height: 70)),
            (canvases[1], NSRect(x: 240, y: 100, width: 200, height: 70)),
            (web, NSRect(x: 240, y: 15, width: 200, height: 70)),
            (frames, NSRect(x: 20, y: 10, width: 210, height: 80))
        ]
        for (view, frame) in place {
            view.frame = frame
            content.addSubview(view)
        }
        frames.maximumNumberOfLines = 3
        window.center()
        // Behind every other window, and the app stays inactive.
        window.orderBack(nil)
        window.makeFirstResponder(content)

        // A second window with nothing but drawn words.
        opaque = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 110), styleMask: [.titled], backing: .buffered, defer: false)
        opaque.title = "skfiy opaque"
        opaque.isReleasedWhenClosed = false
        let words = TextCanvas()
        words.clicked = { [weak self] word in self?.status.stringValue = "status: text \(word) clicked" }
        opaque.contentView = words
        opaque.setFrameTopLeftPoint(NSPoint(x: window.frame.minX, y: window.frame.minY - 20))
        opaque.orderBack(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in
            let named: [(String, CGRect)] = canvases.map { ($0.name, $0.screenFrame) } + [("web canvas", screenFrame(of: web))]
            frames.stringValue = named.map { name, f in
                "\(name) at \(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))x\(Int(f.height))"
            }.joined(separator: "; ")
        }
    }

    @objc func pressedArchive() { status.stringValue = "status: archive pressed" }

    func screenFrame(of view: NSView) -> CGRect {
        let rect = window.convertToScreen(view.convert(view.bounds, to: nil))
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        return CGRect(x: rect.minX, y: top - rect.maxY, width: rect.width, height: rect.height)
    }

    @objc func archiveAll() { status.stringValue = "status: archive all chosen" }
    @objc func labelChosen(_ item: NSMenuItem) { status.stringValue = "status: label \(item.title.lowercased()) chosen" }

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
