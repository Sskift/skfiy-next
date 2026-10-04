#include "LockedUseSupport.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <SystemConfiguration/SystemConfiguration.h>
#include <bsm/libbsm.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <os/log.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

static os_log_t support_logger;
static void initialize_support_logger(void *unused) {
    (void)unused;
    support_logger = os_log_create("com.skfiy.locked-use", "peer-validation");
}
static os_log_t support_log(void) {
    static dispatch_once_t once;
    dispatch_once_f(&once, NULL, initialize_support_logger);
    return support_logger;
}

static void log_code_denial(const char *reason, OSStatus status) {
    os_log_error(support_log(), "peer_code_denied reason=%{public}s status=%{public}d", reason, (int)status);
}

static int peer_token(int fd, audit_token_t *token) {
    socklen_t size = sizeof(*token);
    int status = getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token, &size);
    if (status != 0 || size != sizeof(*token)) {
        os_log_error(support_log(), "peer_identity_denied reason=audit_token_unavailable errno=%{public}d size=%{public}u", status == 0 ? 0 : errno, size);
        return 0;
    }
    return 1;
}

uint32_t sklu_console_uid(void) {
    uid_t uid = (uid_t)-1;
    gid_t gid = (gid_t)-1;
    CFStringRef user = SCDynamicStoreCopyConsoleUser(NULL, &uid, &gid);
    if (!user) return UINT32_MAX;
    int invalid = CFEqual(user, CFSTR("loginwindow")) || CFEqual(user, CFSTR("_mbsetupuser"));
    CFRelease(user);
    return invalid || uid == 0 || uid == (uid_t)-1 ? UINT32_MAX : uid;
}

int sklu_peer_identity(int fd, pid_t *pid, uid_t *euid, uid_t *auid) {
    audit_token_t token;
    if (!peer_token(fd, &token)) return 0;
    if (pid) *pid = audit_token_to_pid(token);
    if (euid) *euid = audit_token_to_euid(token);
    if (auid) *auid = audit_token_to_auid(token);
    return 1;
}

static SecCodeRef peer_code(int fd) {
    audit_token_t token;
    if (!peer_token(fd, &token)) return NULL;
    CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
    if (!data) return NULL;
    const void *keys[] = { kSecGuestAttributeAudit };
    const void *values[] = { data };
    CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL;
    if (attrs) {
        OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
        if (status != errSecSuccess) log_code_denial("audit_code_lookup_failed", status);
    }
    if (attrs) CFRelease(attrs);
    CFRelease(data);
    return code;
}

static int trusted_file(const char *path) {
    /* Authenticate the installation, including every ancestor. A protected
     * leaf in an owner-writable directory can still be renamed/substituted. */
    struct stat st;
    char ancestor[PATH_MAX];
    if (strlcpy(ancestor, path, sizeof(ancestor)) >= sizeof(ancestor) || ancestor[0] != '/') return 0;
    for (char *cursor = ancestor + 1; *cursor; cursor++) {
        if (*cursor != '/') continue;
        *cursor = '\0';
        int protected = lstat(ancestor, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == 0 && (st.st_mode & 0022) == 0;
        *cursor = '/';
        if (!protected) return 0;
    }
    return lstat(path, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 0 && (st.st_mode & 0022) == 0;
}

static int code_matches_file(SecCodeRef code, const char *path) {
    if (!code) { log_code_denial("dynamic_code_missing", 0); return 0; }
    if (!trusted_file(path)) { log_code_denial("pinned_installation_not_root_protected", 0); return 0; }
    OSStatus status = SecCodeCheckValidity(code, kSecCSDefaultFlags, NULL);
    if (status != errSecSuccess) { log_code_denial("dynamic_signature_invalid", status); return 0; }
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), false);
    SecStaticCodeRef pinned = NULL, running = NULL;
    CFDictionaryRef expected_info = NULL, actual_info = NULL;
    int matches = 0;
    const char *reason = "pinned_url_unavailable";
    if (!url) goto done;
    reason = "pinned_code_lookup_failed";
    if ((status = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &pinned)) != errSecSuccess) goto done;
    reason = "pinned_signature_invalid";
    if ((status = SecStaticCodeCheckValidity(pinned, kSecCSDefaultFlags, NULL)) != errSecSuccess) goto done;
    reason = "dynamic_static_code_lookup_failed";
    if ((status = SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &running)) != errSecSuccess) goto done;
    reason = "pinned_signing_information_unavailable";
    if ((status = SecCodeCopySigningInformation(pinned, kSecCSSigningInformation, &expected_info)) != errSecSuccess) goto done;
    reason = "dynamic_signing_information_unavailable";
    if ((status = SecCodeCopySigningInformation(running, kSecCSSigningInformation, &actual_info)) != errSecSuccess) goto done;
    CFTypeRef expected = CFDictionaryGetValue(expected_info, kSecCodeInfoUnique);
    CFTypeRef actual = CFDictionaryGetValue(actual_info, kSecCodeInfoUnique);
    CFTypeRef flags_value = CFDictionaryGetValue(expected_info, kSecCodeInfoFlags);
    int32_t signing_flags = 0;
    int hardened = flags_value && CFGetTypeID(flags_value) == CFNumberGetTypeID() &&
        CFNumberGetValue(flags_value, kCFNumberSInt32Type, &signing_flags) &&
        (signing_flags & kSecCodeSignatureRuntime) != 0;
    matches = hardened && expected && actual && CFGetTypeID(expected) == CFDataGetTypeID() && CFEqual(expected, actual);
    reason = hardened ? "pinned_cdhash_mismatch" : "pinned_hardened_runtime_missing";
done:
    if (!matches) log_code_denial(reason, status);
    if (actual_info) CFRelease(actual_info);
    if (expected_info) CFRelease(expected_info);
    if (running) CFRelease(running);
    if (pinned) CFRelease(pinned);
    if (url) CFRelease(url);
    return matches;
}

int sklu_peer_matches_guardian(int fd, uid_t uid) {
    pid_t pid = -1;
    uid_t peer_uid = (uid_t)-1, auid = (uid_t)-1;
    if (!sklu_peer_identity(fd, &pid, &peer_uid, &auid)) return 0;
    if (peer_uid != uid) {
        os_log_error(support_log(), "guardian_peer_denied reason=owner_euid_mismatch pid=%{public}d euid=%{public}u auid=%{public}u expected_uid=%{public}u", pid, peer_uid, auid, uid);
        return 0;
    }
    SecCodeRef code = peer_code(fd);
    int result = code_matches_file(code, SKLU_GUARDIAN_PATH);
    os_log(support_log(), "guardian_peer_result allowed=%{public}d pid=%{public}d euid=%{public}u auid=%{public}u expected_uid=%{public}u", result, pid, peer_uid, auid, uid);
    if (code) CFRelease(code);
    return result;
}

int sklu_peer_is_security_agent(int fd, uid_t expected_auid) {
    pid_t pid = -1;
    uid_t euid = (uid_t)-1, auid = (uid_t)-1;
    if (!sklu_peer_identity(fd, &pid, &euid, &auid)) return 0;
    if (auid != expected_auid) {
        os_log_error(support_log(), "authorization_peer_denied reason=session_auid_mismatch pid=%{public}d euid=%{public}u auid=%{public}u expected_auid=%{public}u", pid, euid, auid, expected_auid);
        return 0;
    }
    SecCodeRef code = peer_code(fd);
    SecRequirementRef requirement = NULL;
    int result = 0;
    if (!code) return 0;
    /* macOS hosts the plugin in an architecture-specific SecurityAgent XPC
     * helper. These exact identifiers were verified from the installed Apple
     * binaries' designated requirements; anchor apple and session auid remain
     * mandatory for all three eligible hosts. */
    OSStatus status = SecRequirementCreateWithString(CFSTR("anchor apple and (identifier \"com.apple.SecurityAgent\" or identifier \"com.apple.SecurityAgentHelper.arm64\" or identifier \"com.apple.SecurityAgentHelper.x86_64\")"),
                                     kSecCSDefaultFlags, &requirement);
    if (status == errSecSuccess) {
        status = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
        result = status == errSecSuccess;
    }
    os_log(support_log(), "authorization_peer_result allowed=%{public}d reason=%{public}s status=%{public}d pid=%{public}d euid=%{public}u auid=%{public}u expected_auid=%{public}u", result, result ? "verified_apple_authorization_host" : "apple_authorization_host_signature_invalid", (int)status, pid, euid, auid, expected_auid);
    if (requirement) CFRelease(requirement);
    CFRelease(code);
    return result;
}

static int parent_matches_file(const char *path) {
    pid_t pid = getppid();
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    if (!number) return 0;
    const void *keys[] = { kSecGuestAttributePid };
    const void *values[] = { number };
    CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL;
    if (attrs) SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
    int result = code_matches_file(code, path) && getppid() == pid;
    if (code) CFRelease(code);
    if (attrs) CFRelease(attrs);
    CFRelease(number);
    return result;
}

int sklu_parent_matches_pinned_mcp(void) { return parent_matches_file(SKLU_MCP_PATH); }
int sklu_parent_matches_pinned_guardian(void) { return parent_matches_file(SKLU_GUARDIAN_PATH); }

static int socket_address(uid_t uid, struct sockaddr_un *address) {
    memset(address, 0, sizeof(*address));
    address->sun_family = AF_UNIX;
    address->sun_len = sizeof(*address);
    int length = snprintf(address->sun_path, sizeof(address->sun_path),
        SKLU_SOCKET_ROOT "/%u/guardian.sock", uid);
    return length > 0 && (size_t)length < sizeof(address->sun_path);
}

static int configure_socket(int fd) {
    struct timeval timeout = { .tv_sec = 1, .tv_usec = 0 };
    int one = 1;
    return fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 &&
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) == 0 &&
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0 &&
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0;
}

int sklu_create_listener(uid_t uid) {
    struct sockaddr_un address;
    char directory[sizeof(address.sun_path)];
    struct stat st;
    if (uid != geteuid() || !socket_address(uid, &address)) { errno = EPERM; return -1; }
    if (lstat(SKLU_SOCKET_ROOT, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 || (st.st_mode & 0022)) {
        errno = EPERM; return -1;
    }
    snprintf(directory, sizeof(directory), SKLU_SOCKET_ROOT "/%u", uid);
    if (lstat(directory, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != uid || (st.st_mode & 0077) != 0011) {
        errno = EPERM; return -1;
    }
    if (lstat(address.sun_path, &st) == 0) {
        if (!S_ISSOCK(st.st_mode) || st.st_uid != uid) { errno = EPERM; return -1; }
        int existing = sklu_connect_guardian(uid);
        if (existing >= 0) { close(existing); errno = EADDRINUSE; return -1; }
        if (errno != ECONNREFUSED && errno != ENOENT) return -1;
        if (unlink(address.sun_path) != 0) return -1;
    } else if (errno != ENOENT) return -1;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (!configure_socket(fd) || bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 ||
        chmod(address.sun_path, 0666) != 0 || listen(fd, 8) != 0 || fcntl(fd, F_SETFL, O_NONBLOCK) != 0) {
        int error = errno; close(fd); errno = error; return -1;
    }
    return fd;
}

int sklu_accept_peer(int listener) {
    int fd = accept(listener, NULL, NULL);
    if (fd >= 0 && (!configure_socket(fd) || fcntl(fd, F_SETFL, 0) != 0)) {
        int error = errno; close(fd); errno = error; return -1;
    }
    return fd;
}

int sklu_remove_listener(uid_t uid) {
    struct sockaddr_un address;
    struct stat st;
    if (uid != geteuid() || !socket_address(uid, &address)) { errno = EPERM; return 0; }
    if (lstat(address.sun_path, &st) != 0) return errno == ENOENT;
    if (!S_ISSOCK(st.st_mode) || st.st_uid != uid) { errno = EPERM; return 0; }
    return unlink(address.sun_path) == 0;
}

int sklu_connect_guardian(uid_t uid) {
    struct sockaddr_un address;
    if (!socket_address(uid, &address)) { errno = EINVAL; return -1; }
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (!configure_socket(fd) || connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        int error = errno; close(fd); errno = error; return -1;
    }
    return fd;
}

int sklu_read_packet(int fd, uint8_t packet[SKLU_PACKET_SIZE]) {
    size_t offset = 0;
    while (offset < SKLU_PACKET_SIZE) {
        ssize_t count = read(fd, packet + offset, SKLU_PACKET_SIZE - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        offset += (size_t)count;
    }
    return 1;
}

int sklu_write_packet(int fd, const uint8_t packet[SKLU_PACKET_SIZE]) {
    size_t offset = 0;
    while (offset < SKLU_PACKET_SIZE) {
        ssize_t count = write(fd, packet + offset, SKLU_PACKET_SIZE - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        offset += (size_t)count;
    }
    return 1;
}

int sklu_random_nonce(uint8_t nonce[16]) {
    return SecRandomCopyBytes(kSecRandomDefault, 16, nonce) == errSecSuccess;
}
