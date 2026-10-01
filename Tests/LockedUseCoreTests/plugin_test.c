// Uses the actual macOS plugin ABI, with OS identity/socket services replaced
// at the boundary. Never installs a rule or unlocks the test machine.
#include <assert.h>
#include <stdio.h>
#include "../../locked-use/AuthorizationPlugin.c"

static char right_name[80] = "system.login.screensaver";
static int32_t client_pid = 42;
static int32_t creator_pid = 42;
static bool apple_client = true, apple_creator = true, missing_provenance;
static bool missing_right, bad_pid_length, signed_client = true;
static bool console_present = true, grant = true, switch_user, password_present;
static int requests, console_reads;
static AuthorizationResult outcome;

bool skfiy_is_loginwindow(int32_t pid) { return pid == 42 && signed_client; }
bool skfiy_console_user(uint32_t *uid) {
    *uid = switch_user && console_reads++ > 0 ? 502 : 501;
    return console_present;
}
bool skfiy_authorization_request(uint32_t uid) { assert(uid == 501); requests++; return grant; }

static OSStatus hints(AuthorizationEngineRef engine, AuthorizationString key, const AuthorizationValue **out) {
    (void)engine;
    static AuthorizationValue value;
    if (strcmp(key, "authorize-right") == 0) {
        if (missing_right) return errAuthorizationDenied;
        value = (AuthorizationValue){strlen(right_name), right_name};
    } else if (strcmp(key, "client-pid") == 0) {
        value = (AuthorizationValue){bad_pid_length ? 1 : sizeof(client_pid), &client_pid};
    } else if (strcmp(key, "creator-pid") == 0) {
        value = (AuthorizationValue){sizeof(creator_pid), &creator_pid};
    } else { return errAuthorizationDenied; }
    *out = &value;
    return errSecSuccess;
}
static OSStatus provenance(AuthorizationEngineRef engine, AuthorizationString key, const AuthorizationValue **out) {
    (void)engine;
    static AuthorizationValue value;
    if (missing_provenance) return errAuthorizationDenied;
    if (strcmp(key, "client-apple-signed") == 0 || strcmp(key, "client-firstparty-signed") == 0)
        value = (AuthorizationValue){sizeof(apple_client), &apple_client};
    else if (strcmp(key, "creator-apple-signed") == 0 || strcmp(key, "creator-firstparty-signed") == 0)
        value = (AuthorizationValue){sizeof(apple_creator), &apple_creator};
    else return errAuthorizationDenied; // PID and right are NOT immutable hints.
    *out = &value;
    return errSecSuccess;
}
static OSStatus context(AuthorizationEngineRef engine, AuthorizationString key,
                        AuthorizationContextFlags *flags, const AuthorizationValue **out) {
    (void)engine; (void)flags;
    assert(strcmp(key, kAuthorizationEnvironmentPassword) == 0);
    // Invalid data pointer detects any accidental reading of password bytes.
    static AuthorizationValue value = {8, (void *)1};
    *out = password_present ? &value : NULL;
    return password_present ? errSecSuccess : errAuthorizationDenied;
}
static OSStatus result(AuthorizationEngineRef engine, AuthorizationResult value) {
    (void)engine; outcome = value; return errSecSuccess;
}
static OSStatus deactivated(AuthorizationEngineRef engine) { (void)engine; return errSecSuccess; }

static void expect(AuthorizationMechanismRef mechanism, bool allow, int expected_requests) {
    requests = console_reads = 0;
    outcome = kAuthorizationResultUndefined;
    assert(invoke(mechanism) == errSecSuccess);
    assert(outcome == (allow ? kAuthorizationResultAllow : kAuthorizationResultDeny));
    assert(requests == expected_requests);
}

int main(void) {
    AuthorizationCallbacks callbacks = {.version = kAuthorizationCallbacksVersion,
        .GetImmutableHintValue = provenance, .GetHintValue = hints, .GetContextValue = context,
        .SetResult = result, .DidDeactivate = deactivated};
    AuthorizationPluginRef plugin = NULL;
    const AuthorizationPluginInterface *api = NULL;
    assert(AuthorizationPluginCreate(&callbacks, &plugin, &api) == errSecSuccess);
    AuthorizationMechanismRef mechanism = NULL;
    assert(api->MechanismCreate(plugin, (AuthorizationEngineRef)1, "other", &mechanism) != errSecSuccess);
    assert(api->MechanismCreate(plugin, (AuthorizationEngineRef)1, "unlock", &mechanism) == errSecSuccess);
    expect(mechanism, true, 1);
    apple_client = false; expect(mechanism, false, 0); apple_client = true;
    apple_creator = false; expect(mechanism, false, 0); apple_creator = true;
    missing_provenance = true; expect(mechanism, false, 0); missing_provenance = false;
    creator_pid = 43; expect(mechanism, false, 0); creator_pid = 42;
    missing_right = true; expect(mechanism, false, 0); missing_right = false;
    strcpy(right_name, "system.login.console"); expect(mechanism, false, 0);
    strcpy(right_name, "system.login.screensaver.extra"); expect(mechanism, false, 0);
    strcpy(right_name, "system.login.screensaver");
    bad_pid_length = true; expect(mechanism, false, 0); bad_pid_length = false;
    client_pid = 43; expect(mechanism, false, 0); client_pid = 42;
    signed_client = false; expect(mechanism, false, 0); signed_client = true;
    password_present = true; expect(mechanism, false, 0); password_present = false;
    console_present = false; expect(mechanism, false, 0); console_present = true;
    grant = false; expect(mechanism, false, 1); grant = true;
    switch_user = true; expect(mechanism, false, 1); switch_user = false;
    assert(api->MechanismDeactivate(mechanism) == errSecSuccess);
    assert(api->MechanismDestroy(mechanism) == errSecSuccess);
    assert(api->PluginDestroy(plugin) == errSecSuccess);
    callbacks.GetImmutableHintValue = NULL;
    assert(AuthorizationPluginCreate(&callbacks, &plugin, &api) != errSecSuccess);
    puts("authorization plugin boundary tests passed");
    return 0;
}
