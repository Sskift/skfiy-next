/* Run the actual plugin callbacks against a local fake transport. This never
 * loads SecurityAgent, writes authorization rules, or unlocks a screen. */
#include "LockedUseSupport.h"
#include <Security/AuthorizationPlugin.h>
#include <arpa/inet.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static uint32_t owner_uid = 501;
static uid_t context_uid = 501;
static int context_present, peer_matches = 1, connect_ok = 1, read_ok = 1;
static int corrupt_offset = -1, connect_count;
static uint8_t sent[SKLU_PACKET_SIZE];
static AuthorizationResult observed = kAuthorizationResultUndefined;

uint32_t sklu_console_uid(void) { return owner_uid; }
int sklu_connect_guardian(uid_t uid) { assert(uid == owner_uid); connect_count++; return connect_ok ? dup(STDERR_FILENO) : -1; }
int sklu_peer_matches_guardian(int fd, uid_t uid) { (void)fd; (void)uid; return peer_matches; }
int sklu_random_nonce(uint8_t nonce[16]) { memset(nonce, 0xa5, 16); return 1; }
int sklu_write_packet(int fd, const uint8_t packet[SKLU_PACKET_SIZE]) { (void)fd; memcpy(sent, packet, sizeof(sent)); return 1; }
int sklu_read_packet(int fd, uint8_t packet[SKLU_PACKET_SIZE]) {
    (void)fd;
    if (!read_ok) return 0;
    memcpy(packet, sent, SKLU_PACKET_SIZE);
    uint16_t allow = htons(SKLU_ALLOW);
    memcpy(packet + 6, &allow, 2);
    if (corrupt_offset >= 0) packet[corrupt_offset] ^= 0xff;
    return 1;
}

static OSStatus set_result(AuthorizationEngineRef engine, AuthorizationResult result) {
    (void)engine; observed = result; return errAuthorizationSuccess;
}
static OSStatus get_context(AuthorizationEngineRef engine, AuthorizationString key,
                            AuthorizationContextFlags *flags, const AuthorizationValue **value) {
    (void)engine; (void)flags; assert(strcmp(key, "uid") == 0);
    static AuthorizationValue result;
    if (!context_present) return errAuthorizationInternal;
    result.length = sizeof(context_uid); result.data = &context_uid; *value = &result;
    return errAuthorizationSuccess;
}
static OSStatus did_deactivate(AuthorizationEngineRef engine) { (void)engine; return errAuthorizationSuccess; }

int main(void) {
    AuthorizationCallbacks callbacks = { .version = kAuthorizationCallbacksVersion,
        .SetResult = set_result, .GetContextValue = get_context, .DidDeactivate = did_deactivate };
    AuthorizationPluginRef plugin = NULL;
    const AuthorizationPluginInterface *interface = NULL;
    AuthorizationCallbacks incomplete = {0};
    assert(AuthorizationPluginCreate(&incomplete, &plugin, &interface) != errAuthorizationSuccess);
    assert(AuthorizationPluginCreate(&callbacks, &plugin, &interface) == errAuthorizationSuccess);
    AuthorizationMechanismRef mechanism = NULL;
    assert(interface->MechanismCreate(plugin, (AuthorizationEngineRef)1, "unknown", &mechanism) != errAuthorizationSuccess);
    assert(interface->MechanismCreate(plugin, (AuthorizationEngineRef)1, "remote", &mechanism) == errAuthorizationSuccess);
    assert(interface->MechanismInvoke(mechanism) == errAuthorizationSuccess && observed == kAuthorizationResultAllow);
    owner_uid = UINT32_MAX;
    int before = connect_count;
    interface->MechanismInvoke(mechanism);
    assert(observed == kAuthorizationResultDeny && before == connect_count);
    owner_uid = 501;
    context_present = 1; context_uid = 502;
    interface->MechanismInvoke(mechanism);
    assert(observed == kAuthorizationResultDeny && before == connect_count);
    context_uid = 501;
    connect_ok = 0;
    interface->MechanismInvoke(mechanism); assert(observed == kAuthorizationResultDeny);
    connect_ok = 1; peer_matches = 0;
    interface->MechanismInvoke(mechanism); assert(observed == kAuthorizationResultDeny);
    peer_matches = 1; read_ok = 0;
    interface->MechanismInvoke(mechanism); assert(observed == kAuthorizationResultDeny);
    read_ok = 1;
    /* Every individual response byte is authenticated by the exact expected
     * envelope + echoed random nonce; malformed fields and replay nonce deny. */
    for (corrupt_offset = 0; corrupt_offset < SKLU_PACKET_SIZE; corrupt_offset++) {
        interface->MechanismInvoke(mechanism); assert(observed == kAuthorizationResultDeny);
    }
    corrupt_offset = -1;
    interface->MechanismInvoke(mechanism); assert(observed == kAuthorizationResultAllow);
    assert(interface->MechanismDeactivate(mechanism) == errAuthorizationSuccess);
    interface->MechanismDestroy(mechanism);
    interface->PluginDestroy(plugin);
    puts("PASS: plugin callbacks, unavailable/untrusted broker, UID mismatch, and all 32 corrupt response bytes deny.");
    return 0;
}
