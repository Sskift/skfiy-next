import CoreGraphics
import Foundation

/// A small grayscale copy of a screenshot, for telling whether a window's
/// pixels changed without OCR or sending the model another image.
struct PixelFingerprint: Equatable, Sendable {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    /// `region` is in the image's own pixel space (top-left origin); nil is the whole image.
    init?(_ image: CGImage, region: CGRect? = nil, width: Int = 160) {
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

    /// Below this share a frame counts as unchanged: a blinking caret or a
    /// cursor-sized redraw does not keep a window "changing".
    static let stillThreshold = 0.002
}

/// Text matching that survives OCR's habits: case, line breaks, and words
/// split or joined by spacing.
enum TextMatch {
    static func normalized(_ text: String) -> String {
        text.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func contains(_ haystack: String, _ needle: String) -> Bool {
        let wanted = normalized(needle)
        guard !wanted.isEmpty else { return false }
        let text = normalized(haystack)
        if text.contains(wanted) { return true }
        let squeeze = { (value: String) in value.filter { !$0.isWhitespace } }
        return squeeze(text).contains(squeeze(wanted))
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

    func run(
        now: () -> Double,
        sleep: (Double) async throws -> Void,
        check: () throws -> Void,
        observe: () async throws -> WaitObservation
    ) async -> WaitResult {
        let started = now()
        var last: WaitObservation?
        var unchangedSince = started
        while true {
            let elapsed = now() - started
            do {
                try Task.checkCancellation()
                try check()
                let current = try await observe()
                try check()
                if let text, !text.isEmpty {
                    if let seen = current.text, TextMatch.contains(seen, text) != gone {
                        return .met(seconds: now() - started)
                    }
                } else {
                    if let last, !changed(last, current) {
                        if now() - unchangedSince >= stableFor { return .met(seconds: now() - started) }
                    } else {
                        unchangedSince = now()
                    }
                    last = current
                }
                if now() - started >= timeout { return .timedOut(seconds: now() - started) }
                try await sleep(interval)
            } catch let stop as WaitStopped {
                return .stopped(seconds: now() - started, reason: stop.description)
            } catch is CancellationError {
                return .cancelled(seconds: now() - started)
            } catch {
                return .stopped(seconds: max(elapsed, now() - started), reason: "\(error)")
            }
        }
    }

    private func changed(_ a: WaitObservation, _ b: WaitObservation) -> Bool {
        if let x = a.fingerprint, let y = b.fingerprint {
            return x.changedFraction(from: y) > PixelFingerprint.stillThreshold
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
