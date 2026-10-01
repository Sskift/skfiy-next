// Opt-in screensaver authorization branch. Never used for login, sudo,
// FileVault, keychain access or system preference authorization.
#include <Security/AuthorizationPlugin.h>
#include <Security/AuthorizationTags.h>
#include <Security/SecBase.h>
#include <stdlib.h>
#include <string.h>
#include "LockedUseCore.h"

typedef struct { const AuthorizationCallbacks *callbacks; } Plugin;
typedef struct { Plugin *plugin; AuthorizationEngineRef engine; } Mechanism;

static bool immutable(Mechanism *m, const char *key, const AuthorizationValue **value) {
    return m->plugin->callbacks->GetImmutableHintValue(m->engine, key, value) == errSecSuccess &&
           *value && (*value)->data;
}

static bool immutable_true(Mechanism *m, const char *key) {
    const AuthorizationValue *value = NULL;
    if (!immutable(m, key, &value) || value->length != sizeof(bool)) return false;
    // Read as a byte: malformed non-Boolean representations must not pass.
    return *(const unsigned char *)value->data == 1;
}

static bool hint(Mechanism *m, const char *key, const AuthorizationValue **value) {
    return m->plugin->callbacks->GetHintValue(m->engine, key, value) == errSecSuccess &&
           *value && (*value)->data;
}

static bool string_is(const AuthorizationValue *value, const char *text) {
    size_t size = strlen(text);
    return (value->length == size || (value->length == size + 1 && ((char *)value->data)[size] == 0)) &&
           memcmp(value->data, text, size) == 0;
}

static bool authorize(Mechanism *m) {
    const AuthorizationValue *value = NULL;
    // Apple's engine exposes signing provenance as immutable hints; PID/right
    // are ordinary hints, set by authd. Reject non-Apple clients AND creators
    // first, including forwarded AuthorizationRefs from untrusted processes.
    // This is the first mechanism in the installer-owned branch: no earlier
    // third-party mechanism is allowed to rewrite these ordinary hints.
    if (!immutable_true(m, "client-apple-signed") || !immutable_true(m, "client-firstparty-signed") ||
        !immutable_true(m, "creator-apple-signed") || !immutable_true(m, "creator-firstparty-signed")) return false;
    if (!hint(m, "authorize-right", &value) || !string_is(value, "system.login.screensaver")) return false;
    if (!hint(m, "client-pid", &value) || value->length != sizeof(int32_t)) return false;
    int32_t pid;
    memcpy(&pid, value->data, sizeof(pid));
    if (!hint(m, "creator-pid", &value) || value->length != sizeof(int32_t)) return false;
    int32_t creator;
    memcpy(&creator, value->data, sizeof(creator));
    if (creator != pid) return false;

    // A password/Touch ID attempt belongs to the system fallback, not this branch.
    // Never read, change, save, inject or log password bytes.
    AuthorizationContextFlags flags;
    value = NULL;
    OSStatus context_status = m->plugin->callbacks->GetContextValue(m->engine, kAuthorizationEnvironmentPassword, &flags, &value);
    if (context_status == errSecSuccess) {
        if (!value || value->length > 0) return false;
    } else if (context_status != errAuthorizationValueNotFound) {
        return false; // An unknown password context is never an empty context.
    }
    // Normal password attempts have already returned to the system fallback,
    // without waiting for code-signature checks or the guardian's IPC.
    if (!skfiy_is_loginwindow(pid)) return false;
    uint32_t uid, after;
    return skfiy_console_user(&uid) && skfiy_authorization_request(uid) &&
           skfiy_console_user(&after) && uid == after;
}

static OSStatus destroy_plugin(AuthorizationPluginRef ref) { free(ref); return errSecSuccess; }
static OSStatus create_mechanism(AuthorizationPluginRef ref, AuthorizationEngineRef engine,
                                  AuthorizationMechanismId name, AuthorizationMechanismRef *out) {
    if (!ref || !out || !name || strcmp(name, "unlock") != 0) return errAuthorizationInternal;
    Mechanism *m = calloc(1, sizeof(*m));
    if (!m) return errAuthorizationInternal;
    m->plugin = ref;
    m->engine = engine;
    *out = m;
    return errSecSuccess;
}
static OSStatus invoke(AuthorizationMechanismRef ref) {
    Mechanism *m = ref;
    return m->plugin->callbacks->SetResult(m->engine,
        authorize(m) ? kAuthorizationResultAllow : kAuthorizationResultDeny);
}
static OSStatus deactivate(AuthorizationMechanismRef ref) {
    Mechanism *m = ref;
    return m->plugin->callbacks->DidDeactivate(m->engine);
}
static OSStatus destroy_mechanism(AuthorizationMechanismRef ref) { free(ref); return errSecSuccess; }
static const AuthorizationPluginInterface interface = {
    kAuthorizationPluginInterfaceVersion, destroy_plugin, create_mechanism,
    invoke, deactivate, destroy_mechanism
};

OSStatus AuthorizationPluginCreate(const AuthorizationCallbacks *callbacks,
                                   AuthorizationPluginRef *out,
                                   const AuthorizationPluginInterface **out_interface) {
    if (!callbacks || !out || !out_interface || callbacks->version < 1 ||
        !callbacks->GetImmutableHintValue || !callbacks->GetHintValue || !callbacks->GetContextValue ||
        !callbacks->SetResult || !callbacks->DidDeactivate) return errAuthorizationInternal;
    Plugin *plugin = calloc(1, sizeof(*plugin));
    if (!plugin) return errAuthorizationInternal;
    plugin->callbacks = callbacks;
    *out = plugin;
    *out_interface = &interface;
    return errSecSuccess;
}
