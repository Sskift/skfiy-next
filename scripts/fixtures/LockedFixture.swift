// A dedicated app for scripts/smoke_locked.py. It never locks or unlocks the
// Mac. Its only output is a state file and an append-only event journal in the
// caller's temporary directory. Run it with:
//   LockedFixture --journal /absolute/path/state.json --nonce RUN_NONCE
// The companion journal is state.json.jsonl. The fixture exits after ten
// minutes unless --lifetime SECONDS is supplied.
import AppKit
import CoreGraphics
import Darwin
import Foundation

struct Options {
    let journal: URL
    let nonce: String
    let lifetime: TimeInterval

    init() throws {
        var values: [String: String] = [:]
        var arguments = Array(CommandLine.arguments.dropFirst())
        while !arguments.isEmpty {
            let key = arguments.removeFirst()
            guard ["--journal", "--nonce", "--lifetime"].contains(key),
                  !arguments.isEmpty, values[key] == nil else {
                throw FixtureError("Expected --journal PATH --nonce NONCE [--lifetime SECONDS].")
            }
            values[key] = arguments.removeFirst()
        }
        guard let path = values["--journal"], path.hasPrefix("/"),
              let nonce = values["--nonce"], !nonce.isEmpty, nonce.utf8.count <= 128 else {
            throw FixtureError("An absolute --journal path and a nonempty --nonce (up to 128 bytes) are required.")
        }
        let lifetime = values["--lifetime"].flatMap(Double.init) ?? 600
        guard lifetime.isFinite, lifetime >= 5, lifetime <= 3_600 else {
            throw FixtureError("--lifetime must be between 5 and 3600 seconds.")
        }
        self.journal = URL(fileURLWithPath: path)
        self.nonce = nonce
        self.lifetime = lifetime
    }
}

struct FixtureError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

final class EvidenceWindow: NSWindow {
    var keyReceived: ((NSEvent) -> Void)?
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown { keyReceived?(event) }
        super.sendEvent(event)
    }
}

// No accessibility children: this tests actual pointer delivery independently
// of a semantic AXPress on the ordinary Commit nonce button.
final class EvidenceCanvas: NSView {
    var text = "waiting" { didSet { needsDisplay = true } }
    var tick = 0 { didSet { needsDisplay = true } }
    var clicked: ((String) -> Void)?
    var scrolled: ((Double, Double) -> Void)?
    var dragged: ((String, Bool) -> Void)?
    private var dragMoved = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemGreen.setFill()
        NSRect(x: 0, y: 0, width: bounds.width / 2, height: bounds.height).fill()
        NSColor.systemOrange.setFill()
        NSRect(x: bounds.width / 2, y: 0, width: bounds.width / 2, height: bounds.height).fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 20, weight: .semibold),
            .foregroundColor: NSColor.black
        ]
        let targetAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 15, weight: .bold), .foregroundColor: NSColor.black]
        ("GREEN TARGET" as NSString).draw(at: NSPoint(x: 12, y: 124), withAttributes: targetAttributes)
        ("ORANGE TARGET" as NSString).draw(at: NSPoint(x: bounds.width / 2 + 12, y: 124), withAttributes: targetAttributes)
        (text as NSString).draw(in: NSRect(x: 12, y: 44, width: bounds.width - 24, height: 50), withAttributes: attributes)
        ("frame \(tick)" as NSString).draw(at: NSPoint(x: 12, y: 14), withAttributes: attributes)
    }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        dragMoved = false
        clicked?(point.x < bounds.width / 2 ? "green" : "orange")
    }
    override func scrollWheel(with event: NSEvent) {
        scrolled?(Double(event.scrollingDeltaX), Double(event.scrollingDeltaY))
    }
    override func mouseDragged(with event: NSEvent) {
        dragMoved = true
        let point = convert(event.locationInWindow, from: nil)
        dragged?(point.x < bounds.width / 2 ? "green" : "orange", false)
    }
    override func mouseUp(with event: NSEvent) {
        guard dragMoved else { return }
        let point = convert(event.locationInWindow, from: nil)
        dragged?(point.x < bounds.width / 2 ? "green" : "orange", true)
        dragMoved = false
    }
}

final class LockedFixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let options: Options
    private let events: FileHandle
    private let started = ProcessInfo.processInfo.systemUptime
    private var window: EvidenceWindow!
    private let input = NSTextField(string: "")
    private let status = NSTextField(labelWithString: "status: ready")
    private let heartbeat = NSTextField(labelWithString: "heartbeat: 0")
    private let commit = NSButton(title: "Commit nonce", target: nil, action: nil)
    private let canvas = EvidenceCanvas()
    private var timer: Timer?
    private var sequence = 0
    private var tick = 0
    private var commits = 0
    private var pointerClicks = 0
    private var scrollEvents = 0
    private var scrollDeltaX = 0.0
    private var scrollDeltaY = 0.0
    private var dragEvents = 0
    private var dragCompletions = 0
    private var lastDragSide = ""
    private var keyDowns = 0
    private var returnKeys = 0
    private var lastKeyCode: Int?
    private var committedValue = ""
    private var lastPointerSide = ""
    private var lastObservedInput = ""
    private var failed = false

    init(options: Options) throws {
        self.options = options
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: options.journal.deletingLastPathComponent().path),
              !fileManager.fileExists(atPath: options.journal.path) else {
            throw FixtureError("The journal directory must exist and the state file must be new.")
        }
        // Never attach to or truncate a previous test's evidence.
        let descriptor = Darwin.open(options.journal.path + ".jsonl", O_WRONLY | O_CREAT | O_EXCL | O_APPEND, mode_t(0o600))
        guard descriptor >= 0 else { throw FixtureError("Cannot create a new event journal: \(String(cString: strerror(errno))).") }
        events = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = EvidenceWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 330),
                                styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "skfiy locked fixture \(options.nonce.prefix(12))"
        window.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 580, height: 330))
        window.contentView = content
        input.placeholderString = "Fixture nonce"
        input.setAccessibilityIdentifier("fixture-nonce")
        input.delegate = self
        commit.target = self
        commit.action = #selector(commitNonce)
        commit.setAccessibilityIdentifier("fixture-commit")
        canvas.text = options.nonce
        canvas.clicked = { [weak self] side in
            guard let self else { return }
            self.pointerClicks += 1
            self.lastPointerSide = side
            self.status.stringValue = "status: pointer \(side) \(self.pointerClicks)"
            self.record("pointer_click")
        }
        canvas.scrolled = { [weak self] x, y in
            guard let self else { return }
            self.scrollEvents += 1
            self.scrollDeltaX += x; self.scrollDeltaY += y
            self.status.stringValue = "status: scroll \(self.scrollEvents)"
            self.record("scroll")
        }
        canvas.dragged = { [weak self] side, completed in
            guard let self else { return }
            if completed { self.dragCompletions += 1 } else { self.dragEvents += 1 }
            self.lastDragSide = side
            self.status.stringValue = "status: drag \(side) \(self.dragCompletions)"
            self.record(completed ? "drag_complete" : "drag")
        }
        window.keyReceived = { [weak self] event in
            guard let self else { return }
            self.keyDowns += 1
            self.lastKeyCode = Int(event.keyCode)
            if event.keyCode == 36 || event.keyCode == 76 { self.returnKeys += 1 }
            self.record("key_down")
        }
        let views: [(NSView, NSRect)] = [
            (status, NSRect(x: 20, y: 292, width: 540, height: 22)),
            (heartbeat, NSRect(x: 20, y: 264, width: 540, height: 22)),
            (input, NSRect(x: 20, y: 218, width: 390, height: 28)),
            (commit, NSRect(x: 420, y: 216, width: 140, height: 32)),
            (canvas, NSRect(x: 20, y: 30, width: 540, height: 158))
        ]
        for (view, frame) in views {
            view.frame = frame
            content.addSubview(view)
        }
        window.center()
        window.orderBack(nil)
        // Focus only within this inactive window; never activate the app.
        window.makeFirstResponder(input)
        record("ready")
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.heartbeatTick() }
    }

    func controlTextDidChange(_ notification: Notification) {
        lastObservedInput = input.stringValue
        record("text_changed")
    }

    @objc private func commitNonce() {
        commits += 1
        committedValue = input.stringValue
        status.stringValue = "status: committed \(commits) \(committedValue)"
        canvas.text = committedValue
        record("commit")
    }

    private func heartbeatTick() {
        tick += 1
        heartbeat.stringValue = "heartbeat: \(tick) run: \(options.nonce)"
        canvas.tick = tick
        // AXValue writes need not send textDidChange. Sample the field too.
        let changed = lastObservedInput != input.stringValue
        lastObservedInput = input.stringValue
        record(changed ? "value_observed" : "heartbeat")
        if ProcessInfo.processInfo.systemUptime - started >= options.lifetime {
            record("lifetime_expired")
            NSApplication.shared.terminate(nil)
        }
    }

    private func screenFrame(_ view: NSView) -> [String: Double] {
        let rect = window.convertToScreen(view.convert(view.bounds, to: nil))
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        return ["x": rect.minX, "y": top - rect.maxY, "width": rect.width, "height": rect.height]
    }

    private func record(_ event: String) {
        guard !failed, window != nil else { return }
        sequence += 1
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        var state: [String: Any] = [
            "schema": 1, "run_nonce": options.nonce, "pid": Int(getpid()),
            "sequence": sequence, "event": event, "timestamp": Date().timeIntervalSince1970,
            "uptime": ProcessInfo.processInfo.systemUptime, "tick": tick,
            "screen_locked": (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false,
            "screen_lock_known": session != nil,
            "input_value": input.stringValue, "committed_value": committedValue,
            "commit_count": commits, "pointer_count": pointerClicks, "pointer_side": lastPointerSide,
            "scroll_count": scrollEvents, "scroll_delta_x": scrollDeltaX, "scroll_delta_y": scrollDeltaY,
            "drag_count": dragEvents, "drag_complete_count": dragCompletions, "drag_side": lastDragSide,
            "key_down_count": keyDowns, "return_key_count": returnKeys,
            "status": status.stringValue, "window_id": window.windowNumber,
            "window_title": window.title, "app_active": NSApplication.shared.isActive,
            "frames": ["input": screenFrame(input), "commit": screenFrame(commit), "canvas": screenFrame(canvas)]
        ]
        state["last_key_code"] = lastKeyCode.map { $0 as Any } ?? NSNull()
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            try events.write(contentsOf: data + Data([0x0A]))
            try events.synchronize()
            try data.write(to: options.journal, options: .atomic)
        } catch {
            failed = true
            FileHandle.standardError.write(Data("LockedFixture evidence write failed: \(error)\n".utf8))
            NSApplication.shared.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        record("terminated")
        try? events.close()
    }
}

do {
    // The fixture writes only its own test artifacts, readable by this user.
    umask(0o077)
    let options = try Options()
    let app = NSApplication.shared
    let fixture = try LockedFixture(options: options)
    app.delegate = fixture
    app.setActivationPolicy(.accessory)
    app.run()
} catch {
    FileHandle.standardError.write(Data("LockedFixture: \(error)\n".utf8))
    exit(1)
}
