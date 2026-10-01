import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let status = NSTextField(labelWithString: "locked-use-count:0")
    var count = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 400, height: 180),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "skfiy locked-use test"
        window.isReleasedWhenClosed = false
        status.frame = NSRect(x: 20, y: 110, width: 350, height: 30)
        window.contentView?.addSubview(status)
        let button = NSButton(title: "Increment locked-use counter", target: self, action: #selector(increment))
        button.frame = NSRect(x: 20, y: 50, width: 350, height: 40)
        window.contentView?.addSubview(button)
        window.orderBack(nil)
    }
    @objc func increment() {
        count += 1
        status.stringValue = "locked-use-count:\(count)"
    }
}
let app = NSApplication.shared
let fixture = Fixture()
app.setActivationPolicy(.regular)
app.delegate = fixture
app.run()
