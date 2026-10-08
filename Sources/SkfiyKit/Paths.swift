import Foundation

/// Where skfiy keeps its files. Foundation's home directory ignores $HOME, so
/// an install run with HOME set to a scratch folder (tests, packagers, a
/// staged install) would still write into the real ~/Library. skfiy's own
/// state follows $HOME instead. Paths that point at the user's documents on
/// screen (file panels, recent apps) keep the real home on purpose.
public enum SkfiyPaths {
    /// $HOME when it is an absolute path, else the account's home folder.
    public static var home: URL { home(environment: ProcessInfo.processInfo.environment) }

    static func home(environment: [String: String]) -> URL {
        if let value = environment["HOME"], value.hasPrefix("/"), value.count > 1 {
            return URL(fileURLWithPath: value, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    /// ~/Library/Application Support
    public static var applicationSupport: URL { home.appendingPathComponent("Library/Application Support", isDirectory: true) }
    /// ~/Library/Application Support/skfiy
    public static var support: URL { applicationSupport.appendingPathComponent("skfiy", isDirectory: true) }
    /// ~/Library/Caches/skfiy
    public static var caches: URL { home.appendingPathComponent("Library/Caches/skfiy", isDirectory: true) }
    /// ~/Library/Logs/skfiy
    public static var logs: URL { home.appendingPathComponent("Library/Logs/skfiy", isDirectory: true) }
    /// The unpacked browser extension that Chrome loads.
    public static var browserExtension: URL { support.appendingPathComponent("browser-extension", isDirectory: true) }

    /// The path this binary was started as, without resolving symlinks: a
    /// Homebrew-style link keeps working after an upgrade, the Cellar path
    /// behind it does not.
    public static var executable: String {
        if let url = Bundle.main.executableURL { return url.path }
        let argument = CommandLine.arguments[0]
        return argument.hasPrefix("/") ? argument : FileManager.default.currentDirectoryPath + "/" + argument
    }

    /// `path` with the home folder written as ~, for messages.
    public static func abbreviated(_ path: String) -> String {
        let prefix = home.path
        return path == prefix ? "~" : path.hasPrefix(prefix + "/") ? "~" + path.dropFirst(prefix.count) : path
    }
}
