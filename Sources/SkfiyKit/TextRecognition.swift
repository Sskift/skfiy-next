import CoreGraphics
import Foundation
import ImageIO
import Vision

/// A line of text recognized in a screenshot, in screen points.
struct RecognizedText: Equatable {
    var text: String
    var frame: CGRect
}

/// Text in apps that publish no accessibility (custom-drawn or embedded web
/// UIs), read from the pixels on this Mac with the Vision framework.
enum TextRecognition {
    /// Recognizes the text of `image`, which shows `region` (screen points).
    /// Takes a few hundred milliseconds, so it runs off the main thread.
    static func recognize(_ image: CGImage, showing region: CGRect, fast: Bool = false) async throws -> [RecognizedText] {
        let box = UncheckedImage(image)
        return try await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            if fast {
                // Latin text only, character by character: no language model.
                request.recognitionLevel = .fast
                request.usesLanguageCorrection = false
                request.recognitionLanguages = ["en-US"]
            } else {
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = true
                request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP", "ko-KR"]
                request.automaticallyDetectsLanguage = true
            }
            try VNImageRequestHandler(cgImage: box.image, options: [:]).perform([request])
            // Vision's boxes are normalized, with the origin at the bottom left.
            let toScreen = { (box: CGRect) in
                CGRect(x: region.minX + box.minX * region.width, y: region.minY + (1 - box.maxY) * region.height,
                       width: box.width * region.width, height: box.height * region.height)
            }
            return (request.results ?? []).flatMap { observation -> [RecognizedText] in
                guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.3 else { return [] }
                let line = toScreen(observation.boundingBox)
                // Vision joins labels on one row ("Send  Cancel"); split at wide gaps.
                var pieces: [RecognizedText] = []
                let string = candidate.string
                var searchStart = string.startIndex
                for word in string.split(whereSeparator: \.isWhitespace) {
                    guard let range = string.range(of: word, range: searchStart..<string.endIndex) else { continue }
                    searchStart = range.upperBound
                    let frame = (try? candidate.boundingBox(for: range)).map { toScreen($0.boundingBox) } ?? line
                    if let last = pieces.last, frame.minX - last.frame.maxX < line.height * 1.2 {
                        pieces[pieces.count - 1] = RecognizedText(text: last.text + " " + word, frame: last.frame.union(frame))
                    } else {
                        pieces.append(RecognizedText(text: String(word), frame: frame))
                    }
                }
                return pieces
            }
        }.value
    }

    /// Recognizes at display resolution, then fills in what that missed from
    /// two more passes: the fast (character by character) recognizer at the
    /// same resolution, and the accurate one at about one pixel per point.
    /// Small text reads better at full resolution; but the accurate
    /// recognizer sometimes returns nothing but the title for a page of
    /// monospaced lines (a TextEdit document in Menlo) that the fast one
    /// reads whole, or reads it at the lower size in pieces.
    static func recognizeBoth(_ hires: CGImage, showing region: CGRect) async throws -> [RecognizedText] {
        let full = try await recognize(hires, showing: region)
        var result = merged(full, with: try await recognize(hires, showing: region, fast: true))
        defer { dumpForDiagnosis(hires, result) }
        let scale = captureScale(for: region.size, maxScale: 1)
        let width = max(1, Int((region.width * scale).rounded())), height = max(1, Int((region.height * scale).rounded()))
        guard width < hires.width, let lower = resized(hires, width: width, height: height) else { return result }
        result = merged(result, with: try await recognize(lower, showing: region))
        return result
    }

    /// `primary` plus the `extra` lines it does not already cover. An extra
    /// line that reads more where primary has only fragments (Vision at full
    /// resolution sometimes drops a long glued word and keeps the rest of the
    /// line in pieces) replaces those fragments.
    static func merged(_ primary: [RecognizedText], with extra: [RecognizedText]) -> [RecognizedText] {
        let letters = { (text: String) in String(text.lowercased().replacingOccurrences(of: "ø", with: "0").filter { $0.isLetter || $0.isNumber }) }
        var result = primary
        for line in extra {
            let overlapping = result.indices.filter { index in
                let other = result[index]
                let shared = other.frame.intersection(line.frame)
                guard !shared.isNull else { return false }
                return shared.width * shared.height >= 0.3 * min(line.frame.width * line.frame.height, other.frame.width * other.frame.height)
            }
            if overlapping.isEmpty {
                result.append(line)
                continue
            }
            let pieces = letters(overlapping.map { result[$0].text }.joined())
            let whole = letters(line.text)
            if whole.count >= pieces.count + 3, isSubsequence(pieces, of: whole) {
                for index in overlapping.reversed() { result.remove(at: index) }
                result.append(line)
            }
        }
        return result
    }

    /// Whether `part` appears in `whole` in order, possibly with gaps
    /// (fragments with a word missing between them).
    static func isSubsequence(_ part: String, of whole: String) -> Bool {
        var remaining = Substring(whole)
        for character in part {
            guard let found = remaining.firstIndex(of: character) else { return false }
            remaining = remaining[remaining.index(after: found)...]
        }
        return true
    }

    /// Reading order: rows top to bottom (lines whose middles fall within
    /// half a line of each other share a row), each row left to right.
    static func sorted(_ lines: [RecognizedText]) -> [RecognizedText] {
        var rows: [[RecognizedText]] = []
        for line in lines.sorted(by: { $0.frame.midY < $1.frame.midY }) {
            if let first = rows.last?.first, abs(line.frame.midY - first.frame.midY) <= first.frame.height / 2 {
                rows[rows.count - 1].append(line)
            } else {
                rows.append([line])
            }
        }
        return rows.flatMap { $0.sorted { $0.frame.minX < $1.frame.minX } }
    }

    /// With SKFIY_OCR_DUMP=<directory>: each recognized image and its lines
    /// are written there, to look into misreadings.
    private static func dumpForDiagnosis(_ image: CGImage, _ lines: [RecognizedText]) {
        guard let directory = ProcessInfo.processInfo.environment["SKFIY_OCR_DUMP"], !directory.isEmpty else { return }
        let stem = "\(directory)/ocr-\(Int(Date().timeIntervalSince1970 * 1000))"
        if let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: stem + ".png") as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(destination, image, nil)
            CGImageDestinationFinalize(destination)
        }
        try? lines.map(\.text).joined(separator: "\n").write(toFile: stem + ".txt", atomically: true, encoding: .utf8)
    }

    static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}

private struct UncheckedImage: @unchecked Sendable {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}
