#include "LockedUseCore.h"

#ifdef __APPLE__
#include <ApplicationServices/ApplicationServices.h>
#include <Security/Security.h>
#include <SystemConfiguration/SystemConfiguration.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

double skfiy_monotonic_time(void) {
    // Includes sleep: a sleeping machine must not extend an authorization.
    mach_timebase_info_data_t info;
    mach_timebase_info(&info);
    return (double)mach_continuous_time() * info.numer / info.denom / 1e9;
}

bool skfiy_console_user(uint32_t *uid) {
    uid_t user = 0;
    CFStringRef name = SCDynamicStoreCopyConsoleUser(NULL, &user, NULL);
    bool valid = name && user >= 501 && !CFEqual(name, CFSTR("loginwindow"));
    if (name) CFRelease(name);
    if (valid && uid) *uid = user;
    return valid;
}

bool skfiy_screen_locked(void) {
    CFDictionaryRef state = CGSessionCopyCurrentDictionary();
    if (!state) return true;
    CFTypeRef locked = CFDictionaryGetValue(state, CFSTR("CGSSessionScreenIsLocked"));
    CFTypeRef console = CFDictionaryGetValue(state, kCGSessionOnConsoleKey);
    bool result = !console || !CFEqual(console, kCFBooleanTrue) ||
                  (locked && CFEqual(locked, kCFBooleanTrue));
    CFRelease(state);
    return result;
}

bool skfiy_screen_confirmed_locked(void) {
    CFDictionaryRef state = CGSessionCopyCurrentDictionary();
    if (!state) return false;
    CFTypeRef locked = CFDictionaryGetValue(state, CFSTR("CGSSessionScreenIsLocked"));
    bool confirmed = locked && CFEqual(locked, kCFBooleanTrue);
    CFRelease(state);
    return confirmed;
}

typedef void (*LockScreen)(void);
static LockScreen lock_function(void) {
    static void *library;
    if (!library) library = dlopen("/System/Library/PrivateFrameworks/login.framework/login", RTLD_LAZY | RTLD_LOCAL);
    return library ? (LockScreen)dlsym(library, "SACLockScreenImmediate") : NULL;
}
bool skfiy_can_lock_screen(void) { return lock_function() != NULL; }
bool skfiy_lock_screen(void) {
    LockScreen lock = lock_function();
    if (!lock) return false;
    lock();
    return true; // The guardian separately verifies the actual session state.
}

static bool safe_root_path(const char *path) {
    char resolved[PATH_MAX];
    if (!realpath(path, resolved) || strcmp(path, resolved) != 0) return false;
    do {
        struct stat st;
        if (lstat(resolved, &st) != 0 || st.st_uid != 0 || (st.st_mode & 022)) return false;
        char *slash = strrchr(resolved, '/');
        if (!slash) return false;
        *slash = 0;
    } while (resolved[0]);
    return true;
}

static CFDataRef code_hash(SecStaticCodeRef code) {
    CFDictionaryRef info = NULL;
    if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) != errSecSuccess) return NULL;
    CFDataRef hash = CFDictionaryGetValue(info, kSecCodeInfoUnique);
    CFNumberRef flags = CFDictionaryGetValue(info, kSecCodeInfoFlags);
    uint32_t bits = 0;
    if (flags) CFNumberGetValue(flags, kCFNumberSInt32Type, &bits);
    // Hardened runtime, no get-task-allow / library-validation exceptions.
    CFDictionaryRef entitlements = CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict);
    bool unsafe = entitlements && CFDictionaryGetCount(entitlements) != 0;
    if (!hash || CFGetTypeID(hash) != CFDataGetTypeID() || !(bits & 0x10000) || unsafe) hash = NULL;
    if (hash) CFRetain(hash);
    CFRelease(info);
    return hash;
}

static SecCodeRef guest_code(pid_t pid) {
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    const void *keys[] = { kSecGuestAttributePid }, *values[] = { number };
    CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1,
                                              &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL;
    SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
    CFRelease(attrs);
    CFRelease(number);
    return code;
}

static SecStaticCodeRef installed_guardian(void) {
    if (!safe_root_path(SKFIY_GUARDIAN)) return NULL;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)SKFIY_GUARDIAN,
                                                        strlen(SKFIY_GUARDIAN), false);
    SecStaticCodeRef code = NULL;
    SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
    CFRelease(url);
    if (code && SecStaticCodeCheckValidity(code, kSecCSStrictValidate, NULL) != errSecSuccess) {
        CFRelease(code);
        code = NULL;
    }
    return code;
}

bool skfiy_guardian_installed(void) {
    SecStaticCodeRef code = installed_guardian();
    CFDataRef hash = code ? code_hash(code) : NULL;
    bool valid = hash != NULL;
    if (hash) CFRelease(hash);
    if (code) CFRelease(code);
    return valid;
}

static bool trusted_guardian(int socket_fd, uid_t uid) {
    uid_t peer_uid; gid_t peer_gid;
    pid_t pid = 0; socklen_t length = sizeof(pid);
    if (getpeereid(socket_fd, &peer_uid, &peer_gid) != 0 || peer_uid != uid ||
        getsockopt(socket_fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) != 0 || pid <= 0) return false;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof(path)) <= 0 || strcmp(path, SKFIY_GUARDIAN) != 0) return false;
    SecStaticCodeRef installed = installed_guardian();
    SecCodeRef running = guest_code(pid);
    SecStaticCodeRef running_static = NULL;
    if (running && SecCodeCheckValidity(running, kSecCSStrictValidate, NULL) == errSecSuccess)
        SecCodeCopyStaticCode(running, kSecCSDefaultFlags, &running_static);
    CFDataRef a = installed ? code_hash(installed) : NULL;
    CFDataRef b = running_static ? code_hash(running_static) : NULL;
    bool valid = a && b && CFEqual(a, b);
    if (a) CFRelease(a);
    if (b) CFRelease(b);
    if (running_static) CFRelease(running_static);
    if (running) CFRelease(running);
    if (installed) CFRelease(installed);
    return valid;
}

bool skfiy_is_loginwindow(int32_t pid) {
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof(path)) <= 0 ||
        strcmp(path, "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow") != 0) return false;
    SecCodeRef code = guest_code(pid);
    SecRequirementRef requirement = NULL;
    SecRequirementCreateWithString(CFSTR("anchor apple and identifier \"com.apple.loginwindow\""),
                                   kSecCSDefaultFlags, &requirement);
    bool valid = code && requirement && SecCodeCheckValidity(code, kSecCSStrictValidate, requirement) == errSecSuccess;
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    return valid;
}

static bool socket_path(uint32_t uid, struct sockaddr_un *address) {
    memset(address, 0, sizeof(*address));
    address->sun_family = AF_UNIX;
    address->sun_len = sizeof(*address);
    int count = snprintf(address->sun_path, sizeof(address->sun_path), "%s/%u/authorize.sock", SKFIY_SOCKET_ROOT, uid);
    return count > 0 && (size_t)count < sizeof(address->sun_path);
}

static int instance_lock = -1;
int skfiy_authorization_listen(uint32_t uid) {
    struct sockaddr_un address;
    if (getuid() != uid || !socket_path(uid, &address)) return -1;
    char directory[128], lockpath[160];
    snprintf(directory, sizeof(directory), "%s/%u", SKFIY_SOCKET_ROOT, uid);
    struct stat st;
    if (!safe_root_path(SKFIY_SOCKET_ROOT) || lstat(directory, &st) != 0 ||
        !S_ISDIR(st.st_mode) || st.st_uid != uid || (st.st_mode & 077)) return -1;
    snprintf(lockpath, sizeof(lockpath), "%s/guardian.lock", directory);
    int lock = open(lockpath, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (lock < 0) return -1;
    if (fstat(lock, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != uid ||
        (st.st_mode & 077) || st.st_nlink != 1) { close(lock); return -1; }
    if (flock(lock, LOCK_EX | LOCK_NB) != 0) { close(lock); return -1; }
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { close(lock); return -1; }
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    fcntl(fd, F_SETFL, O_NONBLOCK);
    unlink(address.sun_path); // Only the instance holding the lock can replace a stale socket.
    mode_t previous = umask(077);
    int result = bind(fd, (struct sockaddr *)&address, sizeof(address));
    umask(previous);
    if (result != 0 || listen(fd, 4) != 0) { close(fd); close(lock); return -1; }
    instance_lock = lock;
    return fd;
}

int skfiy_authorization_accept(int listener) {
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) return -1;
    uid_t uid; gid_t gid;
    if (getpeereid(fd, &uid, &gid) != 0 || uid != 0) { close(fd); return -1; }
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    fcntl(fd, F_SETFL, O_NONBLOCK);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    return fd;
}

void skfiy_authorization_reply(int fd, bool allow) {
    const char answer = allow ? 'Y' : 'N';
    send(fd, &answer, 1, 0);
    close(fd);
}

bool skfiy_authorization_ready(int fd, bool pending) {
    // Most manual unlocks take this fast denial path, without code-signature
    // verification or waiting for any UI/MCP process.
    char ready = pending ? 'R' : 'N';
    if (send(fd, &ready, 1, 0) != 1 || !pending) return false;
    struct pollfd p = { .fd = fd, .events = POLLIN };
    char request = 0;
    return poll(&p, 1, 250) > 0 && (p.revents & POLLIN) &&
           recv(fd, &request, 1, 0) == 1 && request == '?';
}

bool skfiy_authorization_request(uint32_t uid) {
    struct sockaddr_un address;
    if (geteuid() != 0 || !socket_path(uid, &address)) return false;
    struct stat st;
    if (lstat(address.sun_path, &st) != 0 || !S_ISSOCK(st.st_mode) || st.st_uid != uid || (st.st_mode & 077)) return false;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return false;
    fcntl(fd, F_SETFL, O_NONBLOCK);
    bool allowed = false;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
    if (result != 0 && errno != EINPROGRESS) goto done;
    struct pollfd p = { .fd = fd, .events = POLLIN };
    if (poll(&p, 1, 250) <= 0 || !(p.revents & POLLIN)) goto done;
    char answer = 0;
    if (recv(fd, &answer, 1, 0) != 1 || answer != 'R' || !trusted_guardian(fd, uid)) goto done;
    // Perform potentially slow identity checks BEFORE asking for the one-use
    // permit. A expired/revoked grant can no longer be consumed afterwards.
    if (send(fd, "?", 1, 0) != 1 || poll(&p, 1, 250) <= 0 || !(p.revents & POLLIN)) goto done;
    allowed = recv(fd, &answer, 1, 0) == 1 && answer == 'Y';
done:
    close(fd);
    return allowed;
}

void skfiy_authorization_close(int fd, uint32_t uid) {
    if (fd >= 0) close(fd);
    if (instance_lock >= 0) {
        struct sockaddr_un address;
        if (socket_path(uid, &address)) unlink(address.sun_path);
        close(instance_lock);
        instance_lock = -1;
    }
}
#endif
