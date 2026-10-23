import Foundation

/// Tab IDs are unique only inside one browser process.
struct BrowserTab: Hashable {
    let socket: String
    let pid: Int
    let tab: Int

    init(_ browser: ConnectedBrowser, _ tab: Int) {
        socket = browser.socketPath; pid = browser.pid; self.tab = tab
    }

    var guardKey: String { "\(socket)|\(pid)|\(tab)" }
}

struct BrowserGeometry: Equatable {
    let document: String
    let url: String
    let width: Double
    let height: Double
    let x: Double
    let y: Double
    let scale: Double
    let revision: Int

    init?(_ raw: Any?) {
        guard let raw = raw as? [String: Any], let document = raw["document"] as? String,
              let url = raw["url"] as? String, let revision = raw["revision"] as? Int else { return nil }
        let numbers = ["width", "height", "x", "y", "scale"].compactMap { (raw[$0] as? NSNumber)?.doubleValue }
        guard numbers.count == 5, numbers.allSatisfy(\.isFinite), numbers[0] > 0, numbers[1] > 0, numbers[4] > 0 else { return nil }
        self.document = document; self.url = url; self.revision = revision
        width = numbers[0]; height = numbers[1]; x = numbers[2]; y = numbers[3]; scale = numbers[4]
    }

    var json: [String: Any] {
        ["document": document, "url": url, "width": width, "height": height, "x": x, "y": y, "scale": scale, "revision": revision]
    }
}

struct BrowserScreenshot {
    let geometry: BrowserGeometry
    let width: Int
    let height: Int
    let captured: Date
    static let lifetime: TimeInterval = 30

    func matches(_ current: BrowserGeometry?, now: Date = Date()) -> Bool {
        current == geometry && width > 0 && height > 0 && (0..<Self.lifetime).contains(now.timeIntervalSince(captured))
    }

    func point(x: Double, y: Double) throws -> (Double, Double) {
        guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(width), y < Double(height) else {
            throw ToolError("x/y must be inside this browser tab's latest screenshot.")
        }
        return (x * geometry.width / Double(width), y * geometry.height / Double(height))
    }

    func rect(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX * geometry.width / Double(width), y: rect.minY * geometry.height / Double(height),
               width: rect.width * geometry.width / Double(width), height: rect.height * geometry.height / Double(height))
    }
}

struct BrowserActionFailure: Error, CustomStringConvertible {
    let status: String
    let description: String
}

/// The transport's acknowledgement is separate from the observed outcome.
struct BrowserActionOutcome {
    var status: String
    var verification: String = "unknown"
    var detail: String

    var result: ToolResult {
        ToolResult(text: "Action: \(status). Verification: \(verification).\n\(detail)",
                   isError: status != "sent" || !["verified", "not_requested"].contains(verification),
                   structuredContent: ["action": ["status": status], "verification": ["status": verification], "detail": detail])
    }
}
