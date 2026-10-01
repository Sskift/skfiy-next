#include "LockedUseCore.h"
#include <math.h>
#include <string.h>

bool skfiy_lease_arm(SkfiyLockedLease *s, uint32_t uid, double now,
                     double duration, bool unlocked, bool user_approved) {
    memset(s, 0, sizeof(*s));
    if (!unlocked || !user_approved || uid < 501 || !isfinite(now) || now < 0 ||
        !isfinite(duration) || duration < 1 || duration > 3600) return false;
    s->uid = uid;
    s->expires_at = now + duration;
    s->heartbeat_at = now;
    s->armed = true;
    return true;
}

bool skfiy_lease_valid(const SkfiyLockedLease *s, double now) {
    return s->armed && !s->revoked && isfinite(now) && now >= s->heartbeat_at &&
           now < s->expires_at && now - s->heartbeat_at < 5;
}

bool skfiy_lease_begin(SkfiyLockedLease *s, double now) {
    if (!skfiy_lease_valid(s, now) || s->active) return false;
    s->active = true;
    s->consumed = false;
    return true;
}

bool skfiy_lease_prepare_unlock(SkfiyLockedLease *s, double now,
                               bool covered, bool input_guarded) {
    if (!skfiy_lease_valid(s, now) || !s->active || s->consumed ||
        s->authorization_until != 0 || !covered || !input_guarded) return false;
    s->covered = covered;
    s->input_guarded = input_guarded;
    s->authorization_until = fmin(now + 3, s->expires_at);
    return true;
}

bool skfiy_lease_pending(const SkfiyLockedLease *s, uint32_t uid, double now) {
    if (!skfiy_lease_valid(s, now) || !s->active || s->uid != uid ||
        !s->covered || !s->input_guarded || s->consumed ||
        s->authorization_until == 0 || now >= s->authorization_until) return false;
    return true;
}

bool skfiy_lease_authorize(SkfiyLockedLease *s, uint32_t uid, double now) {
    if (!skfiy_lease_pending(s, uid, now)) return false;
    s->consumed = true;  // A permit is consumed once, even if unlock later fails.
    s->authorization_until = 0;
    return true;
}

void skfiy_lease_heartbeat(SkfiyLockedLease *s, double now) {
    // A late heartbeat cannot revive an expired or disconnected lease.
    if (skfiy_lease_valid(s, now)) s->heartbeat_at = now;
    else skfiy_lease_revoke(s);
}

void skfiy_lease_end(SkfiyLockedLease *s) {
    s->active = false;
    s->authorization_until = 0;
    s->consumed = false;
    s->covered = false;
    s->input_guarded = false;
}

void skfiy_lease_revoke(SkfiyLockedLease *s) {
    skfiy_lease_end(s);
    s->revoked = true;
    s->armed = false;
}
