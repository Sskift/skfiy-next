// A dedicated test app for the capability tests (scripts/scenario.py). It never
// activates itself, opens its windows behind the user's, and writes only into
// the directory it is given:
//
//   ScenarioFixture --dir /abs/dir --nonce NONCE [--lifetime SECONDS]
//
//   dir/control.jsonl  commands from the harness, one JSON object per line with
//                      an increasing "id"; each is applied once (works while locked)
//   dir/state.json     the latest state (atomic), dir/events.jsonl every event
//
// Commands: text(value, after), clear(after), animate(seconds), open_window(title),
// close_window(title), move(title, dx, dy), resize(title, width, height),
// recreate(title), hide, unhide, swap, tiny(code), key(title), quit.
import AppKit
import CoreGraphics
import Darwin
import Foundation

struct Options {
    let directory: URL
    let nonce: String
    let lifetime: TimeInterval

    init() throws {
        var values: [String: String] = [:]
        var arguments = Array(CommandLine.arguments.dropFirst())
        while !arguments.isEmpty {
            let key = arguments.removeFirst()
            guard ["--dir", "--nonce", "--lifetime"].contains(key), !arguments.isEmpty else {
                throw FixtureError("Expected --dir DIR --nonce NONCE [--lifetime SECONDS].")
            }
            values[key] = arguments.removeFirst()
        }
        guard let path = values["--dir"], path.hasPrefix("/"), let nonce = values["--nonce"], !nonce.isEmpty else {
            throw FixtureError("An absolute --dir and a --nonce are required.")
        }
        directory = URL(fileURLWithPath: path)
        self.nonce = nonce
        lifetime = values["--lifetime"].flatMap(Double.init) ?? 900
    }
}

struct FixtureError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Records every key event it dispatches, per window.
final class RecordingWindow: NSWindow {
    var keyReceived: ((RecordingWindow, NSEvent) -> Void)?
    override var canBecomeKey: Bool { true }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown { keyReceived?(self, event) }
        super.sendEvent(event)
    }
}

/// Pixels only: no accessibility. Tiny text for zoom, a 10×10 pt target, and a
/// bar that moves while animating.
final class Canvas: NSView {
    var tiny = "tiny" { didSet { needsDisplay = true } }
    var phase: Double? { didSet { needsDisplay = true } }
    var clicked: ((CGPoint, Bool) -> Void)?
    let target = NSRect(x: 230, y: 20, width: 10, height: 10)

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        NSColor.black.setStroke()
        NSBezierPath(rect: bounds.insetBy(dx: 0.5, dy: 0.5)).stroke()
        ("CANVAS" as NSString).draw(at: NSPoint(x: 10, y: 8), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 18)])
        (tiny as NSString).draw(at: NSPoint(x: 10, y: 40), withAttributes: [.font: NSFont.systemFont(ofSize: 5), .foregroundColor: NSColor.black])
        NSColor.systemRed.setFill()
        target.fill()
        if let phase {
            NSColor.systemBlue.setFill()
            NSRect(x: 10 + (bounds.width - 70) * phase, y: 80, width: 50, height: 24).fill()
        }
    }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        clicked?(point, target.insetBy(dx: -1, dy: -1).contains(point))
    }
}

final class Scenario: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let options: Options
    private let events: FileHandle
    private var main: RecordingWindow!
    private var extra: [String: RecordingWindow] = [:]
    private let status = NSTextField(labelWithString: "status: ready")
    private let message = NSTextField(labelWithString: "message: none")
    private let input = NSTextField(string: "")
    private let canvas = Canvas()
    private var buttons: [String: NSButton] = [:]
    private var counters: [String: Int] = [:]
    private var submitted: [String] = []
    private var keys: [String: Int] = [:]
    private var canvasClicks: [[String: Any]] = []
    private var appliedCommands = 0
    private var lastCommand = 0
    private var animation: Timer?
    private var sequence = 0
    private let started = ProcessInfo.processInfo.systemUptime
    private var swapped = false

    init(options: Options) throws {
        self.options = options
        let path = options.directory.appendingPathComponent("events.jsonl").path
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_APPEND, mode_t(0o600))
        guard descriptor >= 0 else { throw FixtureError("Cannot open \(path).") }
        events = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        super.init()
    }

    private func makeWindow(_ title: String, size: NSSize) -> RecordingWindow {
        let window = RecordingWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        window.keyReceived = { [weak self] window, event in
            self?.keys[window.title, default: 0] += 1
            self?.record("key", ["window": window.title, "keyCode": Int(event.keyCode), "characters": event.characters ?? ""])
        }
        return window
    }

    private func button(_ title: String, _ name: String, _ frame: NSRect, in view: NSView) {
        let button = NSButton(title: title, target: self, action: #selector(pressed(_:)))
        button.identifier = NSUserInterfaceItemIdentifier(name)
        button.frame = frame
        view.addSubview(button)
        buttons[name] = button
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        main = makeWindow("Scenario \(options.nonce)", size: NSSize(width: 700, height: 520))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 700, height: 520))
        main.contentView = content
        status.frame = NSRect(x: 20, y: 486, width: 420, height: 22)
        message.frame = NSRect(x: 20, y: 460, width: 660, height: 22)
        message.font = .systemFont(ofSize: 15, weight: .semibold)
        content.addSubview(status)
        content.addSubview(message)
        button("Save", "save-top-left", NSRect(x: 460, y: 480, width: 100, height: 30), in: content)
        input.frame = NSRect(x: 20, y: 412, width: 320, height: 26)
        input.placeholderString = "Scenario input"
        input.setAccessibilityLabel("Scenario input")
        input.delegate = self
        content.addSubview(input)
        button("Submit", "submit", NSRect(x: 350, y: 410, width: 100, height: 30), in: content)
        button("Apply", "apply", NSRect(x: 460, y: 410, width: 100, height: 30), in: content)
        button("Noop", "noop", NSRect(x: 570, y: 410, width: 100, height: 30), in: content)
        for (index, group) in ["Profile", "Billing"].enumerated() {
            let box = NSBox(frame: NSRect(x: 20 + CGFloat(index) * 230, y: 300, width: 210, height: 90))
            box.title = group
            box.setAccessibilityLabel(group)
            content.addSubview(box)
            let edit = NSButton(title: "Edit", target: self, action: #selector(pressed(_:)))
            edit.identifier = NSUserInterfaceItemIdentifier("edit-\(group.lowercased())")
            edit.frame = NSRect(x: 20, y: 10, width: 90, height: 30)
            box.contentView?.addSubview(edit)
            buttons["edit-\(group.lowercased())"] = edit
        }
        button("Open dialog", "open-dialog", NSRect(x: 480, y: 340, width: 140, height: 30), in: content)
        canvas.frame = NSRect(x: 20, y: 120, width: 400, height: 160)
        canvas.tiny = "tiny \(options.nonce.prefix(6))"
        canvas.clicked = { [weak self] point, hit in
            guard let self else { return }
            self.counters["canvas", default: 0] += 1
            if hit { self.counters["target", default: 0] += 1 }
            self.canvasClicks = Array((self.canvasClicks + [["x": point.x, "y": point.y, "target": hit]]).suffix(10))
            self.status.stringValue = "status: canvas \(hit ? "target" : "miss") \(self.counters["canvas"] ?? 0)"
            self.record("canvas", ["x": point.x, "y": point.y, "target": hit])
        }
        content.addSubview(canvas)
        button("Cancel", "cancel", NSRect(x: 470, y: 20, width: 100, height: 30), in: content)
        button("Save", "save-bottom-right", NSRect(x: 580, y: 20, width: 100, height: 30), in: content)
        main.center()
        main.orderBack(nil)
        main.makeFirstResponder(input)
        record("ready")
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.poll() }
    }

    @objc private func pressed(_ sender: NSButton) {
        let name = sender.identifier?.rawValue ?? sender.title
        counters[name, default: 0] += 1
        let count = counters[name] ?? 0
        switch name {
        case "noop": break  // deliberately nothing visible
        case "submit":
            submitted.append(input.stringValue)
            status.stringValue = "status: submitted \(submitted.count): \(input.stringValue)"
        case "open-dialog": openWindow("Scenario dialog \(options.nonce)")
        case "done": sender.window?.close()
        default: status.stringValue = "status: \(name) \(count)"
        }
        record("button", ["button": name])
    }

    func controlTextDidChange(_ notification: Notification) { record("text") }

    private func openWindow(_ title: String) {
        if extra[title] != nil { return }
        let window = makeWindow(title, size: NSSize(width: 360, height: 180))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 180))
        window.contentView = content
        let label = NSTextField(labelWithString: "window: \(title)")
        label.frame = NSRect(x: 20, y: 130, width: 320, height: 22)
        content.addSubview(label)
        let done = NSButton(title: "Done", target: self, action: #selector(pressed(_:)))
        done.identifier = NSUserInterfaceItemIdentifier("done")
        done.frame = NSRect(x: 240, y: 20, width: 100, height: 30)
        content.addSubview(done)
        let frame = main.frame
        window.setFrameOrigin(NSPoint(x: frame.minX + 60, y: frame.minY + 60))
        window.orderBack(nil)
        extra[title] = window
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.extra[title] = nil
                self?.record("window_closed", ["title": title])
            }
        }
        record("window_opened", ["title": title])
    }

    private func window(_ title: String?) -> NSWindow? {
        guard let title, !title.isEmpty else { return main }
        return title == main.title || title == "main" ? main : extra[title]
    }

    private func apply(_ command: [String: Any]) {
        let op = command["op"] as? String ?? ""
        let after = (command["after"] as? Double) ?? 0
        let title = command["title"] as? String
        let run = { [weak self] (body: @escaping () -> Void) in
            if after > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + after) { body(); self?.record("delayed_\(op)") }
            } else { body() }
        }
        switch op {
        case "text": run { self.message.stringValue = "message: \(command["value"] as? String ?? "")" }
        case "clear": run { self.message.stringValue = "message: none" }
        case "animate":
            let seconds = (command["seconds"] as? Double) ?? 3
            let start = Date()
            animation?.invalidate()
            canvas.phase = 0
            animation = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] timer in
                MainActor.assumeIsolated {
                    let elapsed = Date().timeIntervalSince(start)
                    if elapsed >= seconds {
                        timer.invalidate()
                        self?.canvas.phase = nil
                        self?.message.stringValue = "message: animation done"
                        self?.record("animation_done")
                    } else {
                        self?.canvas.phase = (elapsed * 2).truncatingRemainder(dividingBy: 1)
                    }
                }
            }
        case "open_window": openWindow(title ?? "Scenario extra \(options.nonce)")
        case "close_window": window(title)?.close()
        case "move":
            if let window = window(title) {
                let origin = window.frame.origin
                // dy is in top-left screen coordinates, as skfiy reports frames.
                window.setFrameOrigin(NSPoint(x: origin.x + ((command["dx"] as? Double) ?? 0), y: origin.y - ((command["dy"] as? Double) ?? 0)))
            }
        case "resize":
            if let window = window(title) {
                var frame = window.frame
                let height = (command["height"] as? Double) ?? frame.height
                frame.origin.y += frame.height - height
                frame.size = NSSize(width: (command["width"] as? Double) ?? frame.width, height: height)
                window.setFrame(frame, display: true)
            }
        case "recreate":
            if let title, let window = extra[title] {
                window.close()
                openWindow(title)
            }
        case "hide": NSApp.hide(nil)
        case "unhide": NSApp.unhideWithoutActivation()
        case "swap":
            // Moves the bottom-right Save button to the middle, and back.
            swapped.toggle()
            buttons["save-bottom-right"]?.frame.origin = swapped ? NSPoint(x: 460, y: 200) : NSPoint(x: 580, y: 20)
            status.stringValue = "status: layout \(swapped ? "swapped" : "original")"
        case "tiny": canvas.tiny = "tiny \(command["code"] as? String ?? "")"
        case "key": window(title)?.makeKey()
        case "quit": NSApp.terminate(nil)
        default: record("unknown_command", ["op": op])
        }
        appliedCommands += 1
        record("command", ["op": op])
    }

    private func poll() {
        let control = options.directory.appendingPathComponent("control.jsonl")
        if let text = try? String(contentsOf: control, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard let data = line.data(using: .utf8),
                      let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = command["id"] as? Int, id > lastCommand else { continue }
                lastCommand = id
                apply(command)
            }
        }
        if ProcessInfo.processInfo.systemUptime - started > options.lifetime { NSApp.terminate(nil) }
    }

    private func frame(_ window: NSWindow) -> [String: Double] {
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        return ["x": window.frame.minX, "y": top - window.frame.maxY, "width": window.frame.width, "height": window.frame.height]
    }

    private func record(_ event: String, _ details: [String: Any] = [:]) {
        sequence += 1
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let windows = ([main] + extra.values.sorted { $0.title < $1.title }).compactMap { $0 }.map { window -> [String: Any] in
            ["title": window.title, "number": window.windowNumber, "frame": frame(window), "visible": window.isVisible, "key": window.isKeyWindow]
        }
        var state: [String: Any] = [
            "nonce": options.nonce, "pid": Int(getpid()), "sequence": sequence, "event": event, "details": details,
            "time": Date().timeIntervalSince1970, "locked": session?["CGSSessionScreenIsLocked"] as? Bool ?? false,
            "status": status.stringValue, "message": message.stringValue, "input": input.stringValue,
            "counters": counters, "submitted": submitted, "keys": keys, "canvasClicks": canvasClicks,
            "windows": windows, "hidden": NSApp.isHidden, "active": NSApp.isActive,
            "lastCommand": lastCommand, "animating": canvas.phase != nil, "tiny": canvas.tiny, "swapped": swapped
        ]
        state["buttons"] = buttons.mapValues { button -> [String: Double] in
            guard let window = button.window else { return [:] }
            let rect = window.convertToScreen(button.convert(button.bounds, to: nil))
            let top = NSScreen.screens.first?.frame.maxY ?? 0
            return ["x": rect.minX, "y": top - rect.maxY, "width": rect.width, "height": rect.height]
        }
        let canvasRect = main.convertToScreen(canvas.convert(canvas.bounds, to: nil))
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        state["canvas"] = ["x": canvasRect.minX, "y": top - canvasRect.maxY, "width": canvasRect.width, "height": canvasRect.height]
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) else { return }
        try? events.write(contentsOf: data + Data([0x0A]))
        try? data.write(to: options.directory.appendingPathComponent("state.json"), options: .atomic)
    }

    func applicationWillTerminate(_ notification: Notification) { record("terminated") }
}

do {
    umask(0o077)
    let options = try Options()
    let app = NSApplication.shared
    // Invisible under the lock screen, a background app is napped and its
    // timers stall; the harness needs commands applied promptly.
    let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "skfiy scenario fixture")
    let scenario = try Scenario(options: options)
    app.delegate = scenario
    app.setActivationPolicy(.accessory)
    app.run()
    ProcessInfo.processInfo.endActivity(activity)
} catch {
    FileHandle.standardError.write(Data("ScenarioFixture: \(error)\n".utf8))
    exit(1)
}
