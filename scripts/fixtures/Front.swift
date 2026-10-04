// Front mode of scripts/compat_baseline.py: `Front activate <pid>` brings an
// app forward (only the test's own app, and only with --allow-front while the
// user is away), then the harness gives the front back the same way.
import AppKit

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 2, arguments[0] == "activate", let pid = pid_t(arguments[1]),
      let app = NSRunningApplication(processIdentifier: pid) else {
    FileHandle.standardError.write(Data("usage: Front activate <pid>\n".utf8))
    exit(2)
}
_ = app.activate(options: [])
for _ in 0..<20 where NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
exit(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid ? 0 : 1)
