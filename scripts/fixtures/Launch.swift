// Launches an app, or opens documents or URLs in it, without activating it,
// for the test harnesses:
//   Launch <app path> [arguments...] [--open <file or URL>...]
// Prints the pid. If the app activates itself while starting, the front goes
// back to whatever the user had before; the user's own switches are kept.
// (`open -g` is not enough: an app started from the front app's processes,
// a terminal running the tests, may activate itself.)
import AppKit

var arguments = Array(CommandLine.arguments.dropFirst())
var documents: [URL] = []
if let marker = arguments.firstIndex(of: "--open") {
    documents = arguments[(marker + 1)...].map { $0.contains("://") ? URL(string: $0)! : URL(fileURLWithPath: $0) }
    arguments = Array(arguments[..<marker])
}
guard let path = arguments.first else {
    FileHandle.standardError.write(Data("usage: Launch <app path> [arguments...] [--open <file or URL>...]\n".utf8))
    exit(2)
}
let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = false
configuration.addsToRecentItems = false
configuration.createsNewApplicationInstance = false
configuration.arguments = Array(arguments.dropFirst())
var launched: NSRunningApplication?
var failure: Error?
var done = false
var userApp = NSWorkspace.shared.frontmostApplication
let finished = { (app: NSRunningApplication?, error: Error?) in
    launched = app
    failure = error
    done = true
}
if documents.isEmpty {
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration, completionHandler: finished)
} else {
    NSWorkspace.shared.open(documents, withApplicationAt: URL(fileURLWithPath: path), configuration: configuration, completionHandler: finished)
}
while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
guard let app = launched else {
    FileHandle.standardError.write(Data("launch failed: \(failure.map { "\($0)" } ?? "unknown")\n".utf8))
    exit(1)
}
print(app.processIdentifier)
fflush(stdout)
for _ in 0..<60 {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    guard let front = NSWorkspace.shared.frontmostApplication else { continue }
    if front.processIdentifier == app.processIdentifier {
        if let userApp, userApp.processIdentifier != front.processIdentifier { userApp.activate(options: []) }
    } else {
        userApp = front
    }
}
