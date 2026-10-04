// Launches an app without activating it, for the test harnesses:
//   Launch <app path> [arguments...]
// Prints the pid. If the app activates itself while starting, the front goes
// back to whatever the user had before; the user's own switches are kept.
import AppKit

let arguments = Array(CommandLine.arguments.dropFirst())
guard let path = arguments.first else {
    FileHandle.standardError.write(Data("usage: Launch <app path> [arguments...]\n".utf8))
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
NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration) { app, error in
    launched = app
    failure = error
    done = true
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
