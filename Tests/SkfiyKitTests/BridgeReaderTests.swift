import Darwin
import Foundation
import Testing
@testable import SkfiyKit

struct BridgeReaderTests {
    private func pair() throws -> (Int32, Int32) {
        var pair: [Int32] = [0, 0]
        try #require(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
        return (pair[0], pair[1])
    }

    private func writer(_ fd: Int32, data: Data) -> Task<Void, Never> {
        Task.detached {
            defer { Darwin.close(fd) }
            var option: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &option, socklen_t(MemoryLayout<Int32>.size))
            data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let count = write(fd, bytes.baseAddress!.advanced(by: offset), min(65_536, bytes.count - offset))
                    if count <= 0 { return }
                    offset += count
                }
            }
        }
    }

    @Test func preservesCoalescedLinesAndRejectsOversizedOrIncompleteFrames() async throws {
        let (readFD, writeFD) = try pair()
        defer { Darwin.close(readFD) }
        let output = writer(writeFD, data: Data("中文\nsecond\npartial".utf8))
        let reader = BridgeLineReader()
        #expect(try reader.line(readFD, timeout: 2) == Data("中文".utf8))
        #expect(try reader.line(readFD, timeout: 2) == Data("second".utf8))
        #expect(try reader.line(readFD, timeout: 2) == nil)
        await output.value
        let (limitedFD, limitedWriter) = try pair()
        defer { Darwin.close(limitedFD) }
        let tooLarge = writer(limitedWriter, data: Data(repeating: 65, count: 100))
        #expect(throws: ToolError.self) { try BridgeLineReader(maximumBytes: 16).line(limitedFD, timeout: 2) }
        await tooLarge.value
        var invalid = Data([0xff, 0xff, 0xff, 0x7f])
        #expect(throws: ToolError.self) { try NativeMessage.decode(&invalid) }
    }

    @Test func largeMessagesUseChunkedReadsAndReportComparableTiming() async throws {
        let payload = Data(repeating: 65, count: 256 * 1024)
        var oldTimes: [Double] = [], newTimes: [Double] = []
        for chunked in [false, true] {
            for _ in 0..<5 {
                let (readFD, writeFD) = try pair()
                let output = writer(writeFD, data: payload + Data([10]))
                let started = ProcessInfo.processInfo.systemUptime
                if chunked {
                    let reader = BridgeLineReader()
                    #expect(try reader.line(readFD, timeout: 10) == payload)
                    #expect(reader.reads < 256)
                } else {
                    var byte: UInt8 = 0, count = 0
                    while true {
                        var poller = pollfd(fd: readFD, events: Int16(POLLIN), revents: 0)
                        guard poll(&poller, 1, 10_000) > 0, read(readFD, &byte, 1) == 1 else { break }
                        if byte == 10 { break }
                        count += 1
                    }
                    #expect(count == payload.count)
                }
                let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
                if chunked { newTimes.append(elapsed) } else { oldTimes.append(elapsed) }
                Darwin.close(readFD); await output.value
            }
        }
        oldTimes.sort(); newTimes.sort()
        print(String(format: "BRIDGE_BENCH bytes=%d samples=5 old_p50_ms=%.2f old_p95_ms=%.2f chunked_p50_ms=%.2f chunked_p95_ms=%.2f", payload.count, oldTimes[2], oldTimes[4], newTimes[2], newTimes[4]))
    }
}
