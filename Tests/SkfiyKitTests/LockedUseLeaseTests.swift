import Testing
import LockedUseKit

@Test func unlockAuthorizationIsOneShotAndNeedsLiveTool() throws {
    var lease = LockedUseLease(now: 10, duration: 300)
    let authorized1 = lease.consumeAuthorization(now: 11)
    #expect(!authorized1)
    #expect(try lease.begin(now: 12, locked: true))
    let authorized2 = lease.consumeAuthorization(now: 13)
    #expect(authorized2)
    let authorized3 = lease.consumeAuthorization(now: 13)
    #expect(!authorized3)
    try lease.didUnlock(now: 14)
    #expect(lease.phase == .protected)
    #expect(lease.generation == 1)
    lease.end(now: 15)
    #expect(!lease.mustRelock(now: 44))
    #expect(lease.mustRelock(now: 45))
}

@Test func expiredUnlockAndMissingHeartbeatCannotAuthorize() throws {
    var lease = LockedUseLease(now: 0, duration: 30)
    #expect(try lease.begin(now: 1, locked: true))
    let authorized4 = lease.consumeAuthorization(now: 6)
    #expect(!authorized4)
    #expect(lease.mustRelock(now: 6))
    #expect(throws: LeaseError.self) { try lease.didUnlock(now: 6) }
}

@Test func localInputRequiresRelockThenManualUnlock() throws {
    var lease = LockedUseLease(now: 0, duration: 120)
    _ = try lease.begin(now: 1, locked: true)
    let authorized5 = lease.consumeAuthorization(now: 2)
    #expect(authorized5)
    try lease.didUnlock(now: 3)
    lease.interrupt("Local input: unlock manually.")
    lease.observe(locked: false, now: 4)
    #expect(throws: LeaseError.self) { try lease.begin(now: 4, locked: false) }
    lease.observe(locked: true, now: 5)
    #expect(lease.phase == .suspended)
    #expect(throws: LeaseError.self) { try lease.begin(now: 6, locked: true) }
    lease.observe(locked: false, now: 7)
    #expect(lease.phase == .armed)
    #expect(!(try lease.begin(now: 8, locked: false)))
}

@Test func heartbeatDoesNotExtendOwnerAuthorization() throws {
    var lease = LockedUseLease(now: 0, duration: 30)
    _ = try lease.begin(now: 1, locked: true)
    let authorized6 = lease.consumeAuthorization(now: 2)
    #expect(authorized6)
    try lease.didUnlock(now: 3)
    lease.heartbeat(now: 29)
    #expect(lease.mustRelock(now: 30))
    lease.interrupt("Session expired")
    lease.observe(locked: true, now: 31)
    lease.observe(locked: false, now: 32)
    #expect(lease.phase == .expired)
    #expect(throws: LeaseError.self) { try lease.begin(now: 32, locked: false) }
}
