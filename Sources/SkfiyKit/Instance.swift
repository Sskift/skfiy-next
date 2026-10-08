import Foundation

/// ScreenCaptureKit serves only one process per executable path at a time: a
/// second skfiy started from the same binary (say, a second Claude Code
/// session) waits forever for its screenshots. So each MCP server runs from a
/// hard link of its own, named after its pid and removed when it exits; links
/// left by servers that were killed are cleaned up by the next one.
public enum Instance {
    static let directory = SkfiyPaths.caches.appendingPathComponent("instances")
    static let variable = "SKFIY_INSTANCE"

    /// Re-executes this process from its own hard link. Returns only when that
    /// is not possible (e.g. the cache folder is on another volume), in which
    /// case skfiy runs as it is.
    public static func runFromOwnLink() {
        guard ProcessInfo.processInfo.environment[variable] == nil,
              let executable = Bundle.main.executableURL?.resolvingSymlinksInPath().path else {
            return
        }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        removeStaleLinks()
        let path = directory.appendingPathComponent("skfiy-\(getpid())").path
        unlink(path)
        guard link(executable, path) == 0 else { return }
        setenv(variable, path, 1)
        var arguments = CommandLine.arguments.map { strdup($0) }
        arguments[0] = strdup(path)
        arguments.append(nil)
        execv(path, arguments)
        unlink(path)  // exec failed; carry on from the original binary
        unsetenv(variable)
    }

    /// Removes this process's link; call when exiting.
    public static func removeOwnLink() {
        if let path = ProcessInfo.processInfo.environment[variable] {
            unlink(path)
        }
    }

    static func removeStaleLinks() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix("skfiy-") {
            guard let pid = pid_t(name.dropFirst("skfiy-".count)) else { continue }
            if kill(pid, 0) != 0, errno == ESRCH {
                unlink(directory.appendingPathComponent(name).path)
            }
        }
    }
}
