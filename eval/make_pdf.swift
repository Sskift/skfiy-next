import CoreGraphics
import CoreText
import Foundation

// make_pdf <out.pdf> <page text>... — one page per argument, for the Preview task.
let arguments = CommandLine.arguments
var box = CGRect(x: 0, y: 0, width: 612, height: 792)
guard arguments.count > 2, let context = CGContext(URL(fileURLWithPath: arguments[1]) as CFURL, mediaBox: &box, nil) else {
    FileHandle.standardError.write("usage: make_pdf <out.pdf> <page text>...\n".data(using: .utf8)!)
    exit(1)
}
let font = CTFontCreateWithName("Helvetica" as CFString, 28, nil)
for text in arguments.dropFirst(2) {
    context.beginPDFPage(nil)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [kCTFontAttributeName as NSAttributedString.Key: font]))
    context.textPosition = CGPoint(x: 72, y: 792 - 144)
    CTLineDraw(line, context)
    context.endPDFPage()
}
context.closePDF()
