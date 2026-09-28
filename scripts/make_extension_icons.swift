// Draws the browser extension icons: a pointer over a background window.
//
//     swift scripts/make_extension_icons.swift browser-extension
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let directory = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "browser-extension"

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func draw(size: Int) -> CGImage {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    // Work in a 128-unit canvas with the origin at the top left.
    let scale = CGFloat(size) / 128
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: scale, y: -scale)
    context.setShouldAntialias(true)

    // Background tile.
    let tile = CGPath(roundedRect: CGRect(x: 4, y: 4, width: 120, height: 120), cornerWidth: 28, cornerHeight: 28, transform: nil)
    context.saveGState()
    context.addPath(tile)
    context.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(0x7B6CF6), color(0x3F32B8)] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 4), end: CGPoint(x: 0, y: 124), options: [])
    context.restoreGState()

    // A window in the background.
    let window = CGPath(roundedRect: CGRect(x: 20, y: 26, width: 74, height: 56), cornerWidth: 9, cornerHeight: 9, transform: nil)
    context.addPath(window)
    context.setFillColor(color(0xFFFFFF, 0.22))
    context.fillPath()
    context.addPath(window)
    context.setStrokeColor(color(0xFFFFFF, 0.7))
    context.setLineWidth(size <= 16 ? 6 : 4)
    context.strokePath()
    if size > 32 {
        context.setFillColor(color(0xFFFFFF, 0.85))
        for x in [30.0, 39.0, 48.0] {
            context.fillEllipse(in: CGRect(x: x - 3, y: 33, width: 6, height: 6))
        }
    }

    // The pointer, working on it; larger in the small sizes so it still reads.
    let grow: CGFloat = size <= 32 ? 1.2 : 1
    let tip = CGPoint(x: size <= 32 ? 54 : 62, y: size <= 32 ? 38 : 50)
    let outline: [(CGFloat, CGFloat)] = [(0, 0), (0, 58), (13, 45), (23, 65), (33, 60), (23, 41), (41, 41)]
    let pointer = CGMutablePath()
    pointer.addLines(between: outline.map { CGPoint(x: tip.x + $0.0 * grow, y: tip.y + $0.1 * grow) })
    pointer.closeSubpath()
    context.setLineJoin(.round)
    context.addPath(pointer)
    context.setStrokeColor(color(0x1E1A4D))
    context.setLineWidth(size <= 16 ? 9 : 6)
    context.strokePath()
    context.addPath(pointer)
    context.setFillColor(color(0xFFFFFF))
    context.fillPath()
    return context.makeImage()!
}

for size in [16, 32, 48, 128] {
    let url = URL(fileURLWithPath: "\(directory)/icon-\(size).png")
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, draw(size: size), nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("could not write \(url.path)") }
    print(url.path)
}
