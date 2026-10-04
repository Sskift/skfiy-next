import AppKit
import CryptoKit
import Foundation

/// What shows that a step of a flow happened, in a form that can be checked
/// again later — after a reconnect, or after the user took over: a file
/// (and its content), a window of an app, a text in an app or a tab, a
/// finished download.
struct FlowProof: Codable, Equatable {
    var file: String?
    var sha256: String?
    var contains: String?
    var app: String?
    var window: String?
    var text: String?
    var tabID: Int?
    var browser: String?
    var downloadID: Int?

    enum CodingKeys: String, CodingKey {
        case file, sha256, contains, app, window, text, browser
        case tabID = "tab_id"
        case downloadID = "download_id"
    }

    init(file: String? = nil, sha256: String? = nil, contains: String? = nil, app: String? = nil, window: String? = nil,
         text: String? = nil, tabID: Int? = nil, browser: String? = nil, downloadID: Int? = nil) {
        self.file = file
        self.sha256 = sha256
        self.contains = contains
        self.app = app
        self.window = window
        self.text = text
        self.tabID = tabID
        self.browser = browser
        self.downloadID = downloadID
    }

    init(_ raw: Any?) throws {
        guard let object = raw as? [String: Any], !object.isEmpty else {
            throw ToolError("proof is an object: {\"file\": \"/path\", \"contains\": \"…\"}, {\"app\": \"TextEdit\", \"window\": \"report.txt\"}, {\"app\": \"…\", \"text\": \"Saved\"}, {\"tab_id\": 12, \"text\": \"Done\"} or {\"download_id\": 3}.")
        }
        let known: Set<String> = ["file", "sha256", "contains", "app", "window", "text", "tab_id", "browser", "download_id"]
        if let unknown = object.keys.first(where: { !known.contains($0) }) {
            throw ToolError("A proof has no \"\(unknown)\"; use file (with sha256 or contains), app with window or text, tab_id (with text), or download_id.")
        }
        let string = { (key: String) -> String? in
            if let value = object[key] as? String { return nonEmpty(value.trimmingCharacters(in: .whitespacesAndNewlines)) }
            if let number = object[key] as? NSNumber { return number.stringValue }
            return nil
        }
        let int = { (key: String) -> Int? in (object[key] as? NSNumber)?.intValue ?? (object[key] as? String).flatMap { Int($0) } }
        self.init(file: string("file").map { ($0 as NSString).expandingTildeInPath }, sha256: string("sha256")?.lowercased(), contains: object["contains"] as? String,
                  app: string("app"), window: string("window"), text: object["text"] as? String, tabID: int("tab_id"), browser: string("browser"),
                  downloadID: int("download_id"))
        if file == nil, sha256 != nil || contains != nil { throw ToolError("sha256 and contains describe a file: add file.") }
        if window != nil, app == nil { throw ToolError("A window proof needs the app too.") }
        if text != nil, app == nil, tabID == nil { throw ToolError("A text proof needs an app or a tab_id to look in.") }
        if file == nil, app == nil, tabID == nil, downloadID == nil { throw ToolError("A proof needs file, app, tab_id or download_id.") }
        if let file, !(file as NSString).isAbsolutePath { throw ToolError("file must be an absolute path.") }
    }

    /// The file part of the proof, now. Recording fingerprints the content
    /// (sha256) when the proof did not, so a later change shows.
    func checkFile(recording: Bool) -> (FlowCheck, FlowProof) {
        guard let file else { return (.holds(""), self) }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file, isDirectory: &directory), !directory.boolValue else {
            return (.broken("the file \(file) is not there any more"), self)
        }
        var enriched = self
        let hash = sha256Hex(of: file)
        if let sha256 {
            guard hash == sha256 else { return (.broken("the file \(file) has different content than when it was recorded"), self) }
        } else if recording {
            enriched.sha256 = hash
        }
        if let wanted = contains {
            let data = (try? FileHandle(forReadingFrom: URL(fileURLWithPath: file)).read(upToCount: 20_000_000)) ?? nil
            guard String(decoding: data ?? Data(), as: UTF8.self).contains(wanted) else {
                return (.broken("the file \(file) does not contain \(quote(wanted, limit: 40))"), self)
            }
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber)?.int64Value ?? 0
        return (.holds("\(file) (\(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))\(enriched.sha256 != nil ? ", same content" : ""))"), enriched)
    }

    var summary: String {
        var parts: [String] = []
        if let file {
            parts.append("file \(file)" + (sha256 != nil ? " (same content)" : "") + (contains.map { " containing \(quote($0, limit: 40))" } ?? ""))
        }
        if let downloadID { parts.append("finished download \(downloadID)") }
        if let app {
            if let window { parts.append("\(app) window \(quote(window, limit: 60))") }
            if let text { parts.append("\(quote(text, limit: 60)) shown in \(app)") }
            if window == nil, text == nil { parts.append("\(app) running") }
        }
        if let tabID {
            parts.append(text.map { "tab \(tabID) showing \(quote($0, limit: 60))" } ?? "tab \(tabID) open")
        }
        return parts.joined(separator: ", ")
    }
}

/// A flow of steps toward one goal, kept on disk so it survives a
/// disconnect: which steps were verified (and what shows it), which action
/// was sent but not confirmed, and the identities of what they acted on.
struct FlowRecord: Codable, Equatable {
    enum Status: String, Codable { case todo, pending, done }

    struct Step: Codable, Equatable {
        var id: String
        var title: String
        var status: Status = .todo
        var proof: FlowProof?
        var note: String?
        var at: Date?
        /// What the step acted on, as it was then: app pid and launch time,
        /// window id, file size, download path.
        var identity: [String: String] = [:]
    }

    var name: String
    var goal: String?
    var steps: [Step]
    var created: Date
    var updated: Date

    /// A step by id, by number (1-based) or by title.
    func index(of query: String) -> Int? {
        let wanted = query.trimmingCharacters(in: .whitespaces)
        if let exact = steps.firstIndex(where: { $0.id == wanted }) { return exact }
        if let number = Int(wanted), steps.indices.contains(number - 1) { return number - 1 }
        return steps.firstIndex { $0.title.localizedCaseInsensitiveCompare(wanted) == .orderedSame }
    }

    static func steps(_ raw: Any?) throws -> [Step] {
        guard let list = raw as? [Any], !list.isEmpty, list.count <= 50 else {
            throw ToolError("steps is a list of 1-50 steps: titles, or {\"id\": \"download\", \"title\": \"Download the report\"}.")
        }
        var steps: [Step] = []
        for (offset, item) in list.enumerated() {
            if let title = item as? String, let clean = nonEmpty(title.trimmingCharacters(in: .whitespacesAndNewlines)) {
                steps.append(Step(id: String(offset + 1), title: clean))
            } else if let object = item as? [String: Any], let title = nonEmpty((object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)) {
                let id = nonEmpty((object["id"] as? String)?.trimmingCharacters(in: .whitespaces)) ?? String(offset + 1)
                steps.append(Step(id: id, title: title))
            } else {
                throw ToolError("Step \(offset + 1) needs a title.")
            }
        }
        guard Set(steps.map(\.id)).count == steps.count else { throw ToolError("Step ids must differ.") }
        return steps
    }
}

/// Where flows are kept: ~/Library/Application Support/skfiy/flows, or
/// SKFIY_FLOW_DIR.
struct FlowStore {
    let directory: URL

    static var standard: FlowStore {
        if let custom = ProcessInfo.processInfo.environment["SKFIY_FLOW_DIR"], !custom.isEmpty {
            return FlowStore(directory: URL(fileURLWithPath: custom, isDirectory: true))
        }
        return FlowStore(directory: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/skfiy/flows", isDirectory: true))
    }

    static func validName(_ name: String) throws -> String {
        let clean = name.trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty, clean.count <= 80, clean.allSatisfy({ $0.isLetter || $0.isNumber || "-_. ".contains($0) }), !clean.hasPrefix(".") else {
            throw ToolError("A flow name is 1-80 letters, digits, spaces, dots, dashes or underscores.")
        }
        return clean
    }

    private func url(_ name: String) -> URL {
        directory.appendingPathComponent(name.replacingOccurrences(of: " ", with: "_") + ".json")
    }

    func load(_ name: String) throws -> FlowRecord? {
        let file = url(try Self.validName(name))
        guard let data = try? Data(contentsOf: file) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do { return try decoder.decode(FlowRecord.self, from: data) } catch {
            throw ToolError("The saved flow \(quote(name, limit: 40)) could not be read (\(error.localizedDescription)); start it again with restart: true.")
        }
    }

    func save(_ record: FlowRecord) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(record).write(to: url(try Self.validName(record.name)), options: .atomic)
    }

    func names() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
            .filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)).replacingOccurrences(of: "_", with: " ") }.sorted()
    }
}

/// How a proof looked when checked again.
enum FlowCheck: Equatable {
    case holds(String)
    case broken(String)
    /// Could not be checked now (browser not connected, permission missing).
    case unknown(String)
}

/// What a status check concluded for the whole flow.
struct FlowReport: Equatable {
    struct Line: Equatable {
        let index: Int
        let mark: String
        let text: String
    }

    var lines: [Line] = []
    var broken: [String] = []
    var unconfirmed: [String] = []
    var unknown: [String] = []
    var next: String?
    var complete = false

    var needsReplan: Bool { !broken.isEmpty }

    /// Decides from each step's recorded status and how its proof checked now.
    static func evaluate(_ record: FlowRecord, checks: [Int: FlowCheck]) -> (FlowReport, FlowRecord) {
        var report = FlowReport()
        var updated = record
        for (index, step) in record.steps.enumerated() {
            let label = "\(index + 1). \(step.id == String(index + 1) ? "" : step.id + " — ")\(step.title)"
            switch (step.status, checks[index]) {
            case (.done, .holds(let detail)?):
                report.lines.append(Line(index: index, mark: "✓", text: "\(label): still holds — \(detail)"))
            case (.done, .broken(let reason)?):
                report.lines.append(Line(index: index, mark: "✗", text: "\(label): done before, but no longer holds — \(reason)"))
                report.broken.append(step.id)
            case (.done, .unknown(let reason)?):
                report.lines.append(Line(index: index, mark: "~", text: "\(label): done before; cannot be checked now — \(reason)"))
                report.unknown.append(step.id)
            case (.done, nil):
                report.lines.append(Line(index: index, mark: "✓", text: "\(label): done (no proof recorded)"))
            case (.pending, .holds(let detail)?):
                report.lines.append(Line(index: index, mark: "✓", text: "\(label): was pending (about to be done when recorded); it has taken effect — \(detail). Marked done; do not do it again."))
                updated.steps[index].status = .done
                updated.steps[index].note = [step.note, "confirmed by a status check"].compactMap { $0 }.joined(separator: "; ")
            case (.pending, let check):
                let why: String
                switch check {
                case .broken(let reason)?: why = reason
                case .unknown(let reason)?: why = "cannot be checked now: " + reason
                default: why = "nothing to check it by"
                }
                report.lines.append(Line(index: index, mark: "?", text: "\(label): was pending (about to be done when recorded) and is not confirmed (\(why)). It may not have happened, or not finished: look at the app before doing it again, and never repeat a submit, send or payment blindly."))
                report.unconfirmed.append(step.id)
            case (.todo, _):
                report.lines.append(Line(index: index, mark: "·", text: "\(label): to do"))
            }
        }
        if let first = updated.steps.indices.first(where: { report.broken.contains(updated.steps[$0].id) }) {
            report.next = "\(first + 1). \(updated.steps[first].title) (redo: what it produced is gone or changed)"
        } else if let first = updated.steps.indices.first(where: { updated.steps[$0].status != .done }) {
            report.next = "\(first + 1). \(updated.steps[first].title)" + (updated.steps[first].status == .pending ? " (check whether it happened first)" : "")
        } else {
            report.complete = true
        }
        return (report, updated)
    }

    func render(_ record: FlowRecord, checkedAt: Date, locked: Bool) -> String {
        var text = ["Flow \(quote(record.name, limit: 60))" + (record.goal.map { ": \($0)" } ?? ""),
                    "Checked against the current state just now (\(locked ? "macOS locked" : "unlocked")), not taken from memory:"]
        text += lines.map { "  \($0.mark) \($0.text)" }
        if needsReplan {
            let after = record.steps.enumerated().filter { offset, step in
                step.status == .done && !broken.contains(step.id) && offset > (record.steps.firstIndex { broken.contains($0.id) } ?? 0)
            }.map(\.element.id)
            text.append("Replan needed: \(broken.count) step\(broken.count == 1 ? "" : "s") done before no longer hold\(broken.count == 1 ? "s" : "") (\(broken.joined(separator: ", ")))"
                        + (after.isEmpty ? "." : "; steps done after \(broken.count == 1 ? "it" : "them") (\(after.joined(separator: ", "))) were built on \(broken.count == 1 ? "it" : "them") — check them before relying on them."))
        }
        if complete {
            text.append("All steps are done and still hold.")
        } else if let next {
            text.append("Next: \(next)")
        }
        let json: [String: Any] = ["flow": record.name, "complete": complete, "replan": needsReplan, "broken": broken, "unconfirmed": unconfirmed,
                                   "unchecked": unknown, "next": next ?? NSNull(),
                                   "steps": record.steps.map { ["id": $0.id, "status": $0.status.rawValue] }]
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
            text.append("JSON: " + line)
        }
        return text.joined(separator: "\n")
    }
}

func sha256Hex(of path: String) -> String? {
    guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty {
        hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}
