import Testing
@testable import SkfiyKit

struct StateReadCacheTests {
    @Test func refreshesOnlyChangedNodesAndPeriodicallyRechecksEverything() {
        let cache = StateReadCache<Int, Int>()
        var reads = 0
        func read(_ key: Int) -> Int { cache.read(key) { reads += 1; return reads } }
        cache.begin(reuse: false, now: 0)
        for key in 0..<100 { _ = read(key) }
        #expect(reads == 100)
        cache.invalidate(4)
        cache.begin(reuse: true, now: 0.1)
        for key in 0..<100 { _ = read(key) }
        #expect(reads == 101 && cache.hits == 99 && cache.misses == 1)
        cache.begin(reuse: true, now: 2)
        for key in 0..<100 { _ = read(key) }
        #expect(reads == 201 && cache.hits == 0)
        cache.invalidate()
        #expect(read(2) == 202)
    }

    @Test func frequentLooksStillForceAFullReadAndExplicitReadsNeverReuse() {
        let cache = StateReadCache<Int, Int>()
        var reads = 0
        for _ in 0..<5 {
            cache.begin(reuse: true, now: 0)
            _ = cache.read(1) { reads += 1; return reads }
        }
        #expect(reads == 2)
        cache.begin(reuse: false, now: 0)
        _ = cache.read(1) { reads += 1; return reads }
        #expect(reads == 3)
    }
}
