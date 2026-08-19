import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Dispatch
import Foundation
import IOKit
import Vision

/*
 JSON output contract:

 The helper writes exactly one JSON object to stdout for every invocation.
 Successful commands exit 0 and use:
 {
   "ok": true,
   "command": "<command-name>",
   "data": { ... command-specific payload ... }
 }

 Failed commands exit non-zero and use:
 {
   "ok": false,
   "command": "<command-name-or-unknown>",
   "error": {
     "code": "<stable_machine_code>",
     "message": "<human-readable message>",
     "details": { ... optional structured context ... }
   }
 }

 Command payloads:
 - list-apps:
   data.apps[] = {
     bundleId: String | null,
     localizedName: String | null,
     processIdentifier: Number,
     isActive: Boolean,
     activationPolicy: "regular" | "accessory" | "prohibited" | "unknown"
   }
 - desktop-session-status:
   data = {
     frontmostBundleId: String | null,
     frontmostLocalizedName: String | null,
     frontmostProcessIdentifier: Number | null,
     mainDisplayAsleep: Boolean,
     ioConsoleLocked: Boolean | null,
     cgSessionScreenIsLocked: Boolean | null,
     controllable: Boolean
   }
 - activate-app --bundle-id <id> [--pid <process-id>]:
   data = {
     bundleId: String,
     processIdentifier: Number,
     activated: Boolean,
     requestedActivation: Boolean,
     frontmostBundleId: String | null,
     frontmostProcessIdentifier: Number | null
   }
 - open-ghostty-session --title <title> [--working-directory <path>]:
   data = {
     bundleId: "com.mitchellh.ghostty",
     title: String,
     workingDirectory: String | null,
     appURL: String,
     arguments: [String],
     processIdentifier: Number,
     opened: Boolean
   }
 - screenshot --output <path>:
   data = { output: String }
 - ocr-image --input <path>:
   data = {
     labels: [{
       text: String,
       confidence: Number,
       bounds: { x: Number, y: Number, width: Number, height: Number }
     }]
	   }
	 - get-finder-selection:
	   data = {
	     source: "finder-applescript",
     frontmostBundleId: String | null,
     targetPath: String | null,
     selection: [{
       path: String,
       name: String,
       kind: "file" | "directory" | "other"
	     }]
	   }
	 - get-finder-item-layout --folder <path> --items <comma-separated names>:
	   data = {
	     source: "finder-applescript-layout",
	     frontmostBundleId: String | null,
	     folderPath: String,
	     items: [{
	       path: String,
	       name: String,
	       kind: "file" | "directory" | "other",
	       center: { x: Number, y: Number },
	       bounds: { x: Number, y: Number, width: Number, height: Number }
	     }]
	   }
	 - click --x <n> --y <n>:
   data = { x: Number, y: Number }
 - scroll --delta-x <n> --delta-y <n>:
   data = { deltaX: Number, deltaY: Number }
 - drag --from-x <n> --from-y <n> --to-x <n> --to-y <n> [--duration-ms <n>]:
   data = { from: { x: Number, y: Number }, to: { x: Number, y: Number }, durationMs: Number }
 - type-text --text <text>:
   data = { textLength: Number }
 - press-key --key enter|escape|space:
   data = { key: String }
 - press-shortcut --key enter|escape|space --modifiers control,option,command,shift:
   data = { key: String, modifiers: [String] }
 - select-input-source --source-id <id>:
   data = { sourceId: String }
 - double-tap-fn:
   data = { key: "fn", taps: 2 }
 - get-app-state --bundle-id <id> [--pid <process-id>] --screenshot-output <path>:
   data = {
     app: <same shape as list-apps item>,
     frontmostBundleId: String | null,
     accessibilityTrusted: Boolean,
     screenshot: { output: String },
     windows: [{
       title: String | null,
       layer: Number,
       bounds: { x: Number, y: Number, width: Number, height: Number }
     }]
   }
 - permissions-status:
   data = {
     screenRecording: { status: String, granted: Boolean },
     accessibility: { status: String, granted: Boolean }
   }
 - open-permission-settings --permission screen-recording|accessibility:
   data = { permission: String, url: String, opened: Boolean }

 Security contract:
 - This helper never executes shell commands.
 - Application launch is allowlisted; it only opens Ghostty through NSWorkspace.
 - The only subprocess it starts is /usr/sbin/screencapture, and only for
   screenshot capture.
 - Finder semantic observation uses in-process Apple Events and returns a
   structured permission error if macOS Automation consent is missing.
 */

let supportedCommands = [
    "list-apps",
    "desktop-session-status",
    "activate-app",
    "open-ghostty-session",
    "screenshot",
    "ocr-image",
    "get-finder-selection",
    "get-finder-item-layout",
    "click",
    "scroll",
    "drag",
    "type-text",
    "press-key",
    "press-shortcut",
    "select-input-source",
    "double-tap-fn",
    "get-app-state",
    "permissions-status",
    "open-permission-settings"
]

enum JSONValue: Encodable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case strings([String])

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch self {
        case .string(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .strings(let value):
            try container.encode(value)
        }
    }
}

struct HelperFailure: Error {
    let code: String
    let message: String
    let details: [String: JSONValue]

    init(_ code: String, _ message: String, details: [String: JSONValue] = [:]) {
        self.code = code
        self.message = message
        self.details = details
    }
}

struct SuccessResponse<Payload: Encodable>: Encodable {
    let ok = true
    let command: String
    let data: Payload
}

struct FailureResponse: Encodable {
    let ok = false
    let command: String
    let error: FailurePayload
}

struct FailurePayload: Encodable {
    let code: String
    let message: String
    let details: [String: JSONValue]?
}

struct AppInfo: Encodable {
    let bundleId: String?
    let localizedName: String?
    let processIdentifier: Int
    let isActive: Bool
    let activationPolicy: String
}

struct ListAppsPayload: Encodable {
    let apps: [AppInfo]
}

struct DesktopSessionStatusPayload: Encodable {
    let frontmostBundleId: String?
    let frontmostLocalizedName: String?
    let frontmostProcessIdentifier: Int?
    let mainDisplayAsleep: Bool
    let ioConsoleLocked: Bool?
    let cgSessionScreenIsLocked: Bool?
    let controllable: Bool
}

struct ActivateAppPayload: Encodable {
    let bundleId: String
    let processIdentifier: Int
    let activated: Bool
    let requestedActivation: Bool
    let frontmostBundleId: String?
    let frontmostProcessIdentifier: Int?
}

struct OpenGhosttySessionPayload: Encodable {
    let bundleId: String
    let title: String
    let workingDirectory: String?
    let appURL: String
    let arguments: [String]
    let processIdentifier: Int
    let opened: Bool
}

struct ScreenshotPayload: Encodable {
    let output: String
}

struct OcrLabelPayload: Encodable {
    let text: String
    let confidence: Double
    let bounds: WindowBounds
}

struct OcrImagePayload: Encodable {
    let labels: [OcrLabelPayload]
}

struct FinderSelectionItemPayload: Encodable {
    let path: String
    let name: String
    let kind: String
}

struct FinderSelectionPayload: Encodable {
    let source: String
    let frontmostBundleId: String?
    let targetPath: String?
    let selection: [FinderSelectionItemPayload]
}

struct FinderItemLayoutItemPayload: Encodable {
    let path: String
    let name: String
    let kind: String
    let center: PointPayload
    let bounds: WindowBounds
}

struct FinderItemLayoutPayload: Encodable {
    let source: String
    let frontmostBundleId: String?
    let folderPath: String
    let items: [FinderItemLayoutItemPayload]
}

struct ClickPayload: Encodable {
    let x: Double
    let y: Double
}

struct PointPayload: Encodable {
    let x: Double
    let y: Double
}

struct ScrollPayload: Encodable {
    let deltaX: Double
    let deltaY: Double
}

struct DragPayload: Encodable {
    let from: PointPayload
    let to: PointPayload
    let durationMs: Int
}

struct TypeTextPayload: Encodable {
    let textLength: Int
}

struct PressKeyPayload: Encodable {
    let key: String
}

struct PressShortcutPayload: Encodable {
    let key: String
    let modifiers: [String]
}

struct SelectInputSourcePayload: Encodable {
    let sourceId: String
}

struct DoubleTapFunctionKeyPayload: Encodable {
    let key: String
    let taps: Int
}

struct WindowBounds: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WindowInfo: Encodable {
    let title: String?
    let layer: Int
    let bounds: WindowBounds
}

struct AppStatePayload: Encodable {
    let app: AppInfo
    let frontmostBundleId: String?
    let accessibilityTrusted: Bool
    let screenshot: ScreenshotPayload
    let windows: [WindowInfo]
}

struct PermissionStatusInfo: Encodable {
    let status: String
    let granted: Bool
}

struct PermissionsStatusPayload: Encodable {
    let screenRecording: PermissionStatusInfo
    let accessibility: PermissionStatusInfo
}

struct OpenPermissionSettingsPayload: Encodable {
    let permission: String
    let url: String
    let opened: Bool
}

struct FrontmostApplicationSnapshot {
    let bundleId: String?
    let localizedName: String?
    let processIdentifier: Int?

    func matches(bundleId: String, processIdentifier: Int?) -> Bool {
        guard self.bundleId == bundleId else {
            return false
        }

        guard let processIdentifier else {
            return true
        }

        return self.processIdentifier == processIdentifier
    }
}

struct ConsoleLockStatus {
    let ioConsoleLocked: Bool?
    let cgSessionScreenIsLocked: Bool?
}

func writeJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    do {
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        let fallback = #"{"command":"unknown","error":{"code":"json_encoding_failed","message":"Failed to encode helper response."},"ok":false}"# + "\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

func succeed<Payload: Encodable>(command: String, data: Payload) -> Never {
    writeJSON(SuccessResponse(command: command, data: data))
    exit(EXIT_SUCCESS)
}

func fail(command: String, failure: HelperFailure) -> Never {
    let details = failure.details.isEmpty ? nil : failure.details
    let error = FailurePayload(code: failure.code, message: failure.message, details: details)
    writeJSON(FailureResponse(command: command, error: error))
    exit(EXIT_FAILURE)
}

func parseOptions(_ rawArguments: ArraySlice<String>, allowed: Set<String>) throws -> [String: String] {
    var options: [String: String] = [:]
    var index = rawArguments.startIndex

    while index < rawArguments.endIndex {
        let option = rawArguments[index]
        guard option.hasPrefix("--") else {
            throw HelperFailure("unexpected_argument", "Unexpected positional argument.", details: ["argument": .string(option)])
        }

        guard allowed.contains(option) else {
            throw HelperFailure("unknown_option", "Unknown option for command.", details: ["option": .string(option)])
        }

        let valueIndex = rawArguments.index(after: index)
        guard valueIndex < rawArguments.endIndex else {
            throw HelperFailure("missing_option_value", "Missing value for option.", details: ["option": .string(option)])
        }

        guard options[option] == nil else {
            throw HelperFailure("duplicate_option", "Option was provided more than once.", details: ["option": .string(option)])
        }

        options[option] = rawArguments[valueIndex]
        index = rawArguments.index(after: valueIndex)
    }

    return options
}

func requiredOption(_ name: String, in options: [String: String]) throws -> String {
    guard let value = options[name], !value.isEmpty else {
        throw HelperFailure("missing_required_option", "Missing required option.", details: ["option": .string(name)])
    }
    return value
}

func requiredDoubleOption(_ name: String, in options: [String: String]) throws -> Double {
    let rawValue = try requiredOption(name, in: options)
    guard let value = Double(rawValue), value.isFinite else {
        throw HelperFailure(
            "invalid_number",
            "Expected a finite numeric option value.",
            details: ["option": .string(name), "value": .string(rawValue)]
        )
    }
    return value
}

func optionalPositiveIntOption(_ name: String, in options: [String: String]) throws -> Int? {
    guard let rawValue = options[name] else {
        return nil
    }

    guard let value = Int(rawValue), value > 0 else {
        throw HelperFailure(
            "invalid_integer",
            "Expected a positive integer option value.",
            details: ["option": .string(name), "value": .string(rawValue)]
        )
    }

    return value
}

func absolutePath(_ path: String) -> String {
    let expanded = (path as NSString).expandingTildeInPath
    if expanded.hasPrefix("/") {
        return expanded
    }

    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent(expanded)
        .standardizedFileURL
        .path
}

func existingFileURL(_ rawPath: String, label: String) throws -> URL {
    let resolvedPath = absolutePath(rawPath)
    var isDirectory = ObjCBool(false)

    guard FileManager.default.fileExists(atPath: resolvedPath, isDirectory: &isDirectory), !isDirectory.boolValue else {
        throw HelperFailure(
            "input_file_not_found",
            "Input file does not exist or is not a file.",
            details: [label: .string(resolvedPath)]
        )
    }

    return URL(fileURLWithPath: resolvedPath)
}

func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
    switch policy {
    case .regular:
        return "regular"
    case .accessory:
        return "accessory"
    case .prohibited:
        return "prohibited"
    @unknown default:
        return "unknown"
    }
}

func appInfo(_ app: NSRunningApplication) -> AppInfo {
    AppInfo(
        bundleId: app.bundleIdentifier,
        localizedName: app.localizedName,
        processIdentifier: Int(app.processIdentifier),
        isActive: app.isActive,
        activationPolicy: activationPolicyName(app.activationPolicy)
    )
}

func findRunningApp(bundleId: String, processIdentifier: Int? = nil) throws -> NSRunningApplication {
    if let app = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleIdentifier == bundleId
            && (processIdentifier == nil || Int($0.processIdentifier) == processIdentifier)
    }) {
        return app
    }

    var details: [String: JSONValue] = ["bundleId": .string(bundleId)]
    if let processIdentifier {
        details["processIdentifier"] = .int(processIdentifier)
    }

    throw HelperFailure("app_not_found", "No running application found for bundle id.", details: details)
}

func requireAccessibilityTrust(for action: String) throws {
    let promptOption = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let options = [promptOption: true] as CFDictionary

    guard AXIsProcessTrustedWithOptions(options) else {
        throw HelperFailure(
            "accessibility_permission_required",
            "Accessibility permission is required. Grant it to skfiy or the terminal running skfiy, then try again.",
            details: ["action": .string(action)]
        )
    }
}

func focusAppWindows(_ app: NSRunningApplication) throws {
    try requireAccessibilityTrust(for: "activate-app")

    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)

    var rawWindows: CFTypeRef?
    let windowsResult = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &rawWindows)
    guard windowsResult == .success, let windows = rawWindows as? [AXUIElement] else {
        return
    }

    for window in windows.prefix(3) {
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
}

func readFrontmostApplication() -> FrontmostApplicationSnapshot {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        return FrontmostApplicationSnapshot(bundleId: nil, localizedName: nil, processIdentifier: nil)
    }

    return FrontmostApplicationSnapshot(
        bundleId: app.bundleIdentifier,
        localizedName: app.localizedName,
        processIdentifier: Int(app.processIdentifier)
    )
}

func optionalBoolValue(_ value: Any?) -> Bool? {
    if let bool = value as? Bool {
        return bool
    }

    if let number = value as? NSNumber {
        return number.boolValue
    }

    return nil
}

func rootIORegistryProperty(_ key: String) -> Any? {
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    guard root != MACH_PORT_NULL else {
        return nil
    }
    defer {
        IOObjectRelease(root)
    }

    return IORegistryEntryCreateCFProperty(
        root,
        key as CFString,
        kCFAllocatorDefault,
        0
    )?.takeRetainedValue()
}

func readConsoleLockStatus() -> ConsoleLockStatus {
    let ioConsoleLocked = optionalBoolValue(rootIORegistryProperty("IOConsoleLocked"))
    let users = rootIORegistryProperty("IOConsoleUsers") as? [[String: Any]]
    let consoleSession = users?.first {
        optionalBoolValue($0["kCGSSessionOnConsoleKey"]) == true
    }

    return ConsoleLockStatus(
        ioConsoleLocked: ioConsoleLocked,
        cgSessionScreenIsLocked: optionalBoolValue(consoleSession?["CGSSessionScreenIsLocked"])
    )
}

func waitForFrontmost(
    bundleId: String,
    processIdentifier: Int? = nil,
    timeoutSeconds: TimeInterval = 1.5
) -> FrontmostApplicationSnapshot {
    let deadline = Date().addingTimeInterval(timeoutSeconds)

    while Date() < deadline {
        let frontmost = readFrontmostApplication()
        if frontmost.matches(bundleId: bundleId, processIdentifier: processIdentifier) {
            return frontmost
        }

        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }

    return readFrontmostApplication()
}

func captureScreenshot(outputPath: String) throws -> String {
    let resolvedOutputPath = absolutePath(outputPath)
    let outputURL = URL(fileURLWithPath: resolvedOutputPath)
    let parentURL = outputURL.deletingLastPathComponent()

    do {
        try FileManager.default.createDirectory(at: parentURL, withIntermediateDirectories: true)
    } catch {
        throw HelperFailure(
            "output_directory_failed",
            "Failed to create screenshot output directory.",
            details: ["output": .string(resolvedOutputPath), "underlyingError": .string(String(describing: error))]
        )
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", resolvedOutputPath]

    let errorPipe = Pipe()
    process.standardError = errorPipe

    do {
        try process.run()
    } catch {
        throw HelperFailure(
            "screenshot_process_failed",
            "Failed to start screencapture.",
            details: ["underlyingError": .string(String(describing: error))]
        )
    }

    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        let errorText = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        throw HelperFailure(
            "screenshot_failed",
            "screencapture exited with a non-zero status.",
            details: ["status": .int(Int(process.terminationStatus)), "stderr": .string(errorText)]
        )
    }

    guard FileManager.default.fileExists(atPath: resolvedOutputPath) else {
        throw HelperFailure(
            "screenshot_missing_output",
            "screencapture completed but no output file was created.",
            details: ["output": .string(resolvedOutputPath)]
        )
    }

    return resolvedOutputPath
}

func imageSize(for imageURL: URL) throws -> CGSize {
    guard let image = NSImage(contentsOf: imageURL) else {
        throw HelperFailure(
            "image_read_failed",
            "Failed to read image for OCR.",
            details: ["input": .string(imageURL.path)]
        )
    }

    guard image.size.width > 0, image.size.height > 0 else {
        throw HelperFailure(
            "image_size_invalid",
            "Image has invalid dimensions for OCR.",
            details: ["input": .string(imageURL.path)]
        )
    }

    return image.size
}

func topLeftPixelBounds(
    for normalizedBounds: CGRect,
    imageSize: CGSize
) -> WindowBounds {
    let width = normalizedBounds.width * imageSize.width
    let height = normalizedBounds.height * imageSize.height
    let x = normalizedBounds.minX * imageSize.width
    let y = (1 - normalizedBounds.maxY) * imageSize.height

    return WindowBounds(
        x: Double(x),
        y: Double(y),
        width: Double(width),
        height: Double(height)
    )
}

func recognizeTextLabels(inputPath: String) throws -> [OcrLabelPayload] {
    let imageURL = try existingFileURL(inputPath, label: "input")
    let size = try imageSize(for: imageURL)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(url: imageURL, options: [:])

    do {
        try handler.perform([request])
    } catch {
        throw HelperFailure(
            "ocr_failed",
            "Vision OCR failed for image.",
            details: [
                "input": .string(imageURL.path),
                "underlyingError": .string(String(describing: error))
            ]
        )
    }

    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }

        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return nil
        }

        return OcrLabelPayload(
            text: text,
            confidence: Double(candidate.confidence),
            bounds: topLeftPixelBounds(for: observation.boundingBox, imageSize: size)
        )
    }
}

func finderSelectionScriptSource() -> String {
    """
    set outputLines to {}
    tell application "Finder"
        try
            set targetAlias to target of front Finder window as alias
            set end of outputLines to POSIX path of targetAlias
        on error
            set end of outputLines to ""
        end try

        set selectedItems to selection as list
        repeat with finderItem in selectedItems
            try
                set end of outputLines to POSIX path of (finderItem as alias)
            end try
        end repeat
    end tell

    set AppleScript's text item delimiters to linefeed
    set joinedOutput to outputLines as text
    set AppleScript's text item delimiters to ""
    return joinedOutput
    """
}

func appleScriptQuotedString(_ value: String) -> String {
    let escaped = value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(escaped)\""
}

func appleScriptListLiteral(_ values: [String]) -> String {
    "{" + values.map(appleScriptQuotedString).joined(separator: ", ") + "}"
}

func finderItemLayoutScriptSource(folderPath: String, itemNames: [String]) -> String {
    let quotedFolderPath = appleScriptQuotedString(folderPath)
    let itemList = appleScriptListLiteral(itemNames)

    return """
    set outputLines to {}
    set requestedItemNames to \(itemList)
    tell application "Finder"
        set folderAlias to POSIX file \(quotedFolderPath) as alias
        open folderAlias
        delay 0.2
        set target of front Finder window to folderAlias
        set current view of front Finder window to icon view
        set bounds of front Finder window to {100, 100, 780, 560}
        try
            set icon size of icon view options of front Finder window to 64
            set arrangement of icon view options of front Finder window to not arranged
        end try

        set windowBounds to bounds of front Finder window
        set baseX to 120
        set baseY to 160
        set stepX to 200

        repeat with itemIndex from 1 to count of requestedItemNames
            set itemName to item itemIndex of requestedItemNames
            set finderItem to item itemName of front Finder window
            set itemX to baseX + ((itemIndex - 1) * stepX)
            set position of finderItem to {itemX, baseY}
            delay 0.05
            set itemPosition to position of finderItem
            set itemPath to POSIX path of (finderItem as alias)
            set screenX to (item 1 of windowBounds) + (item 1 of itemPosition) + 32
            set screenY to (item 2 of windowBounds) + (item 2 of itemPosition) + 96
            set boundX to screenX - 32
            set boundY to screenY - 32
            set end of outputLines to itemName & tab & itemPath & tab & screenX & tab & screenY & tab & boundX & tab & boundY & tab & 64 & tab & 64
        end repeat
    end tell

    set AppleScript's text item delimiters to linefeed
    set joinedOutput to outputLines as text
    set AppleScript's text item delimiters to ""
    return joinedOutput
    """
}

func appleScriptErrorNumber(_ errorInfo: NSDictionary) -> Int? {
    if let number = errorInfo[NSAppleScript.errorNumber] as? NSNumber {
        return number.intValue
    }

    if let number = errorInfo["NSAppleScriptErrorNumber"] as? NSNumber {
        return number.intValue
    }

    return nil
}

func appleScriptErrorMessage(_ errorInfo: NSDictionary) -> String {
    if let message = errorInfo[NSAppleScript.errorMessage] as? String {
        return message
    }

    if let message = errorInfo["NSAppleScriptErrorMessage"] as? String {
        return message
    }

    return "Finder AppleScript failed."
}

func finderSelectionFailure(from errorInfo: NSDictionary) -> HelperFailure {
    let number = appleScriptErrorNumber(errorInfo)
    let message = appleScriptErrorMessage(errorInfo)
    let lowercasedMessage = message.lowercased()
    var details: [String: JSONValue] = ["message": .string(message)]

    if let number {
        details["errorNumber"] = .int(number)
    }

    if number == -1743
        || lowercasedMessage.contains("not authorized")
        || lowercasedMessage.contains("not permitted")
        || lowercasedMessage.contains("automation") {
        return HelperFailure(
            "finder_automation_permission_required",
            "Automation permission is required to read Finder selection. Grant skfiy permission to control Finder, then try again.",
            details: details
        )
    }

    return HelperFailure(
        "finder_selection_failed",
        "Failed to read Finder selection.",
        details: details
    )
}

func finderItemLayoutFailure(from errorInfo: NSDictionary) -> HelperFailure {
    let number = appleScriptErrorNumber(errorInfo)
    let message = appleScriptErrorMessage(errorInfo)
    let lowercasedMessage = message.lowercased()
    var details: [String: JSONValue] = ["message": .string(message)]

    if let number {
        details["errorNumber"] = .int(number)
    }

    if number == -1743
        || lowercasedMessage.contains("not authorized")
        || lowercasedMessage.contains("not permitted")
        || lowercasedMessage.contains("automation") {
        return HelperFailure(
            "finder_automation_permission_required",
            "Automation permission is required to read Finder item layout. Grant skfiy permission to control Finder, then try again.",
            details: details
        )
    }

    return HelperFailure(
        "finder_item_layout_failed",
        "Failed to read Finder item layout.",
        details: details
    )
}

func normalizedFinderPath(_ rawPath: String) -> String? {
    let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        return nil
    }

    return URL(fileURLWithPath: trimmed).standardizedFileURL.path
}

func finderSelectionItem(for rawPath: String) -> FinderSelectionItemPayload? {
    guard let path = normalizedFinderPath(rawPath) else {
        return nil
    }

    var isDirectory = ObjCBool(false)
    let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
    let kind: String

    if exists {
        kind = isDirectory.boolValue ? "directory" : "file"
    } else {
        kind = "other"
    }

    return FinderSelectionItemPayload(
        path: path,
        name: URL(fileURLWithPath: path).lastPathComponent,
        kind: kind
    )
}

func finderItemKind(for path: String) -> String {
    var isDirectory = ObjCBool(false)
    let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)

    if !exists {
        return "other"
    }

    return isDirectory.boolValue ? "directory" : "file"
}

func readFinderItemNames(_ rawValue: String) throws -> [String] {
    let names = rawValue
        .split(separator: ",")
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }

    guard !names.isEmpty else {
        throw HelperFailure(
            "missing_finder_item_names",
            "Finder item layout requires at least one item name."
        )
    }

    for name in names {
        if name == "." || name == ".." || name.contains("/") || name.contains("\\") {
            throw HelperFailure(
                "invalid_finder_item_name",
                "Finder item names must be simple file names.",
                details: ["itemName": .string(name)]
            )
        }
    }

    return names
}

func readFinderItemLayoutLine(_ rawLine: String) throws -> FinderItemLayoutItemPayload? {
    let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        return nil
    }

    let fields = trimmed.components(separatedBy: "\t")
    guard fields.count == 8 else {
        throw HelperFailure(
            "finder_item_layout_parse_failed",
            "Finder item layout returned an unexpected line shape.",
            details: ["line": .string(rawLine)]
        )
    }

    guard
        let centerX = Double(fields[2]),
        let centerY = Double(fields[3]),
        let boundsX = Double(fields[4]),
        let boundsY = Double(fields[5]),
        let boundsWidth = Double(fields[6]),
        let boundsHeight = Double(fields[7])
    else {
        throw HelperFailure(
            "finder_item_layout_parse_failed",
            "Finder item layout returned non-numeric coordinates.",
            details: ["line": .string(rawLine)]
        )
    }

    guard let normalizedPath = normalizedFinderPath(fields[1]) else {
        return nil
    }

    return FinderItemLayoutItemPayload(
        path: normalizedPath,
        name: fields[0],
        kind: finderItemKind(for: normalizedPath),
        center: PointPayload(x: centerX, y: centerY),
        bounds: WindowBounds(x: boundsX, y: boundsY, width: boundsWidth, height: boundsHeight)
    )
}

func readFinderSelection() throws -> FinderSelectionPayload {
    guard let script = NSAppleScript(source: finderSelectionScriptSource()) else {
        throw HelperFailure(
            "finder_selection_script_invalid",
            "Failed to compile Finder selection AppleScript."
        )
    }

    var errorInfo: NSDictionary?
    let descriptor = script.executeAndReturnError(&errorInfo)

    if let errorInfo {
        throw finderSelectionFailure(from: errorInfo)
    }

    let lines = (descriptor.stringValue ?? "")
        .components(separatedBy: .newlines)
    let targetPath = lines.first.flatMap(normalizedFinderPath)
    let selection = lines.dropFirst().compactMap(finderSelectionItem)

    return FinderSelectionPayload(
        source: "finder-applescript",
        frontmostBundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
        targetPath: targetPath,
        selection: selection
    )
}

func readFinderItemLayout(folderPath: String, itemNames: [String]) throws -> FinderItemLayoutPayload {
    guard let normalizedFolderPath = normalizedFinderPath(folderPath) else {
        throw HelperFailure(
            "invalid_finder_folder",
            "Finder item layout requires a non-empty folder path."
        )
    }

    var isDirectory = ObjCBool(false)
    guard FileManager.default.fileExists(atPath: normalizedFolderPath, isDirectory: &isDirectory),
          isDirectory.boolValue else {
        throw HelperFailure(
            "finder_folder_not_found",
            "Finder item layout requires an existing folder.",
            details: ["folderPath": .string(normalizedFolderPath)]
        )
    }

    guard let script = NSAppleScript(
        source: finderItemLayoutScriptSource(folderPath: normalizedFolderPath, itemNames: itemNames)
    ) else {
        throw HelperFailure(
            "finder_item_layout_script_invalid",
            "Failed to compile Finder item layout AppleScript."
        )
    }

    var errorInfo: NSDictionary?
    let descriptor = script.executeAndReturnError(&errorInfo)

    if let errorInfo {
        throw finderItemLayoutFailure(from: errorInfo)
    }

    let items = try (descriptor.stringValue ?? "")
        .components(separatedBy: .newlines)
        .compactMap { try readFinderItemLayoutLine($0) }

    return FinderItemLayoutPayload(
        source: "finder-applescript-layout",
        frontmostBundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
        folderPath: normalizedFolderPath,
        items: items
    )
}

func postMouseClick(x: Double, y: Double) throws {
    try requireAccessibilityTrust(for: "click")

    let point = CGPoint(x: x, y: y)
    let source = CGEventSource(stateID: .hidSystemState)
    guard
        let mouseDown = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
        let mouseUp = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else {
        throw HelperFailure("event_creation_failed", "Failed to create mouse click events.")
    }

    mouseDown.post(tap: .cghidEventTap)
    mouseUp.post(tap: .cghidEventTap)
}

func postScroll(deltaX: Double, deltaY: Double) throws {
    try requireAccessibilityTrust(for: "scroll")

    let source = CGEventSource(stateID: .hidSystemState)
    guard let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(deltaY.rounded()),
        wheel2: Int32(deltaX.rounded()),
        wheel3: 0
    ) else {
        throw HelperFailure("event_creation_failed", "Failed to create scroll event.")
    }

    event.post(tap: .cghidEventTap)
}

func postMouseDrag(
    from: CGPoint,
    to: CGPoint,
    durationMilliseconds: Int
) throws {
    try requireAccessibilityTrust(for: "drag")

    let source = CGEventSource(stateID: .hidSystemState)
    guard
        let mouseDown = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left),
        let mouseUp = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)
    else {
        throw HelperFailure("event_creation_failed", "Failed to create mouse drag events.")
    }

    mouseDown.post(tap: .cghidEventTap)

    let steps = max(1, min(60, durationMilliseconds / 16))
    let stepDelay = durationMilliseconds > 0 ? UInt32((durationMilliseconds * 1000) / steps) : 0

    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        let point = CGPoint(
            x: from.x + ((to.x - from.x) * progress),
            y: from.y + ((to.y - from.y) * progress)
        )

        guard let dragged = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseDragged,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            throw HelperFailure("event_creation_failed", "Failed to create mouse drag move event.")
        }

        dragged.post(tap: .cghidEventTap)
        if stepDelay > 0 {
            usleep(stepDelay)
        }
    }

    mouseUp.post(tap: .cghidEventTap)
}

func postText(_ text: String) throws {
    try requireAccessibilityTrust(for: "type-text")

    if text.isEmpty {
        return
    }

    let pasteboard = NSPasteboard.general
    let previousString = pasteboard.string(forType: .string)

    pasteboard.clearContents()
    guard pasteboard.setString(text, forType: .string) else {
        throw HelperFailure("pasteboard_failed", "Failed to prepare text for paste.")
    }

    try postModifiedKey(virtualKey: 9, modifiers: .maskCommand)
    usleep(120_000)

    pasteboard.clearContents()
    if let previousString {
        pasteboard.setString(previousString, forType: .string)
    }
}

func postModifiedKey(virtualKey: CGKeyCode, modifiers: CGEventFlags = []) throws {
    let source = CGEventSource(stateID: .hidSystemState)
    guard
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false)
    else {
        throw HelperFailure("event_creation_failed", "Failed to create keyboard events.")
    }

    keyDown.flags = modifiers
    keyUp.flags = modifiers
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
}

func keyCode(for key: String) throws -> CGKeyCode {
    switch key {
    case "enter":
        return 36
    case "escape":
        return 53
    case "space":
        return 49
    default:
        throw HelperFailure("unsupported_key", "Unsupported key.", details: ["key": .string(key), "supportedKeys": .strings(["enter", "escape", "space"])])
    }
}

func modifierFlag(for modifier: String) throws -> CGEventFlags {
    switch modifier {
    case "control":
        return .maskControl
    case "option":
        return .maskAlternate
    case "command":
        return .maskCommand
    case "shift":
        return .maskShift
    default:
        throw HelperFailure(
            "unsupported_modifier",
            "Unsupported keyboard shortcut modifier.",
            details: ["modifier": .string(modifier), "supportedModifiers": .strings(["control", "option", "command", "shift"])]
        )
    }
}

func parseShortcutModifiers(_ rawModifiers: String) throws -> [String] {
    let modifiers = rawModifiers
        .split(separator: ",", omittingEmptySubsequences: false)
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }

    guard !modifiers.isEmpty, modifiers.allSatisfy({ !$0.isEmpty }) else {
        throw HelperFailure(
            "invalid_modifiers",
            "Shortcut modifiers must be a non-empty comma-separated list."
        )
    }

    for modifier in modifiers {
        _ = try modifierFlag(for: modifier)
    }

    return modifiers
}

func flags(for modifiers: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []

    for modifier in modifiers {
        flags.insert(try modifierFlag(for: modifier))
    }

    return flags
}

func postKey(_ key: String) throws {
    try requireAccessibilityTrust(for: "press-key")
    try postModifiedKey(virtualKey: keyCode(for: key))
}

func postShortcut(key: String, modifiers: [String]) throws {
    try requireAccessibilityTrust(for: "press-shortcut")
    try postModifiedKey(virtualKey: keyCode(for: key), modifiers: flags(for: modifiers))
}

func selectInputSource(sourceId: String) throws {
    let filter = [kTISPropertyInputSourceID: sourceId] as CFDictionary
    guard
        let sourceList = TISCreateInputSourceList(filter, false)?.takeRetainedValue() as? [TISInputSource],
        let source = sourceList.first
    else {
        throw HelperFailure(
            "input_source_not_found",
            "No input source found for id.",
            details: ["sourceId": .string(sourceId)]
        )
    }

    let status = TISSelectInputSource(source)
    guard status == noErr else {
        throw HelperFailure(
            "input_source_select_failed",
            "Failed to select input source.",
            details: ["sourceId": .string(sourceId), "status": .int(Int(status))]
        )
    }
}

func postFunctionKeyTap(source: CGEventSource) throws {
    guard
        let keyDown = CGEvent(source: source),
        let keyUp = CGEvent(source: source)
    else {
        throw HelperFailure("event_create_failed", "Unable to create function key events.")
    }

    keyDown.type = .flagsChanged
    keyDown.flags = .maskSecondaryFn
    keyDown.setIntegerValueField(.keyboardEventKeycode, value: Int64(kVK_Function))
    keyDown.post(tap: .cghidEventTap)

    usleep(30_000)

    keyUp.type = .flagsChanged
    keyUp.flags = CGEventFlags(rawValue: 0)
    keyUp.setIntegerValueField(.keyboardEventKeycode, value: Int64(kVK_Function))
    keyUp.post(tap: .cghidEventTap)
}

func doubleTapFunctionKey() throws {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        throw HelperFailure("event_source_failed", "Unable to create keyboard event source.")
    }

    try postFunctionKeyTap(source: source)
    usleep(80_000)
    try postFunctionKeyTap(source: source)
}

func intValue(_ value: Any?) -> Int? {
    if let int = value as? Int {
        return int
    }
    if let number = value as? NSNumber {
        return number.intValue
    }
    return nil
}

func doubleValue(_ value: Any?) -> Double {
    if let double = value as? Double {
        return double
    }
    if let int = value as? Int {
        return Double(int)
    }
    if let number = value as? NSNumber {
        return number.doubleValue
    }
    return 0
}

func windowInfos(for app: NSRunningApplication) -> [WindowInfo] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    let targetPID = Int(app.processIdentifier)
    var windows: [WindowInfo] = []

    for window in rawWindows {
        guard intValue(window[kCGWindowOwnerPID as String]) == targetPID else {
            continue
        }

        let rawBounds = window[kCGWindowBounds as String] as? [String: Any]
        let bounds = WindowBounds(
            x: doubleValue(rawBounds?["X"]),
            y: doubleValue(rawBounds?["Y"]),
            width: doubleValue(rawBounds?["Width"]),
            height: doubleValue(rawBounds?["Height"])
        )

        let info = WindowInfo(
            title: window[kCGWindowName as String] as? String,
            layer: intValue(window[kCGWindowLayer as String]) ?? 0,
            bounds: bounds
        )
        windows.append(info)
    }

    return windows
}

enum PermissionKind: String, CaseIterable {
    case screenRecording = "screen-recording"
    case accessibility

    var settingsURL: URL {
        let rawURL: String

        switch self {
        case .screenRecording:
            rawURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .accessibility:
            rawURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }

        return URL(string: rawURL)!
    }
}

func permissionKind(for rawValue: String) throws -> PermissionKind {
    guard let permission = PermissionKind(rawValue: rawValue) else {
        throw HelperFailure(
            "unsupported_permission",
            "Unsupported permission.",
            details: [
                "permission": .string(rawValue),
                "supportedPermissions": .strings(PermissionKind.allCases.map(\.rawValue))
            ]
        )
    }

    return permission
}

func booleanPermissionStatus(granted: Bool) -> PermissionStatusInfo {
    PermissionStatusInfo(status: granted ? "authorized" : "notAuthorized", granted: granted)
}

func handleListApps(_ arguments: ArraySlice<String>) throws -> ListAppsPayload {
    _ = try parseOptions(arguments, allowed: [])
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.bundleIdentifier != nil }
        .map(appInfo)
        .sorted { left, right in
            let leftName = left.localizedName ?? left.bundleId ?? ""
            let rightName = right.localizedName ?? right.bundleId ?? ""
            return leftName.localizedCaseInsensitiveCompare(rightName) == .orderedAscending
        }

    return ListAppsPayload(apps: apps)
}

func handleDesktopSessionStatus(_ arguments: ArraySlice<String>) throws -> DesktopSessionStatusPayload {
    _ = try parseOptions(arguments, allowed: [])
    let frontmost = readFrontmostApplication()
    let consoleLock = readConsoleLockStatus()

    return DesktopSessionStatusPayload(
        frontmostBundleId: frontmost.bundleId,
        frontmostLocalizedName: frontmost.localizedName,
        frontmostProcessIdentifier: frontmost.processIdentifier,
        mainDisplayAsleep: CGDisplayIsAsleep(CGMainDisplayID()) != 0,
        ioConsoleLocked: consoleLock.ioConsoleLocked,
        cgSessionScreenIsLocked: consoleLock.cgSessionScreenIsLocked,
        controllable: frontmost.bundleId != "com.apple.loginwindow"
    )
}

func handleActivateApp(_ arguments: ArraySlice<String>) throws -> ActivateAppPayload {
    let options = try parseOptions(arguments, allowed: ["--bundle-id", "--pid"])
    let bundleId = try requiredOption("--bundle-id", in: options)
    let pid = try optionalPositiveIntOption("--pid", in: options)
    let app = try findRunningApp(bundleId: bundleId, processIdentifier: pid)
    let processIdentifier = Int(app.processIdentifier)
    var requested = false
    var frontmost = readFrontmostApplication()

    for _ in 0..<3 {
        requested = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) || requested
        try focusAppWindows(app)
        frontmost = waitForFrontmost(
            bundleId: bundleId,
            processIdentifier: processIdentifier,
            timeoutSeconds: 0.75
        )

        if frontmost.matches(bundleId: bundleId, processIdentifier: processIdentifier) {
            break
        }
    }

    let activated = frontmost.matches(bundleId: bundleId, processIdentifier: processIdentifier)
    return ActivateAppPayload(
        bundleId: bundleId,
        processIdentifier: processIdentifier,
        activated: activated,
        requestedActivation: requested,
        frontmostBundleId: frontmost.bundleId,
        frontmostProcessIdentifier: frontmost.processIdentifier
    )
}

func ghosttyApplicationURL() throws -> URL {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.mitchellh.ghostty") {
        return url
    }

    let fallback = URL(fileURLWithPath: "/Applications/Ghostty.app")
    if FileManager.default.fileExists(atPath: fallback.path) {
        return fallback
    }

    throw HelperFailure(
        "ghostty_not_found",
        "Ghostty.app could not be found.",
        details: ["bundleId": .string("com.mitchellh.ghostty")]
    )
}

func existingDirectoryPath(_ rawPath: String) throws -> String {
    let resolvedPath = absolutePath(rawPath)
    var isDirectory = ObjCBool(false)

    guard FileManager.default.fileExists(atPath: resolvedPath, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw HelperFailure(
            "working_directory_not_found",
            "Working directory does not exist or is not a directory.",
            details: ["workingDirectory": .string(resolvedPath)]
        )
    }

    return resolvedPath
}

func handleOpenGhosttySession(_ arguments: ArraySlice<String>) throws -> OpenGhosttySessionPayload {
    try requireAccessibilityTrust(for: "open-ghostty-session")

    let options = try parseOptions(arguments, allowed: ["--title", "--working-directory"])
    let title = try requiredOption("--title", in: options)
    let workingDirectory = try options["--working-directory"].map(existingDirectoryPath)
    let appURL = try ghosttyApplicationURL()
    var ghosttyArguments = [
        "--title=\(title)",
        "--shell-integration-features=no-title"
    ]

    if let workingDirectory {
        ghosttyArguments.append("--working-directory=\(workingDirectory)")
    }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.arguments = ghosttyArguments
    configuration.createsNewApplicationInstance = true

    let semaphore = DispatchSemaphore(value: 0)
    var openedApplication: NSRunningApplication?
    var launchError: Error?

    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { app, error in
        openedApplication = app
        launchError = error
        semaphore.signal()
    }

    if semaphore.wait(timeout: .now() + 5) == .timedOut {
        throw HelperFailure(
            "ghostty_launch_timeout",
            "Timed out while opening Ghostty.",
            details: ["appURL": .string(appURL.path)]
        )
    }

    if let launchError {
        throw HelperFailure(
            "ghostty_launch_failed",
            "Failed to open Ghostty.",
            details: [
                "appURL": .string(appURL.path),
                "underlyingError": .string(String(describing: launchError))
            ]
        )
    }

    guard let openedApplication else {
        throw HelperFailure(
            "ghostty_launch_failed",
            "Ghostty launch completed without a running application.",
            details: ["appURL": .string(appURL.path)]
        )
    }

    return OpenGhosttySessionPayload(
        bundleId: "com.mitchellh.ghostty",
        title: title,
        workingDirectory: workingDirectory,
        appURL: appURL.path,
        arguments: ghosttyArguments,
        processIdentifier: Int(openedApplication.processIdentifier),
        opened: true
    )
}

func handleScreenshot(_ arguments: ArraySlice<String>) throws -> ScreenshotPayload {
    let options = try parseOptions(arguments, allowed: ["--output"])
    let output = try requiredOption("--output", in: options)
    return ScreenshotPayload(output: try captureScreenshot(outputPath: output))
}

func handleOcrImage(_ arguments: ArraySlice<String>) throws -> OcrImagePayload {
    let options = try parseOptions(arguments, allowed: ["--input"])
    let input = try requiredOption("--input", in: options)
    return OcrImagePayload(labels: try recognizeTextLabels(inputPath: input))
}

func handleGetFinderSelection(_ arguments: ArraySlice<String>) throws -> FinderSelectionPayload {
    _ = try parseOptions(arguments, allowed: [])
    return try readFinderSelection()
}

func handleGetFinderItemLayout(_ arguments: ArraySlice<String>) throws -> FinderItemLayoutPayload {
    let options = try parseOptions(arguments, allowed: ["--folder", "--items"])
    let folderPath = try requiredOption("--folder", in: options)
    let itemNames = try readFinderItemNames(requiredOption("--items", in: options))
    return try readFinderItemLayout(folderPath: folderPath, itemNames: itemNames)
}

func handleClick(_ arguments: ArraySlice<String>) throws -> ClickPayload {
    let options = try parseOptions(arguments, allowed: ["--x", "--y"])
    let x = try requiredDoubleOption("--x", in: options)
    let y = try requiredDoubleOption("--y", in: options)
    try postMouseClick(x: x, y: y)
    return ClickPayload(x: x, y: y)
}

func handleScroll(_ arguments: ArraySlice<String>) throws -> ScrollPayload {
    let options = try parseOptions(arguments, allowed: ["--delta-x", "--delta-y"])
    let deltaX = try requiredDoubleOption("--delta-x", in: options)
    let deltaY = try requiredDoubleOption("--delta-y", in: options)
    try postScroll(deltaX: deltaX, deltaY: deltaY)
    return ScrollPayload(deltaX: deltaX, deltaY: deltaY)
}

func handleDrag(_ arguments: ArraySlice<String>) throws -> DragPayload {
    let options = try parseOptions(arguments, allowed: [
        "--from-x",
        "--from-y",
        "--to-x",
        "--to-y",
        "--duration-ms"
    ])
    let from = PointPayload(
        x: try requiredDoubleOption("--from-x", in: options),
        y: try requiredDoubleOption("--from-y", in: options)
    )
    let to = PointPayload(
        x: try requiredDoubleOption("--to-x", in: options),
        y: try requiredDoubleOption("--to-y", in: options)
    )
    let durationMs = try optionalPositiveIntOption("--duration-ms", in: options) ?? 250

    try postMouseDrag(
        from: CGPoint(x: from.x, y: from.y),
        to: CGPoint(x: to.x, y: to.y),
        durationMilliseconds: durationMs
    )
    return DragPayload(from: from, to: to, durationMs: durationMs)
}

func handleTypeText(_ arguments: ArraySlice<String>) throws -> TypeTextPayload {
    let options = try parseOptions(arguments, allowed: ["--text"])
    let text = try requiredOption("--text", in: options)
    try postText(text)
    return TypeTextPayload(textLength: text.count)
}

func handlePressKey(_ arguments: ArraySlice<String>) throws -> PressKeyPayload {
    let options = try parseOptions(arguments, allowed: ["--key"])
    let key = try requiredOption("--key", in: options)
    try postKey(key)
    return PressKeyPayload(key: key)
}

func handlePressShortcut(_ arguments: ArraySlice<String>) throws -> PressShortcutPayload {
    let options = try parseOptions(arguments, allowed: ["--key", "--modifiers"])
    let key = try requiredOption("--key", in: options)
    let modifiers = try parseShortcutModifiers(requiredOption("--modifiers", in: options))
    try postShortcut(key: key, modifiers: modifiers)
    return PressShortcutPayload(key: key, modifiers: modifiers)
}

func handleSelectInputSource(_ arguments: ArraySlice<String>) throws -> SelectInputSourcePayload {
    let options = try parseOptions(arguments, allowed: ["--source-id"])
    let sourceId = try requiredOption("--source-id", in: options)
    try selectInputSource(sourceId: sourceId)
    return SelectInputSourcePayload(sourceId: sourceId)
}

func handleDoubleTapFunctionKey(_ arguments: ArraySlice<String>) throws -> DoubleTapFunctionKeyPayload {
    _ = try parseOptions(arguments, allowed: [])
    try doubleTapFunctionKey()
    return DoubleTapFunctionKeyPayload(key: "fn", taps: 2)
}

func handleGetAppState(_ arguments: ArraySlice<String>) throws -> AppStatePayload {
    let options = try parseOptions(arguments, allowed: ["--bundle-id", "--pid", "--screenshot-output"])
    let bundleId = try requiredOption("--bundle-id", in: options)
    let pid = try optionalPositiveIntOption("--pid", in: options)
    let screenshotOutput = try requiredOption("--screenshot-output", in: options)
    let app = try findRunningApp(bundleId: bundleId, processIdentifier: pid)
    let output = try captureScreenshot(outputPath: screenshotOutput)

    return AppStatePayload(
        app: appInfo(app),
        frontmostBundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
        accessibilityTrusted: AXIsProcessTrusted(),
        screenshot: ScreenshotPayload(output: output),
        windows: windowInfos(for: app)
    )
}

func handlePermissionsStatus(_ arguments: ArraySlice<String>) throws -> PermissionsStatusPayload {
    _ = try parseOptions(arguments, allowed: [])

    return PermissionsStatusPayload(
        screenRecording: booleanPermissionStatus(granted: CGPreflightScreenCaptureAccess()),
        accessibility: booleanPermissionStatus(granted: AXIsProcessTrusted())
    )
}

func handleOpenPermissionSettings(_ arguments: ArraySlice<String>) throws -> OpenPermissionSettingsPayload {
    let options = try parseOptions(arguments, allowed: ["--permission"])
    let permission = try permissionKind(for: requiredOption("--permission", in: options))
    let settingsURL = permission.settingsURL

    guard NSWorkspace.shared.open(settingsURL) else {
        throw HelperFailure(
            "open_permission_settings_failed",
            "Failed to open System Settings for permission.",
            details: ["permission": .string(permission.rawValue), "url": .string(settingsURL.absoluteString)]
        )
    }

    return OpenPermissionSettingsPayload(
        permission: permission.rawValue,
        url: settingsURL.absoluteString,
        opened: true
    )
}

let rawArguments = CommandLine.arguments.dropFirst()
let command = rawArguments.first ?? "unknown"

do {
    guard let commandName = rawArguments.first else {
        throw HelperFailure("missing_command", "No command was provided.")
    }

    let arguments = rawArguments.dropFirst()

    switch commandName {
    case "list-apps":
        succeed(command: commandName, data: try handleListApps(arguments))
    case "desktop-session-status":
        succeed(command: commandName, data: try handleDesktopSessionStatus(arguments))
    case "activate-app":
        succeed(command: commandName, data: try handleActivateApp(arguments))
    case "open-ghostty-session":
        succeed(command: commandName, data: try handleOpenGhosttySession(arguments))
    case "screenshot":
        succeed(command: commandName, data: try handleScreenshot(arguments))
    case "ocr-image":
        succeed(command: commandName, data: try handleOcrImage(arguments))
    case "get-finder-selection":
        succeed(command: commandName, data: try handleGetFinderSelection(arguments))
    case "get-finder-item-layout":
        succeed(command: commandName, data: try handleGetFinderItemLayout(arguments))
    case "click":
        succeed(command: commandName, data: try handleClick(arguments))
    case "scroll":
        succeed(command: commandName, data: try handleScroll(arguments))
    case "drag":
        succeed(command: commandName, data: try handleDrag(arguments))
    case "type-text":
        succeed(command: commandName, data: try handleTypeText(arguments))
    case "press-key":
        succeed(command: commandName, data: try handlePressKey(arguments))
    case "press-shortcut":
        succeed(command: commandName, data: try handlePressShortcut(arguments))
    case "select-input-source":
        succeed(command: commandName, data: try handleSelectInputSource(arguments))
    case "double-tap-fn":
        succeed(command: commandName, data: try handleDoubleTapFunctionKey(arguments))
    case "get-app-state":
        succeed(command: commandName, data: try handleGetAppState(arguments))
    case "permissions-status":
        succeed(command: commandName, data: try handlePermissionsStatus(arguments))
    case "open-permission-settings":
        succeed(command: commandName, data: try handleOpenPermissionSettings(arguments))
    default:
        throw HelperFailure(
            "unknown_command",
            "Unknown command.",
            details: ["command": .string(commandName), "supportedCommands": .strings(supportedCommands)]
        )
    }
} catch let failure as HelperFailure {
    fail(command: command, failure: failure)
} catch {
    fail(
        command: command,
        failure: HelperFailure("unhandled_error", "Unhandled helper error.", details: ["underlyingError": .string(String(describing: error))])
    )
}
