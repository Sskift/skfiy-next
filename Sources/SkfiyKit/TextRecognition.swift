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
    static func recognize(_ image: CGImage, showing region: CGRect) async throws -> [RecognizedText] {
        let box = UncheckedImage(image)
        return try await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP", "ko-KR"]
            request.automaticallyDetectsLanguage = true
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

    static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}

private struct UncheckedImage: @unchecked Sendable {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}
