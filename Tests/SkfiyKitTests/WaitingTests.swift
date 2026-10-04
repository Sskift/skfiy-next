import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

/// A clock the engine's sleep advances, and observations scripted by time.
private final class Script: @unchecked Sendable {
    var time = 0.0
    var checks = 0
    var observations = 0
    func now() -> Double { time }
    func sleep(_ seconds: Double) async throws {
        try Task.checkCancellation()
        time += seconds
    }
}

private func gray(_ value: UInt8, changed: Int = 0) -> PixelFingerprint {
    var pixels = [UInt8](repeating: value, count: 100 * 50)
    for index in 0..<changed { pixels[index] = value &+ 100 }
    return PixelFingerprint(width: 100, height: 50, pixels: pixels)
}

struct WaitingTests {
    @Test func textAppearsAfterADelay() async {
        let script = Script()
        let engine = WaitEngine(text: "Ready 42", timeout: 10, interval: 0.5)
        let result = await engine.run(now: script.now, sleep: script.sleep, check: {}, observe: {
            WaitObservation(text: script.time >= 3 ? "Status:\nREADY  42 done" : "Status: loading")
        })
        #expect(result == .met(seconds: 3))
        #expect(engine.describe(result) == "\"Ready 42\" appeared after 3 s.")
    }

    @Test func textGoneAndOCRSplitWords() async {
        let script = Script()
        let gone = WaitEngine(text: "Loading", gone: true, timeout: 10, interval: 0.5)
        let result = await gone.run(now: script.now, sleep: script.sleep, check: {}, observe: {
            WaitObservation(text: script.time < 2 ? "Loading…" : "Done")
        })
        #expect(result == .met(seconds: 2))
        // OCR splits "6a9344d055" into pieces, or joins words; spacing is ignored.
        #expect(TextMatch.contains("TextEdit line 010\n6a93 44d055", "6a9344d055"))
        #expect(TextMatch.contains("SavedAll", "saved all"))
        #expect(!TextMatch.contains("Saved", "unsaved"))
    }

    @Test func stableAfterAnimationIgnoringACaret() async {
        let script = Script()
        let engine = WaitEngine(stableFor: 1, timeout: 10, interval: 0.25)
        let result = await engine.run(now: script.now, sleep: script.sleep, check: {}, observe: {
            // Animating until 3 s, then only a caret blinking (2 of 5000 pixels).
            script.time < 3 ? WaitObservation(fingerprint: gray(UInt8(Int(script.time * 4) * 37 % 250)))
                : WaitObservation(fingerprint: gray(10, changed: Int(script.time * 4) % 2 * 2))
        })
        guard case .met(let seconds) = result else { Issue.record("not met: \(result)"); return }
        #expect(seconds >= 4 && seconds <= 4.5)
    }

    @Test func timesOutWithTheCurrentState() async {
        let script = Script()
        let engine = WaitEngine(text: "never", timeout: 2, interval: 0.5)
        let result = await engine.run(now: script.now, sleep: script.sleep, check: {}, observe: { WaitObservation(text: "something else") })
        #expect(result == .timedOut(seconds: 2))
        #expect(engine.describe(result) == "\"never\" did not appear within 2 s.")
        let stable = WaitEngine(timeout: 1, interval: 0.25)
        let changing = await stable.run(now: script.now, sleep: script.sleep, check: {}, observe: {
            WaitObservation(fingerprint: gray(UInt8(Int(script.time * 8) * 37 % 250)))
        })
        guard case .timedOut = changing else { Issue.record("expected timeout: \(changing)"); return }
    }

    @Test func lockChangeStopsTheWaitWithItsReason() async {
        let script = Script()
        let engine = WaitEngine(text: "never", timeout: 30, interval: 0.5)
        let result = await engine.run(now: script.now, sleep: script.sleep, check: {
            script.checks += 1
            if script.time >= 1.5 { throw WaitStopped("macOS was unlocked, so direct screenshots no longer apply.") }
        }, observe: {
            script.observations += 1
            return WaitObservation(text: "x")
        })
        #expect(result == .stopped(seconds: 1.5, reason: "macOS was unlocked, so direct screenshots no longer apply."))
        #expect(engine.describe(result).hasPrefix("Stopped waiting after 1.5 s: macOS was unlocked"))
        #expect(engine.describe(result).hasSuffix("Nothing was sent to the app."))
        #expect(script.observations == 3)
    }

    @Test func windowClosingStopsFromTheObservation() async {
        let script = Script()
        let engine = WaitEngine(timeout: 30, interval: 0.5)
        let result = await engine.run(now: script.now, sleep: script.sleep, check: {}, observe: {
            if script.time >= 1 { throw WaitStopped("the window closed.") }
            return WaitObservation(fingerprint: gray(UInt8(script.time * 100)))
        })
        #expect(result == .stopped(seconds: 1, reason: "the window closed."))
    }

    @Test func cancellationEndsTheWait() async {
        let engine = WaitEngine(text: "never", timeout: 60, interval: 0.05)
        let started = Date()
        let task = Task { await engine.run(now: { Date().timeIntervalSince(started) },
                                           sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1e9)) },
                                           check: {}, observe: { WaitObservation(text: "x") }) }
        try? await Task.sleep(nanoseconds: 200_000_000)
        task.cancel()
        let result = await task.value
        guard case .cancelled(let seconds) = result else { Issue.record("not cancelled: \(result)"); return }
        #expect(seconds < 2)
    }

    @Test func smallTextChangeCountsButACaretDoesNot() {
        let width = 640, height = 480
        let base = PixelFingerprint(width: width, height: height, pixels: [UInt8](repeating: 230, count: width * height))
        var label = base.pixels
        // "ready" becoming "apply 1" in a small status label: a few dozen pixels.
        for y in 20..<27 { for x in 40..<52 where (x + y) % 3 == 0 { label[y * width + x] = 20 } }
        #expect(PixelFingerprint(width: width, height: height, pixels: label).changed(from: base))
        var caret = base.pixels
        for y in 100..<118 { caret[y * width + 300] = 0; caret[y * width + 301] = 60 }
        #expect(!PixelFingerprint(width: width, height: height, pixels: caret).changed(from: base))
        var both = caret
        for y in 20..<27 { for x in 40..<52 { both[y * width + x] = 20 } }
        #expect(PixelFingerprint(width: width, height: height, pixels: both).changed(from: base))
        #expect(!base.changed(from: base))
    }

    @Test func fingerprintsOfImages() throws {
        func image(_ color: CGFloat, square: CGRect? = nil) throws -> CGImage {
            let context = try #require(CGContext(data: nil, width: 200, height: 100, bitsPerComponent: 8, bytesPerRow: 0,
                                                 space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
            context.setFillColor(CGColor(gray: color, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 100))
            if let square {
                context.setFillColor(CGColor(gray: 1 - color, alpha: 1))
                context.fill(square)
            }
            return try #require(context.makeImage())
        }
        let plain = try #require(PixelFingerprint(try image(0.2)))
        let same = try #require(PixelFingerprint(try image(0.2)))
        let marked = try #require(PixelFingerprint(try image(0.2, square: CGRect(x: 0, y: 0, width: 40, height: 40))))
        #expect(plain.changedFraction(from: same) == 0)
        #expect(marked.changedFraction(from: plain) > 0.05)
        // CG draws bottom-up: y 0-40 is the image's bottom; a region of the top half misses it.
        let topHalf = CGRect(x: 0, y: 0, width: 200, height: 50)
        let a = try #require(PixelFingerprint(try image(0.2), region: topHalf))
        let b = try #require(PixelFingerprint(try image(0.2, square: CGRect(x: 0, y: 0, width: 40, height: 40)), region: topHalf))
        #expect(a.changedFraction(from: b) == 0)
        #expect(PixelFingerprint(try image(0.2), region: CGRect(x: 500, y: 500, width: 10, height: 10)) == nil)
    }
}
