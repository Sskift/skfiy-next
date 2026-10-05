// A temporary virtual display for the multi-display tests. It exists only
// while this process runs: when the process exits (or is killed) the display
// goes away and macOS moves its windows back. Its position is configured for
// this process only, so nothing is saved to the user's display arrangement.
//
//   VirtualDisplay [--side left|right|above] [--width 1280] [--height 800] [--hidpi] [--allow-unlocked]
//
// Prints one JSON line once the display is up and placed, then holds it until
// stdin closes or SIGTERM. A new display changes the screen space the user's
// pointer and windows live in, so this only runs while nobody is there: while
// the Mac is locked, quitting at once if it is unlocked; with --allow-unlocked
// also while unlocked if no keyboard, mouse or trackpad input came for 5
// minutes and no app keeps the display awake (a video playing, a
// presentation), quitting at the first input.
// Declarations of the private classes: VirtualDisplay.h.
import CoreGraphics
import Foundation
import IOKit.pwr_mgt

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func locked() -> Bool {
    (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true
}

/// Seconds since the last hardware input (synthesized events do not count).
func userIdle() -> Double {
    CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
}

/// Apps (other than skfiy) keeping the display awake: someone may be watching.
func displayKeptAwake() -> [String] {
    var byProcess: Unmanaged<CFDictionary>?
    guard IOPMCopyAssertionsByProcess(&byProcess) == kIOReturnSuccess,
          let processes = byProcess?.takeRetainedValue() as? [NSNumber: [[String: Any]]] else { return [] }
    return processes.values.joined().compactMap { assertion in
        let type = assertion[kIOPMAssertionTypeKey] as? String ?? ""
        let name = assertion[kIOPMAssertionNameKey] as? String ?? ""
        let keepsDisplay = [kIOPMAssertPreventUserIdleDisplaySleep, "NoDisplaySleepAssertion"].contains(type)
        return keepsDisplay && !name.contains("skfiy") ? name : nil
    }
}

/// Whether nobody is there to notice a new display.
func unattended(_ allowUnlocked: Bool) -> Bool {
    locked() || (allowUnlocked && userIdle() >= 300 && displayKeptAwake().isEmpty)
}

func online() -> [CGDirectDisplayID] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(16, &ids, &count) == .success else { return [] }
    return Array(ids.prefix(Int(count)))
}

func describe(_ id: CGDirectDisplayID) -> [String: Any] {
    let bounds = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    let scale = mode.map { Double($0.pixelWidth) / Double(max($0.width, 1)) } ?? 0
    return ["id": Int(id), "x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height, "scale": scale,
            "main": CGDisplayIsMain(id) != 0, "asleep": CGDisplayIsAsleep(id) != 0]
}

func waitUntil(_ seconds: Double, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if condition() { return true }
        usleep(50_000)
    }
    return condition()
}

var side = "left", width: UInt32 = 1280, height: UInt32 = 800, hiDPI = false, allowUnlocked = false
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    switch argument {
    case "--side": side = arguments.next() ?? side
    case "--width": width = arguments.next().flatMap { UInt32($0) } ?? width
    case "--height": height = arguments.next().flatMap { UInt32($0) } ?? height
    case "--hidpi": hiDPI = true
    case "--allow-unlocked": allowUnlocked = true
    default: fail("unknown argument \(argument)")
    }
}
guard unattended(allowUnlocked) else {
    fail(!allowUnlocked ? "refused: the Mac is not locked (a new display would change the user's pointer space)"
         : userIdle() < 300 ? "refused: the user touched the keyboard, mouse or trackpad in the last 5 minutes"
         : "refused: something keeps the display awake (\(displayKeptAwake().joined(separator: ", "))); someone may be watching")
}
let startedLocked = locked()

let before = Set(online())
let queue = DispatchQueue(label: "skfiy.virtual-display")
let descriptor = CGVirtualDisplayDescriptor()
descriptor.queue = queue
descriptor.name = "skfiy test display (\(side))"
descriptor.maxPixelsWide = width * 2
descriptor.maxPixelsHigh = height * 2
descriptor.sizeInMillimeters = CGSize(width: Double(width) * 0.25, height: Double(height) * 0.25)
descriptor.vendorID = 0x5346
descriptor.productID = 0x0D15
descriptor.serialNum = side == "left" ? 1 : side == "right" ? 2 : 3
descriptor.terminationHandler = { _, _ in
    FileHandle.standardError.write(Data("the virtual display was terminated\n".utf8))
    exit(2)
}
let display = CGVirtualDisplay(descriptor: descriptor)
let settings = CGVirtualDisplaySettings()
settings.hiDPI = hiDPI ? 1 : 0
// Modes are given in points; with hiDPI macOS adds each at two pixels per point.
settings.modes = [CGVirtualDisplayMode(width: width, height: height, refreshRate: 60)]
guard display.displayID != 0, display.apply(settings) else { fail("could not create the virtual display") }
let id = CGDirectDisplayID(display.displayID)
guard waitUntil(5, { online().contains(id) && CGDisplayBounds(id).width > 0 }) else { fail("the virtual display \(id) did not come online") }

// With --hidpi, the mode of `width` × `height` points at two pixels per point
// (macOS may start the display at one).
let modeOptions = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
let retina = hiDPI ? (CGDisplayCopyAllDisplayModes(id, modeOptions) as? [CGDisplayMode] ?? []).first {
    $0.width == Int(width) && $0.height == Int(height) && $0.pixelWidth == 2 * Int(width)
} : nil
if hiDPI && retina == nil {
    let offered = (CGDisplayCopyAllDisplayModes(id, modeOptions) as? [CGDisplayMode] ?? []).map { "\($0.width)×\($0.height)@\($0.pixelWidth)px" }
    fail("the virtual display offers no \(width)×\(height) mode at 2× (offered: \(offered.joined(separator: ", ")))")
}

// Beside everything that was there before, aligned with the main display.
let others = before.map { CGDisplayBounds($0) }
let main = CGDisplayBounds(CGMainDisplayID())
let size = retina.map { CGSize(width: $0.width, height: $0.height) } ?? CGDisplayBounds(id).size
let origin: CGPoint
switch side {
case "right": origin = CGPoint(x: others.map(\.maxX).max() ?? main.maxX, y: main.minY)
case "above": origin = CGPoint(x: main.minX, y: (others.map(\.minY).min() ?? main.minY) - size.height)
default: origin = CGPoint(x: (others.map(\.minX).min() ?? main.minX) - size.width, y: main.minY)
}
/// Moves the display to `origin` for this process only; the error if it cannot.
func place() -> CGError {
    var configuration: CGDisplayConfigRef?
    var error = CGBeginDisplayConfiguration(&configuration)
    guard error == .success else { return error }
    error = CGConfigureDisplayOrigin(configuration, id, Int32(origin.x), Int32(origin.y))
    if error == .success, let retina { error = CGConfigureDisplayWithDisplayMode(configuration, id, retina, nil) }
    guard error == .success else {
        CGCancelDisplayConfiguration(configuration)
        return error
    }
    return CGCompleteDisplayConfiguration(configuration, .forAppOnly)
}
// The window server turns down a new arrangement while the displays sleep, as
// they soon do on a locked Mac: wake them to the lock screen first, as skfiy
// does before a capture (the Mac stays locked).
var placing = place()
if placing != .success, locked(), online().contains(where: { CGDisplayIsAsleep($0) != 0 }) {
    var activity: IOPMAssertionID = 0
    IOPMAssertionDeclareUserActivity("skfiy test display: arranging" as CFString, kIOPMUserActiveLocal, &activity)
    _ = waitUntil(4) { !online().contains(where: { CGDisplayIsAsleep($0) != 0 }) }
    if activity != 0 { IOPMAssertionRelease(activity) }
}
for _ in 0..<20 where placing != .success {
    usleep(250_000)
    placing = place()
}
guard placing == .success else { fail("could not place the virtual display (CGError \(placing.rawValue))") }
_ = waitUntil(5) { CGDisplayBounds(id).origin == origin && (retina == nil || CGDisplayCopyDisplayMode(id)?.pixelWidth == retina?.pixelWidth) }

emit(["display": describe(id), "displays": online().map(describe), "placed": CGDisplayBounds(id).origin == origin])

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
Thread.detachNewThread {
    while FileHandle.standardInput.availableData.count > 0 {}
    exit(0)
}
Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    if startedLocked && !locked() && !allowUnlocked {
        FileHandle.standardError.write(Data("the Mac was unlocked: removing the virtual display\n".utf8))
        exit(3)
    }
    if !locked() && userIdle() < 2 {
        FileHandle.standardError.write(Data("the user is back: removing the virtual display\n".utf8))
        exit(3)
    }
}
withExtendedLifetime(display) { RunLoop.main.run() }
