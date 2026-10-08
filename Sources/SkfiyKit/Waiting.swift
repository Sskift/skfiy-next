import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// A small grayscale copy of a screenshot, for telling whether a window's
/// pixels changed without OCR or sending the model another image.
struct PixelFingerprint: Equatable, Sendable {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    /// `region` is in the image's own pixel space (top-left origin); nil is the whole image.
    /// 640 px wide keeps a one-word change of small text visible.
    init?(_ image: CGImage, region: CGRect? = nil, width: Int = 640) {
        var source = image
        if let region {
            let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
            let clipped = region.integral.intersection(bounds)
            guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1, let cropped = image.cropping(to: clipped) else { return nil }
            source = cropped
        }
        let w = max(1, min(width, source.width))
        let h = max(1, Int((Double(source.height) * Double(w) / Double(max(source.width, 1))).rounded()))
        var buffer = [UInt8](repeating: 0, count: w * h)
        let drawn = buffer.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(source, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        self.width = w
        self.height = h
        pixels = buffer
    }

    init(width: Int, height: Int, pixels: [UInt8]) {
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    /// Whether anything visibly changed. A blinking text caret is not a
    /// change: its pixels form a thin vertical line. Anything else counts,
    /// down to a few pixels, so a small label changing one word is seen.
    func changed(from other: PixelFingerprint, tolerance: UInt8 = 24) -> Bool {
        guard width == other.width, height == other.height, !pixels.isEmpty else { return true }
        let limit = Int(tolerance)
        // Row by row over the raw bytes: it runs on every look of a wait.
        let (count, minX, minY, maxX, maxY) = pixels.withUnsafeBufferPointer { a in
            other.pixels.withUnsafeBufferPointer { b -> (Int, Int, Int, Int, Int) in
                var count = 0, minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
                for y in 0..<height {
                    let row = y * width
                    for x in 0..<width where abs(Int(a[row + x]) - Int(b[row + x])) > limit {
                        count += 1
                        if x < minX { minX = x }
                        if x > maxX { maxX = x }
                        if y < minY { minY = y }
                        maxY = y
                    }
                }
                return (count, minX, minY, maxX, maxY)
            }
        }
        guard count >= 4 else { return false }
        let caret = maxX - minX <= 3 && maxY - minY <= max(48, height / 10)
        return !caret
    }
}

/// Text matching that survives OCR's habits: case, line breaks, and words
/// split or joined by spacing.
enum TextMatch {
    /// Lowercased. A slashed zero (monospaced fonts such as Menlo) is read
    /// as "Ø" by text recognition: it counts as 0.
    static func folded(_ text: String) -> String {
        text.lowercased().replacingOccurrences(of: "ø", with: "0")
    }

    /// Folded, with runs of whitespace as one space.
    static func normalized(_ text: String) -> String {
        folded(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func contains(_ haystack: String, _ needle: String) -> Bool {
        let wanted = normalized(needle)
        guard !wanted.isEmpty else { return false }
        let text = normalized(haystack)
        if text.contains(wanted) { return true }
        let squeeze = { (value: String) in value.filter { !$0.isWhitespace } }
        if squeeze(text).contains(squeeze(wanted)) { return true }
        // Text recognition confuses 0 with O and 1 with l or I, especially in
        // monospaced fonts: "MARK7DC0E" comes back as "MARK7DCOE".
        return confusable(squeeze(text)).contains(confusable(squeeze(wanted)))
    }

    private static func confusable(_ text: String) -> String {
        String(text.map { character -> Character in
            switch character {
            case "o": return "0"
            case "l", "i", "|", "!": return "1"
            default: return character
            }
        })
    }
}

/// What a wait loop looks at once: recognized or accessible text, and a
/// fingerprint of what is shown (pixels, or the tree's text). A web page
/// judges for itself: whether it shows the text, and whether it has
/// finished loading and gone quiet.
struct WaitObservation {
    var text: String?
    var fingerprint: PixelFingerprint?
    var textFingerprint: String?
    var found: Bool?
    var settled: Bool?
}

/// Thrown by a wait's checks to stop it with a reason (lock change, window
/// closed, app quit); nothing is retried after one.
struct WaitStopped: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// The outcome of a wait: met, timed out, or stopped (with why).
enum WaitResult: Equatable {
    case met(seconds: Double)
    case timedOut(seconds: Double)
    case stopped(seconds: Double, reason: String)
    case cancelled(seconds: Double)

    var seconds: Double {
        switch self {
        case .met(let s), .timedOut(let s), .stopped(let s, _), .cancelled(let s): return s
        }
    }
}

/// Polls without sending anything until a text appears (or is gone), or the
/// observation stops changing for `stableFor` seconds. Clock, sleep, checks
/// and observations are injected, so the logic is tested without a window.
struct WaitEngine {
    var text: String?
    var gone = false
    var stableFor: Double = 1
    var timeout: Double
    var interval: Double = 0.3
    /// When set, looks back off while nothing changes (×1.5 per look, up to
    /// this) and return to `interval` after a change: fewer captures while
    /// the window is idle.
    var maxInterval: Double?

    func run(
        now: () -> Double,
        sleep: (Double) async throws -> Void,
        check: () throws -> Void,
        observe: () async throws -> WaitObservation
    ) async -> WaitResult {
        let started = now()
        var previous: WaitObservation?
        var unchangedSince = started
        var delay = interval
        let waitingForText = !(text ?? "").isEmpty
        while true {
            do {
                try Task.checkCancellation()
                try check()
                let current = try await observe()
                try check()
                let moved = previous.map { changed($0, current) } ?? true
                if moved {
                    unchangedSince = now()
                    delay = interval
                } else if let maxInterval {
                    delay = min(maxInterval, delay * 1.5)
                }
                previous = current
                if waitingForText, let text {
                    if let seen = current.found ?? current.text.map({ TextMatch.contains($0, text) }), seen != gone {
                        return .met(seconds: now() - started)
                    }
                } else if current.settled ?? (!moved && now() - unchangedSince >= stableFor) {
                    return .met(seconds: now() - started)
                }
                if now() - started >= timeout { return .timedOut(seconds: now() - started) }
                // Look again when it can matter: no later than when the window
                // would have been stable long enough, or the time is up.
                var wait = delay
                if !waitingForText, current.settled == nil { wait = min(wait, max(0.05, stableFor - (now() - unchangedSince))) }
                wait = min(wait, max(0.05, timeout - (now() - started)))
                try await sleep(wait)
            } catch let stop as WaitStopped {
                return .stopped(seconds: now() - started, reason: stop.description)
            } catch is CancellationError {
                return .cancelled(seconds: now() - started)
            } catch {
                return .stopped(seconds: now() - started, reason: "\(error)")
            }
        }
    }

    /// Pixels and text (the tree) both count: a canvas animates without the
    /// tree changing, a label changes without many pixels changing.
    private func changed(_ a: WaitObservation, _ b: WaitObservation) -> Bool {
        if let x = a.fingerprint, let y = b.fingerprint {
            return y.changed(from: x) || (a.textFingerprint != nil && a.textFingerprint != b.textFingerprint)
        }
        return a.textFingerprint != b.textFingerprint
    }

    /// One line saying how the wait ended, for the top of the result.
    func describe(_ result: WaitResult) -> String {
        let seconds = formatNumber((result.seconds * 10).rounded() / 10)
        let subject = quote(text ?? "", limit: 60)
        switch result {
        case .met:
            if let text, !text.isEmpty { return gone ? "\(subject) was gone after \(seconds) s." : "\(subject) appeared after \(seconds) s." }
            return "The window stopped changing after \(seconds) s (unchanged for \(formatNumber(stableFor)) s)."
        case .timedOut:
            if let text, !text.isEmpty { return gone ? "\(subject) was still there after \(seconds) s." : "\(subject) did not appear within \(seconds) s." }
            return "The window was still changing after \(seconds) s."
        case .stopped(_, let reason):
            return "Stopped waiting after \(seconds) s: \(reason) Nothing was sent to the app."
        case .cancelled:
            return "The wait was cancelled after \(seconds) s. Nothing was sent to the app."
        }
    }
}

extension WaitEngine {
    /// text, gone, timeout and stable_for as wait_for and browser_wait take them.
    init(_ args: Arguments) throws {
        let timeout = try args.double("timeout") ?? 10
        guard (0.5...60).contains(timeout) else { throw ToolError("timeout must be between 0.5 and 60 seconds.") }
        let stableFor = try args.double("stable_for") ?? 1
        guard (0.3...10).contains(stableFor) else { throw ToolError("stable_for must be between 0.3 and 10 seconds.") }
        let text = args.string("text")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gone = args.bool("gone") ?? false
        if gone, text.isEmpty { throw ToolError("gone needs a text to wait for the disappearance of.") }
        self.init(text: text.isEmpty ? nil : text, gone: gone, stableFor: stableFor, timeout: timeout)
    }
}

extension ComputerUse {
    // MARK: - wait_for

    /// Polls the accessibility tree, sending nothing, until a text shows up (or
    /// goes away), or without a text until the window stops changing; then
    /// returns the fresh state.
    func waitFor(_ args: Arguments) async throws -> ToolResult {
        try requireAccessibility()
        let query = try args.requiredString("app")
        guard case .running(let app) = try directory.resolve(query) else {
            throw ToolError("\(query) is not running. Call get_app_state first; it launches the app in the background.")
        }
        var engine = try WaitEngine(args)
        let text = engine.text ?? ""
        if args.values["region"] != nil {
            throw ToolError("region applies while macOS is locked (pixels); unlocked waits watch the accessibility tree. Wait for a text instead, or without one until the window stops changing.")
        }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appElement, 2)
        await enableAccessibility(app, appElement)
        let windowQuery = args.string("window")?.trimmingCharacters(in: .whitespaces)
        let name = app.localizedName ?? query
        // Look when the app announces a change, and once a second otherwise
        // (not every change is announced). SKFIY_WAIT_EVENTS=0 polls instead.
        let events = ProcessInfo.processInfo.environment["SKFIY_WAIT_EVENTS"] == "0" ? nil : AXChangeEvents(pid: app.processIdentifier)
        defer { events?.stop() }
        // Without notifications to go by (a canvas animating), stability is
        // judged from pixels too, so look a little more often then.
        if events != nil { engine.interval = text.isEmpty ? 0.5 : 1 }
        var looks = 0
        var sawWindow = false
        let watched = windowQuery?.isEmpty == false ? windowQuery : nil
        let started = Date()
        let result = await engine.run(
            now: { Date().timeIntervalSince(started) },
            sleep: { seconds in
                if let events {
                    // An app announcing changes all the time (a progress bar)
                    // is still read no more often than polling would.
                    let began = Date()
                    await events.wait(upTo: seconds)
                    try Task.checkCancellation()
                    let spacing = min(0.25, seconds) - Date().timeIntervalSince(began)
                    if spacing > 0 { try await Task.sleep(nanoseconds: UInt64(spacing * 1_000_000_000)) }
                } else {
                    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                }
            },
            check: {
                if EmergencyStop.isStopped { throw WaitStopped("emergency stop is on.") }
                // While locked, accessibility answers for the lock screen, not the app.
                if isScreenLocked() { throw WaitStopped("the screen locked, and accessibility no longer describes the app.") }
                if app.isTerminated { throw WaitStopped("\(name) quit.") }
            },
            observe: {
                looks += 1
                let snapshot: Snapshot
                do {
                    snapshot = try self.buildSnapshot(app: app, appElement: appElement, windowQuery: watched)
                } catch let error as ToolError where sawWindow && error.description.hasPrefix("No window") {
                    throw WaitStopped("the window closed.")
                } catch {
                    // A window that is not there (yet) proves nothing either way.
                    return WaitObservation(text: nil, textFingerprint: UUID().uuidString)
                }
                sawWindow = true
                var current = snapshot.text
                // A window watched by name is read on its own, not with the
                // app's windows above it.
                let watchedWindow = snapshot.chosenWindow
                let area = watchedWindow?.frame ?? appRegion(pid: app.processIdentifier, focusedWindow: snapshot.focusedWindowFrame)
                if args.bool("ocr") ?? snapshot.opaque, let area,
                   let lines = try? await self.recognizeView(pid: app.processIdentifier, window: watchedWindow, rect: area) {
                    current += "\n" + lines.map(\.text).joined(separator: "\n")
                }
                var observation = WaitObservation(text: current, textFingerprint: current)
                if text.isEmpty, let area,
                   let shot = try? await self.captureView(pid: app.processIdentifier, window: watchedWindow, rect: area), let image = TextRecognition.decode(shot.data) {
                    observation.fingerprint = PixelFingerprint(image, region: nil)
                }
                return observation
            })
        if case .cancelled = result { throw CancellationError() }
        if app.isTerminated { sessions[app.processIdentifier] = nil }
        let outcome = engine.describe(result) + " (\(looks) look\(looks == 1 ? "" : "s")"
            + (events.map { ", woken by \($0.received) accessibility notification\($0.received == 1 ? "" : "s")" } ?? ", polling") + ")"
        if case .stopped = result { throw ToolError(outcome) }
        var state = try await getAppState(args)
        state.text = outcome + "\n" + state.text
        if case .timedOut = result {
            state.isError = true
            if chromiumWindowFrozen(app, window: sessions[app.processIdentifier]?.windowID) {
                state.text = "The window is completely covered by other windows, so Chromium has not been updating it: what was waited for may have happened unseen (see below).\n" + state.text
            }
        }
        return state
    }
}
