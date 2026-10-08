import Foundation

/// Typed access to a tool call's JSON arguments.
public struct Arguments {
    let values: [String: Any]

    public init(_ values: [String: Any]) {
        self.values = values
    }

    func string(_ key: String) -> String? {
        if let string = values[key] as? String {
            return string
        }
        if let number = values[key] as? NSNumber, !isBoolean(number) {
            return number.stringValue
        }
        return nil
    }

    func requiredString(_ key: String) throws -> String {
        guard let value = string(key), !value.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw ToolError("Missing required argument \"\(key)\".")
        }
        return value
    }

    func bool(_ key: String) -> Bool? {
        values[key] as? Bool
    }

    /// A path with ~ expanded, which must be absolute.
    func absolutePath(_ key: String) throws -> String {
        let path = (try requiredString(key).trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
        guard path.hasPrefix("/") else {
            throw ToolError("\"\(key)\" must be an absolute path.")
        }
        return path
    }

    /// Text arguments where whitespace is meaningful.
    func requiredText(_ key: String) throws -> String {
        guard let value = values[key] as? String else {
            throw ToolError("Missing required argument \"\(key)\".")
        }
        return value
    }

    func double(_ key: String) throws -> Double? {
        guard let raw = values[key], !(raw is NSNull) else { return nil }
        if let number = raw as? NSNumber, !isBoolean(number) {
            return number.doubleValue
        }
        if let string = raw as? String, let value = Double(string.trimmingCharacters(in: .whitespaces)) {
            return value
        }
        throw ToolError("Argument \"\(key)\" must be a number.")
    }

    func int(_ key: String) throws -> Int? {
        guard let value = try double(key) else { return nil }
        guard value.rounded() == value, abs(value) < 9e15 else {
            throw ToolError("Argument \"\(key)\" must be an integer.")
        }
        return Int(value)
    }

    /// Element indices arrive as strings ("12") or numbers; "[12]" is tolerated.
    func elementIndex(_ key: String = "element_index") throws -> Int? {
        guard var raw = string(key)?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else {
            return nil
        }
        if raw.hasPrefix("["), raw.hasSuffix("]") {
            raw = String(raw.dropFirst().dropLast())
        }
        guard let index = Int(raw), index >= 0 else {
            throw ToolError("\"\(key)\" must be an element index such as \"12\" from get_app_state.")
        }
        return index
    }
}

private func isBoolean(_ number: NSNumber) -> Bool {
    CFGetTypeID(number) == CFBooleanGetTypeID()
}
