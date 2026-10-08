import AppKit
import Foundation

/// The agent's own cursor, as Codex shows one: skfiy acts without moving the
/// user's pointer, so a cursor of its own glides to each click, scroll or
/// drag and shows what happened there. It is drawn by a helper process
/// (`skfiy cursor-overlay`) in a small click-through window kept directly
/// above the target window: covered wherever that window is covered, never
/// activated, and gone with skfiy (the helper quits when its input closes).
/// Screenshots never show it, since they capture only the target app's
/// windows. Off with SKFIY_CURSOR=0, and while the screen is locked.
@MainActor
enum VirtualCursor {
    enum Effect {
        case click(count: Int, button: MouseButton)
        case scroll(dx: Double, dy: Double)
        case keys(String)
        case release
    }

    static let enabled: Bool = {
        let setting = ProcessInfo.processInfo.environment["SKFIY_CURSOR"]?.lowercased() ?? ""
        return !["0", "off", "false", "no"].contains(setting)
    }()

    private static var helper: Process?
    private static var input: FileHandle?
    private static var position: CGPoint?
    private static var shownPID: pid_t?
    private static var bend = 1.0

    /// Glides to `point` (screen coordinates) over `pid`'s window there and
    /// returns once it has arrived, so the real event lands under it.
    static func move(to point: CGPoint, pid: pid_t, window: CGWindowID? = nil) async {
        guard let seconds = glide(to: point, pid: pid, window: window) else { return }
        await Input.pause(seconds)
    }

    /// Starts a glide and returns its duration without waiting, e.g. for a
    /// drag, whose events go out while the cursor moves (`pressed`).
    @discardableResult
    static func glide(to point: CGPoint, pid: pid_t, window: CGWindowID?, pressed: Bool = false, duration: Double? = nil) -> Double? {
        guard enabled, !isScreenLocked(), let window = window ?? windowID(of: pid, at: point) else { return nil }
        let distance = position.map { hypot(point.x - $0.x, point.y - $0.y) } ?? 160
        let seconds = duration ?? min(0.42, 0.16 + distance / 2600)
        bend = -bend
        let message: [String: Any] = ["op": "move", "x": point.x, "y": point.y, "window": Int(window),
                                      "duration": seconds, "bend": bend, "pressed": pressed]
        guard send(message) else { return nil }
        position = point
        shownPID = pid
        return seconds
    }

    /// Shows what an action did where the cursor is, when it is over `pid`.
    static func show(_ effect: Effect, pid: pid_t) {
        guard enabled, shownPID == pid else { return }
        let message: [String: Any] = switch effect {
        case .click(let count, let button): ["op": "effect", "kind": "click", "count": count, "button": button.rawValue]
        case .scroll(let dx, let dy): ["op": "effect", "kind": "scroll", "dx": dx, "dy": dy]
        case .keys(let label): ["op": "effect", "kind": "keys", "label": label]
        case .release: ["op": "effect", "kind": "release"]
        }
        _ = send(message)
    }

    /// Keyboard input: the cursor first goes to the focused element when it
    /// is over another app (or not shown), then shows the keys.
    static func typing(_ label: String, pid: pid_t) async {
        guard enabled, !isScreenLocked() else { return }
        if shownPID != pid, let frame = AXUIElementCreateApplication(pid).element(kAXFocusedUIElementAttribute)?.frame {
            await move(to: CGPoint(x: frame.minX + min(frame.width / 2, 24), y: frame.midY), pid: pid)
        }
        show(.keys(label), pid: pid)
    }

    /// A key chord as keycaps: "cmd+shift+s" → "⌘⇧S".
    nonisolated static func keycaps(_ chord: String) -> String {
        let names = ["cmd": "⌘", "command": "⌘", "shift": "⇧", "alt": "⌥", "option": "⌥", "opt": "⌥", "ctrl": "⌃", "control": "⌃",
                     "return": "↩", "enter": "↩", "escape": "esc", "esc": "esc", "tab": "⇥", "space": "␣", "backspace": "⌫",
                     "delete": "⌫", "forwarddelete": "⌦", "up": "↑", "down": "↓", "left": "←", "right": "→",
                     "pageup": "⇞", "pagedown": "⇟", "home": "↖", "end": "↘"]
        return chord.split(separator: "+").map { part in
            let key = part.trimmingCharacters(in: .whitespaces)
            return names[key.lowercased()] ?? (key.count == 1 ? key.uppercased() : key)
        }.joined()
    }

    private static func send(_ message: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return false }
        for _ in 0..<2 {
            if input == nil { start() }
            guard let input else { return false }
            do {
                try input.write(contentsOf: data + Data([0x0A]))
                return true
            } catch {
                // The helper is gone; start another once.
                stop()
            }
        }
        return false
    }

    private static func start() {
        guard let executable = Bundle.main.executableURL else { return }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["cursor-overlay"]
        let pipe = Pipe()
        process.standardInput = pipe
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return }
        helper = process
        input = pipe.fileHandleForWriting
        position = nil
        shownPID = nil
    }

    private static func stop() {
        try? input?.close()
        input = nil
        helper = nil
        position = nil
        shownPID = nil
    }
}

// MARK: - The helper process

/// `skfiy cursor-overlay`: draws the cursor from one JSON command per line on
/// standard input, and quits when that closes (skfiy exited or crashed), so a
/// cursor never outlives its session.
public enum VirtualCursorOverlay {
    /// One parsed line, handed from the reading thread to the main thread.
    private struct Command: @unchecked Sendable { let value: [String: Any] }

    public static func run() -> Never {
        let app = NSApplication.shared
        // Never activated, no Dock icon or menu bar; its windows still show.
        app.setActivationPolicy(.prohibited)
        let overlay = MainActor.assumeIsolated { CursorOverlay() }
        Thread {
            var buffer = Data()
            while true {
                let chunk = FileHandle.standardInput.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer.removeSubrange(buffer.startIndex...newline)
                    guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    let command = Command(value: message)
                    DispatchQueue.main.async { MainActor.assumeIsolated { overlay.handle(command.value) } }
                }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { overlay.finish() } }
        }.start()
        app.run()
        exit(0)
    }
}

@MainActor
final class CursorOverlay {
    /// Under 80 pt tall, so nothing that looks for the topmost normal window
    /// (skfiy's own checks, the test window guard) takes it for one.
    static let size = CGSize(width: 168, height: 76)
    /// The tip, from the window's top left; room for ripples around it.
    static let hotspot = CGPoint(x: 30, y: 30)
    static let idleTimeout = Double(ProcessInfo.processInfo.environment["SKFIY_CURSOR_IDLE"] ?? "") ?? 20

    private struct Glide {
        let from: CGPoint, control: CGPoint, to: CGPoint
        let start: Date, duration: Double
    }

    private let window: NSWindow
    private let view: CursorView
    private var target: CGWindowID?
    private var targetOrigin: CGPoint?
    private var tip = CGPoint.zero
    private var glide: Glide?
    private var pressed = false
    private var lastActivity = Date.distantPast
    private var shown = false
    private var alpha: CGFloat = 0
    private var fadeTo: CGFloat = 0
    private var finishing = false
    private var timer: Timer?
    private var lastTrack = Date.distantPast
    private var lastLockCheck = Date.distantPast

    init() {
        view = CursorView(frame: NSRect(origin: .zero, size: Self.size))
        window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -1000, y: -1000), size: Self.size),
                          styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .normal
        window.collectionBehavior = [.transient, .ignoresCycle]
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.alphaValue = 0
        window.contentView = view
    }

    func handle(_ message: [String: Any]) {
        guard !finishing else { return }
        switch message["op"] as? String {
        case "move":
            guard let x = message["x"] as? Double, let y = message["y"] as? Double, let id = message["window"] as? Int else { return }
            move(to: CGPoint(x: x, y: y), window: CGWindowID(id), duration: message["duration"] as? Double ?? 0.3,
                 bend: message["bend"] as? Double ?? 1, pressed: message["pressed"] as? Bool ?? false)
        case "effect":
            guard shown else { return }
            lastActivity = Date()
            switch message["kind"] as? String {
            case "click":
                view.press()
                let count = max(1, min(3, message["count"] as? Int ?? 1))
                for index in 0..<count {
                    view.ripple(after: Double(index) * 0.11, dashed: message["button"] as? String == "right")
                }
            case "scroll":
                view.scroll(dx: message["dx"] as? Double ?? 0, dy: message["dy"] as? Double ?? 0)
            case "keys":
                view.badge(message["label"] as? String ?? "⌨︎")
            case "release":
                pressed = false
                view.ripple(after: 0, dashed: false)
            default:
                break
            }
            run()
        case "hide":
            hide()
        default:
            break
        }
    }

    /// Input closed: fade out and quit.
    func finish() {
        finishing = true
        guard shown else { exit(0) }
        fadeTo = 0
        run()
        Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { _ in exit(0) }
    }

    private func move(to point: CGPoint, window id: CGWindowID, duration: Double, bend: Double, pressed: Bool) {
        var from = tip
        if !shown {
            // Coming in from the lower left reads as a guided cursor, not a jump.
            from = CGPoint(x: point.x - 34, y: point.y + 26)
            tip = from
            shown = true
        }
        if target != id || window.alphaValue == 0 {
            target = id
            targetOrigin = frame(of: id)?.origin
            window.order(.above, relativeTo: Int(id))
        }
        fadeTo = 1
        let distance = hypot(point.x - from.x, point.y - from.y)
        let middle = CGPoint(x: (from.x + point.x) / 2, y: (from.y + point.y) / 2)
        let normal = distance > 0 ? CGPoint(x: -(point.y - from.y) / distance, y: (point.x - from.x) / distance) : .zero
        let offset = min(60, distance * 0.18) * bend
        glide = Glide(from: from, control: CGPoint(x: middle.x + normal.x * offset, y: middle.y + normal.y * offset),
                      to: point, start: Date(), duration: max(0.05, duration))
        self.pressed = pressed
        lastActivity = Date()
        run()
    }

    private func hide() {
        fadeTo = 0
        run()
    }

    private func run() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { _ in MainActor.assumeIsolated { self.tick() } }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func tick() {
        let now = Date()
        if let glide {
            let progress = min(1, now.timeIntervalSince(glide.start) / glide.duration)
            let eased = progress < 0.5 ? 2 * progress * progress : 1 - pow(-2 * progress + 2, 2) / 2
            let a = (1 - eased) * (1 - eased), b = 2 * (1 - eased) * eased, c = eased * eased
            tip = CGPoint(x: a * glide.from.x + b * glide.control.x + c * glide.to.x,
                          y: a * glide.from.y + b * glide.control.y + c * glide.to.y)
            if progress >= 1 { self.glide = nil }
        }
        if !finishing, now.timeIntervalSince(lastTrack) > 0.25 {
            lastTrack = now
            track()
        }
        if !finishing, now.timeIntervalSince(lastLockCheck) > 1 {
            lastLockCheck = now
            if isScreenLocked() { fadeTo = 0 }
        }
        if !finishing, shown, fadeTo > 0, now.timeIntervalSince(lastActivity) > Self.idleTimeout { fadeTo = 0 }
        alpha += (fadeTo - alpha) * 0.25
        if abs(fadeTo - alpha) < 0.02 { alpha = fadeTo }
        // Thinking: a slight wiggle while it waits for the next action.
        let idle = now.timeIntervalSince(lastActivity)
        view.rotation = glide == nil && idle > 0.8 ? 3.5 * sin(idle * 2 * .pi / 1.3) : 0
        view.pressedScale = pressed ? 0.86 : 1
        place()
        window.alphaValue = alpha
        view.needsDisplay = true
        if alpha == 0, fadeTo == 0 {
            window.orderOut(nil)
            shown = false
            glide = nil
            timer?.invalidate()
            timer = nil
        }
    }

    /// Follows the target window: moves along with it, stays directly above
    /// it (so whatever covers it covers the cursor too), hides with it.
    private func track() {
        guard shown, let target else { return }
        guard let frame = frame(of: target) else {
            fadeTo = 0
            return
        }
        if let old = targetOrigin, old != frame.origin {
            let dx = frame.minX - old.x, dy = frame.minY - old.y
            tip = CGPoint(x: tip.x + dx, y: tip.y + dy)
            if let glide {
                self.glide = Glide(from: CGPoint(x: glide.from.x + dx, y: glide.from.y + dy),
                                   control: CGPoint(x: glide.control.x + dx, y: glide.control.y + dy),
                                   to: CGPoint(x: glide.to.x + dx, y: glide.to.y + dy), start: glide.start, duration: glide.duration)
            }
        }
        targetOrigin = frame.origin
        window.order(.above, relativeTo: Int(target))
    }

    /// The window's frame while it is on screen.
    private func frame(of id: CGWindowID) -> CGRect? {
        guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first,
              info[kCGWindowIsOnscreen as String] as? Bool == true,
              let dictionary = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: dictionary)
    }

    /// Screen coordinates (top-left origin) to the window's AppKit frame.
    private func place() {
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        window.setFrameOrigin(NSPoint(x: tip.x - Self.hotspot.x,
                                      y: primaryTop - tip.y + Self.hotspot.y - Self.size.height))
    }
}

/// The cursor and its effects, drawn around the hotspot.
final class CursorView: NSView {
    var rotation = 0.0
    var pressedScale: CGFloat = 1
    private var pressStart: Date?
    private var ripples: [(start: Date, dashed: Bool)] = []
    private var chevron: (start: Date, dx: Double, dy: Double)?
    private var label: (start: Date, text: String)?

    override var isFlipped: Bool { true }

    func press() { pressStart = Date() }
    func ripple(after delay: Double, dashed: Bool) { ripples.append((Date().addingTimeInterval(delay), dashed)) }
    func scroll(dx: Double, dy: Double) { chevron = (Date(), dx, dy) }
    func badge(_ text: String) { label = (Date(), text) }

    private var color: NSColor { NSColor.controlAccentColor.usingColorSpace(.sRGB) ?? .systemBlue }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let now = Date()
        let tip = CursorOverlay.hotspot
        let color = self.color

        ripples.removeAll { now.timeIntervalSince($0.start) > 0.4 }
        for ripple in ripples {
            let t = now.timeIntervalSince(ripple.start) / 0.4
            guard t >= 0 else { continue }
            let radius = 5 + 22 * (1 - pow(1 - t, 3))
            let ring = NSBezierPath(ovalIn: NSRect(x: tip.x - radius, y: tip.y - radius, width: radius * 2, height: radius * 2))
            ring.lineWidth = 2.2
            if ripple.dashed { ring.setLineDash([4, 3], count: 2, phase: 0) }
            color.withAlphaComponent(0.85 * (1 - t)).setStroke()
            ring.stroke()
        }

        if let chevron, now.timeIntervalSince(chevron.start) < 0.6 {
            let t = now.timeIntervalSince(chevron.start) / 0.6
            let vertical = abs(chevron.dy) >= abs(chevron.dx)
            let sign: CGFloat = (vertical ? chevron.dy : chevron.dx) >= 0 ? 1 : -1
            color.withAlphaComponent(0.9 * (1 - t)).setStroke()
            for step in 0..<2 {
                let distance = 14 + CGFloat(step) * 6 + CGFloat(t) * 6
                let path = NSBezierPath()
                path.lineWidth = 2.2
                path.lineCapStyle = .round
                path.lineJoinStyle = .round
                if vertical {
                    let y = tip.y + sign * distance
                    path.move(to: NSPoint(x: tip.x - 5, y: y - sign * 4))
                    path.line(to: NSPoint(x: tip.x, y: y))
                    path.line(to: NSPoint(x: tip.x + 5, y: y - sign * 4))
                } else {
                    let x = tip.x + sign * distance
                    path.move(to: NSPoint(x: x - sign * 4, y: tip.y - 5))
                    path.line(to: NSPoint(x: x, y: tip.y))
                    path.line(to: NSPoint(x: x - sign * 4, y: tip.y + 5))
                }
                path.stroke()
            }
        } else {
            chevron = nil
        }

        // A click dips the cursor and lets it spring back.
        var scale = pressedScale
        if let pressStart {
            let t = now.timeIntervalSince(pressStart) / 0.2
            if t < 1 { scale *= 1 - 0.18 * sin(t * .pi) } else { self.pressStart = nil }
        }
        context.saveGState()
        context.translateBy(x: tip.x, y: tip.y)
        context.rotate(by: rotation * .pi / 180)
        context.scaleBy(x: scale * 1.1, y: scale * 1.1)
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: 0, y: 0))
        arrow.line(to: NSPoint(x: 0, y: 17.5))
        arrow.line(to: NSPoint(x: 4.4, y: 13.4))
        arrow.line(to: NSPoint(x: 7.4, y: 20.2))
        arrow.line(to: NSPoint(x: 10.3, y: 18.9))
        arrow.line(to: NSPoint(x: 7.4, y: 12.4))
        arrow.line(to: NSPoint(x: 13, y: 12.4))
        arrow.close()
        arrow.lineJoinStyle = .round
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        NSGraphicsContext.saveGraphicsState()
        shadow.set()
        color.setFill()
        arrow.fill()
        NSGraphicsContext.restoreGraphicsState()
        arrow.lineWidth = 1.5
        NSColor.white.setStroke()
        arrow.stroke()
        context.restoreGState()

        if let label, now.timeIntervalSince(label.start) < 1.4 {
            let t = now.timeIntervalSince(label.start)
            let opacity = t > 1.1 ? (1.4 - t) / 0.3 : 1
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: NSColor.white.withAlphaComponent(opacity)
            ]
            let text = NSAttributedString(string: label.text, attributes: attributes)
            let size = text.size()
            let box = NSRect(x: tip.x + 16, y: tip.y + 22, width: min(size.width + 12, bounds.width - tip.x - 18), height: size.height + 6)
            color.withAlphaComponent(0.92 * opacity).setFill()
            NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6).fill()
            text.draw(at: NSPoint(x: box.minX + 6, y: box.minY + 3))
        } else {
            label = nil
        }
    }
}
