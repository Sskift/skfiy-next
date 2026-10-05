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

    /// The share of pixels that differ noticeably; 1 when the sizes differ.
    func changedFraction(from other: PixelFingerprint, tolerance: UInt8 = 16) -> Double {
        guard width == other.width, height == other.height, !pixels.isEmpty else { return 1 }
        var changed = 0
        for index in pixels.indices where abs(Int(pixels[index]) - Int(other.pixels[index])) > Int(tolerance) {
            changed += 1
        }
        return Double(changed) / Double(pixels.count)
    }

    /// Whether anything visibly changed. A blinking text caret is not a
    /// change: its pixels form a thin vertical line. Anything else counts,
    /// down to a few pixels, so a small label changing one word is seen.
    func changed(from other: PixelFingerprint, tolerance: UInt8 = 24) -> Bool {
        guard width == other.width, height == other.height, !pixels.isEmpty else { return true }
        var count = 0, minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
        for index in pixels.indices where abs(Int(pixels[index]) - Int(other.pixels[index])) > Int(tolerance) {
            count += 1
            let x = index % width, y = index / width
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        }
        guard count >= 4 else { return false }
        let caret = maxX - minX <= 3 && maxY - minY <= max(48, height / 10)
        return !caret
    }
}

/// Text matching that survives OCR's habits: case, line breaks, and words
/// split or joined by spacing.
enum TextMatch {
    /// Lowercased with runs of whitespace as one space. A slashed zero
    /// (monospaced fonts such as Menlo) is read as "Ø" by text recognition:
    /// it counts as 0.
    static func normalized(_ text: String) -> String {
        text.lowercased().replacingOccurrences(of: "ø", with: "0").split(whereSeparator: \.isWhitespace).joined(separator: " ")
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
/// fingerprint of what is shown (pixels, or the tree's text).
struct WaitObservation {
    var text: String?
    var fingerprint: PixelFingerprint?
    var textFingerprint: String?
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
            let elapsed = now() - started
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
                    if let seen = current.text, TextMatch.contains(seen, text) != gone {
                        return .met(seconds: now() - started)
                    }
                } else if !moved, now() - unchangedSince >= stableFor {
                    return .met(seconds: now() - started)
                }
                if now() - started >= timeout { return .timedOut(seconds: now() - started) }
                // Look again when it can matter: no later than when the window
                // would have been stable long enough, or the time is up.
                var wait = delay
                if !waitingForText { wait = min(wait, max(0.05, stableFor - (now() - unchangedSince))) }
                wait = min(wait, max(0.05, timeout - (now() - started)))
                try await sleep(wait)
            } catch let stop as WaitStopped {
                return .stopped(seconds: now() - started, reason: stop.description)
            } catch is CancellationError {
                return .cancelled(seconds: now() - started)
            } catch {
                return .stopped(seconds: max(elapsed, now() - started), reason: "\(error)")
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
