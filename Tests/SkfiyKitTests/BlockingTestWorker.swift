import Foundation

/// Socket fixtures use blocking read/write/poll. Start them on a dispatch
/// thread immediately, not on Swift's bounded cooperative executor: on a
/// small CI runner the test reader can otherwise starve its own writer.
func blockingTestWorker<T: Sendable>(_ body: @escaping @Sendable () -> T) -> Task<T, Never> {
    let (stream, continuation) = AsyncStream<T>.makeStream(bufferingPolicy: .bufferingNewest(1))
    DispatchQueue.global().async {
        continuation.yield(body())
        continuation.finish()
    }
    return Task.detached {
        for await value in stream { return value }
        fatalError("The test worker ended without a result")
    }
}
