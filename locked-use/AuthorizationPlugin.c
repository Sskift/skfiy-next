#include "LockedUseSupport.h"
#include <Security/AuthorizationPlugin.h>
#include <arpa/inet.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <os/log.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct { const AuthorizationCallbacks *callbacks; } Plugin;
typedef struct { Plugin *plugin; AuthorizationEngineRef engine; } Mechanism;

static os_log_t plugin_logger;
static void initialize_plugin_logger(void *unused) {
    (void)unused;
    plugin_logger = os_log_create("com.skfiy.locked-use", "authorization-plugin");
}
static os_log_t plugin_log(void) {
    static dispatch_once_t once;
    dispatch_once_f(&once, NULL, initialize_plugin_logger);
    return plugin_logger;
}

static OSStatus destroy_plugin(AuthorizationPluginRef ref) { free(ref); return errAuthorizationSuccess; }

static OSStatus create_mechanism(AuthorizationPluginRef ref, AuthorizationEngineRef engine,
                                AuthorizationMechanismId id, AuthorizationMechanismRef *result) {
    if (!ref || !engine || !result || strcmp(id, "remote") != 0) return errAuthorizationInternal;
    Mechanism *mechanism = calloc(1, sizeof(*mechanism));
    if (!mechanism) return errAuthorizationInternal;
    mechanism->plugin = ref;
    mechanism->engine = engine;
    *result = mechanism;
    return errAuthorizationSuccess;
}

static int request_authorization(uid_t uid) {
    int fd = sklu_connect_guardian(uid);
    if (fd < 0) {
        os_log_error(plugin_log(), "unlock_authorization_denied reason=guardian_connect_failed uid=%{public}u errno=%{public}d", uid, errno);
        return 0;
    }
    int allowed = 0;
    const char *reason = "guardian_identity_rejected";
    if (!sklu_peer_matches_guardian(fd, uid)) goto done;
    uint8_t request[SKLU_PACKET_SIZE] = {0}, response[SKLU_PACKET_SIZE] = {0};
    uint32_t magic = htonl(SKLU_MAGIC), owner = htonl(uid);
    uint16_t version = htons(SKLU_VERSION), kind = htons(SKLU_REQUEST);
    memcpy(request, &magic, 4);
    memcpy(request + 4, &version, 2);
    memcpy(request + 6, &kind, 2);
    memcpy(request + 8, &owner, 4);
    reason = "nonce_generation_failed";
    if (!sklu_random_nonce(request + 16)) goto done;
    reason = "request_write_failed";
    if (!sklu_write_packet(fd, request)) goto done;
    reason = "response_read_failed";
    if (!sklu_read_packet(fd, response)) goto done;
    reason = "response_protocol_mismatch";
    if (memcmp(request, response, 6) != 0) goto done;
    reason = "response_owner_mismatch";
    if (memcmp(request + 8, response + 8, 4) != 0) goto done;
    reason = "response_reserved_mismatch";
    if (memcmp(request + 12, response + 12, 4) != 0) goto done;
    reason = "response_nonce_mismatch";
    if (memcmp(request + 16, response + 16, 16) != 0) goto done;
    uint16_t response_kind;
    memcpy(&response_kind, response + 6, 2);
    response_kind = ntohs(response_kind);
    reason = response_kind == SKLU_DENY ? "guardian_denied" : "response_kind_invalid";
    if (response_kind != SKLU_ALLOW) goto done;
    kind = htons(SKLU_ALLOW);
    memcpy(request + 6, &kind, 2);
    allowed = memcmp(request, response, sizeof(request)) == 0;
    reason = allowed ? "guardian_allowed" : "response_envelope_invalid";
done:
    os_log(plugin_log(), "unlock_authorization_result allowed=%{public}d reason=%{public}s uid=%{public}u", allowed, reason, uid);
    close(fd);
    return allowed;
}

static OSStatus invoke_mechanism(AuthorizationMechanismRef ref) {
    Mechanism *mechanism = ref;
    if (!mechanism) return errAuthorizationInternal;
    const AuthorizationCallbacks *callbacks = mechanism->plugin->callbacks;
    uid_t uid = sklu_console_uid();
    os_log(plugin_log(), "unlock_authorization_invoked pid=%{public}d euid=%{public}u console_uid=%{public}u", getpid(), geteuid(), uid);
    const char *denial = uid == UINT32_MAX ? "console_owner_unavailable" : NULL;
    /* A context UID, when supplied by the authorization engine, must agree
     * with the current console owner. Never authorize a login/new account. */
    const AuthorizationValue *value = NULL;
    AuthorizationContextFlags flags = 0;
    if (uid != UINT32_MAX && callbacks->GetContextValue(mechanism->engine, "uid", &flags, &value) == errAuthorizationSuccess && value) {
        uid_t context_uid;
        if (value->length != sizeof(context_uid) || !value->data) { uid = UINT32_MAX; denial = "context_uid_invalid_shape"; }
        else {
            memcpy(&context_uid, value->data, sizeof(context_uid));
            if (context_uid != uid) {
                os_log_error(plugin_log(), "unlock_authorization_denied reason=context_uid_mismatch context_uid=%{public}u console_uid=%{public}u", context_uid, uid);
                uid = UINT32_MAX; denial = "context_uid_mismatch";
            }
        }
    }
    if (denial) os_log_error(plugin_log(), "unlock_authorization_denied reason=%{public}s", denial);
    AuthorizationResult result = uid != UINT32_MAX && request_authorization(uid)
        ? kAuthorizationResultAllow : kAuthorizationResultDeny;
    return callbacks->SetResult(mechanism->engine, result);
}

static OSStatus deactivate_mechanism(AuthorizationMechanismRef ref) {
    Mechanism *mechanism = ref;
    return mechanism ? mechanism->plugin->callbacks->DidDeactivate(mechanism->engine) : errAuthorizationInternal;
}
static OSStatus destroy_mechanism(AuthorizationMechanismRef ref) { free(ref); return errAuthorizationSuccess; }

static const AuthorizationPluginInterface interface = {
    .version = kAuthorizationPluginInterfaceVersion,
    .PluginDestroy = destroy_plugin,
    .MechanismCreate = create_mechanism,
    .MechanismInvoke = invoke_mechanism,
    .MechanismDeactivate = deactivate_mechanism,
    .MechanismDestroy = destroy_mechanism
};

__attribute__((visibility("default")))
OSStatus AuthorizationPluginCreate(const AuthorizationCallbacks *callbacks,
                                  AuthorizationPluginRef *result,
                                  const AuthorizationPluginInterface **out_interface) {
    if (!callbacks || !result || !out_interface || !callbacks->SetResult || !callbacks->GetContextValue || !callbacks->DidDeactivate) return errAuthorizationInternal;
    Plugin *plugin = calloc(1, sizeof(*plugin));
    if (!plugin) return errAuthorizationInternal;
    plugin->callbacks = callbacks;
    *result = plugin;
    *out_interface = &interface;
    return errAuthorizationSuccess;
}
