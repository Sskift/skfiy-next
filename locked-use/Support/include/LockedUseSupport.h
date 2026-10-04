#ifndef SKFIY_LOCKED_USE_SUPPORT_H
#define SKFIY_LOCKED_USE_SUPPORT_H

#include <stdint.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Local fixed-width wire format, all integer fields in network byte order:
 * magic u32, version u16, kind u16, owner UID u32, reserved u32, nonce[16].
 * The response must echo every request field except kind. Authorization is
 * one-shot; a matching ALLOW is only valid for the current invocation. */
#define SKLU_PACKET_SIZE 32
#define SKLU_MAGIC 0x534B4C55u
#define SKLU_VERSION 1u
#define SKLU_REQUEST 1u
#define SKLU_ALLOW 2u
#define SKLU_DENY 3u
#define SKLU_GUARDIAN_PATH "/Library/PrivilegedHelperTools/com.skfiy.LockedUseGuardian"
#define SKLU_MCP_PATH "/Library/Application Support/skfiy/locked-use/skfiy"
#define SKLU_SOCKET_ROOT "/Library/Application Support/skfiy/locked-use/run"

uint32_t sklu_console_uid(void);
int sklu_peer_identity(int fd, pid_t *pid, uid_t *euid, uid_t *auid);
int sklu_peer_is_security_agent(int fd, uid_t expected_auid);
int sklu_peer_matches_guardian(int fd, uid_t uid);
int sklu_parent_matches_pinned_mcp(void);
int sklu_parent_matches_pinned_guardian(void);
int sklu_create_listener(uid_t uid);
int sklu_remove_listener(uid_t uid);
int sklu_accept_peer(int listener);
int sklu_connect_guardian(uid_t uid);
int sklu_read_packet(int fd, uint8_t packet[SKLU_PACKET_SIZE]);
int sklu_write_packet(int fd, const uint8_t packet[SKLU_PACKET_SIZE]);
int sklu_random_nonce(uint8_t nonce[16]);

#ifdef __cplusplus
}
#endif
#endif
