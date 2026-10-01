#include "LockedUseCore.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static SkfiyLockedLease armed(void) {
    SkfiyLockedLease lease;
    assert(skfiy_lease_arm(&lease, 501, 100, 60, true, true));
    return lease;
}

int main(void) {
    SkfiyLockedLease s = {0};
    assert(!skfiy_lease_authorize(&s, 501, 100));
    assert(!skfiy_lease_arm(&s, 501, 100, 60, false, true));
    assert(!skfiy_lease_arm(&s, 501, 100, 60, true, false));
    assert(!skfiy_lease_arm(&s, 0, 100, 60, true, true));
    assert(!skfiy_lease_arm(&s, 501, 100, 3601, true, true));
    assert(!skfiy_lease_arm(&s, 501, 100, NAN, true, true));
    assert(!skfiy_lease_arm(&s, 501, INFINITY, 60, true, true));
    s = armed();
    assert(!skfiy_lease_authorize(&s, 501, 100)); // Arming is not permission to unlock.
    assert(skfiy_lease_begin(&s, 100));
    assert(!skfiy_lease_begin(&s, 100)); // Calls cannot overlap.
    assert(!skfiy_lease_prepare_unlock(&s, 100, false, true));
    assert(!skfiy_lease_prepare_unlock(&s, 100, true, false));
    assert(skfiy_lease_prepare_unlock(&s, 100, true, true));
    assert(!skfiy_lease_authorize(&s, 502, 100));
    assert(skfiy_lease_authorize(&s, 501, 100));
    assert(!skfiy_lease_authorize(&s, 501, 100)); // No replay, even at the same time.
    assert(!skfiy_lease_prepare_unlock(&s, 101, true, true));
    skfiy_lease_end(&s);
    assert(!skfiy_lease_authorize(&s, 501, 101));
    assert(skfiy_lease_begin(&s, 101));
    assert(skfiy_lease_prepare_unlock(&s, 101, true, true));
    assert(!skfiy_lease_authorize(&s, 501, 104)); // Exact boundary is expired.
    assert(!skfiy_lease_authorize(&s, 501, NAN));
    assert(!skfiy_lease_authorize(&s, 501, 99));
    skfiy_lease_heartbeat(&s, 106); // Late heartbeat cannot revive the lease.
    assert(s.revoked && !skfiy_lease_begin(&s, 106));
    s = armed();
    for (int t = 101; t < 160; ++t) skfiy_lease_heartbeat(&s, t);
    assert(!skfiy_lease_begin(&s, 160)); // Heartbeats never extend user approval.
    s = armed();
    assert(skfiy_lease_begin(&s, 100));
    assert(skfiy_lease_prepare_unlock(&s, 100, true, true));
    skfiy_lease_revoke(&s); // Input, disconnect, emergency stop, display change.
    assert(!skfiy_lease_authorize(&s, 501, 100));
    skfiy_lease_heartbeat(&s, 101);
    assert(!skfiy_lease_begin(&s, 101));
    puts("locked-use lease invariants passed");
    return 0;
}
