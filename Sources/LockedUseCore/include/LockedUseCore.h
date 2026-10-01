#ifndef SKFIY_LOCKED_USE_CORE_H
#define SKFIY_LOCKED_USE_CORE_H

#include <stdbool.h>
#include <stdint.h>

// Monotonic seconds only. No persisted grants and no wall-clock deadlines.
typedef struct {
    double expires_at;
    double heartbeat_at;
    double authorization_until;
    uint32_t uid;
    bool armed;
    bool active;
    bool covered;
    bool input_guarded;
    bool consumed;
    bool revoked;
} SkfiyLockedLease;

bool skfiy_lease_arm(SkfiyLockedLease *lease, uint32_t uid, double now,
                     double duration, bool unlocked, bool user_approved);
bool skfiy_lease_begin(SkfiyLockedLease *lease, double now);
bool skfiy_lease_prepare_unlock(SkfiyLockedLease *lease, double now,
                               bool covered, bool input_guarded);
bool skfiy_lease_authorize(SkfiyLockedLease *lease, uint32_t uid, double now);
bool skfiy_lease_pending(const SkfiyLockedLease *lease, uint32_t uid, double now);
bool skfiy_lease_valid(const SkfiyLockedLease *lease, double now);
void skfiy_lease_heartbeat(SkfiyLockedLease *lease, double now);
void skfiy_lease_end(SkfiyLockedLease *lease);
void skfiy_lease_revoke(SkfiyLockedLease *lease);

#ifdef __APPLE__
// Installed paths are fixed, never taken from the agent's environment.
#define SKFIY_GUARDIAN "/Library/Application Support/skfiy/LockedUse.app/Contents/MacOS/skfiy-guardian"
#define SKFIY_SOCKET_ROOT "/Library/Application Support/skfiy/locked-use-runtime"
double skfiy_monotonic_time(void);
bool skfiy_console_user(uint32_t *uid);
bool skfiy_screen_locked(void);
bool skfiy_screen_confirmed_locked(void);
bool skfiy_lock_screen(void);
bool skfiy_can_lock_screen(void);
int skfiy_authorization_listen(uint32_t uid);
int skfiy_authorization_accept(int listener);
bool skfiy_authorization_ready(int client, bool pending);
bool skfiy_authorization_request(uint32_t uid);
void skfiy_authorization_reply(int client, bool allow);
void skfiy_authorization_close(int listener, uint32_t uid);
bool skfiy_is_loginwindow(int32_t pid);
bool skfiy_guardian_installed(void);
#endif

#endif
