#!/usr/bin/env python3
"""Explicit, root-only installation of the experimental macOS unlock branch.

Normal `make install` never calls this. Pure policy helpers are tested on Linux.
No password, authdb SQLite access, login policy, or keychain changes.
"""
import argparse
import copy
import fcntl
import os
from pathlib import Path
import plistlib
import pwd
import shutil
import stat
import subprocess
import sys

RIGHT = "system.login.screensaver"
BRANCH = "io.github.sskift.skfiy.locked-use"
ROOT = Path("/Library/Application Support/skfiy")
APP = ROOT / "LockedUse.app"
PLUGIN = Path("/Library/Security/SecurityAgentPlugins/SkfiyLockedUseAuthorization.bundle")
STATE = ROOT / "locked-use-install.plist"
RUNTIME = ROOT / "locked-use-runtime"
TRANSIENT = {"created", "modified", "version"}


def comparable(rule):
    return {k: v for k, v in rule.items() if k not in TRANSIENT}


def install_policy(original):
    """Preserve normal login-window authentication; refuse custom/MDM policies."""
    if (original.get("class") != "rule" or original.get("rule") != ["use-login-window-ui"]
            or type(original.get("k-of-n")) is not int or original["k-of-n"] != 1):
        raise ValueError("Refusing nonstandard screensaver policy (including other unlock plugins). Restore it through its owner before installing skfiy.")
    result = copy.deepcopy(original)
    result["rule"] = [BRANCH, "use-login-window-ui"]
    # Never turn a temporary authorization into a reusable cached right.
    result["shared"] = False
    result["timeout-right"] = 0
    return result


def uninstall_policy(current, original, installed):
    if comparable(current) != comparable(installed):
        raise ValueError("The screensaver policy changed since installation. Refusing to overwrite newer policy; review the saved backup.")
    return copy.deepcopy(original)


def branch_policy():
    return {"class": "evaluate-mechanisms", "mechanisms": ["SkfiyLockedUseAuthorization:unlock,privileged"],
            "tries": 1, "shared": False, "timeout": 0, "timeout-right": 0,
            "comment": "One-use skfiy desktop grant; deny falls through to the original login-window UI."}


def run(*args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=True, timeout=30).stdout


def read_right(name):
    value = plistlib.loads(run("/usr/bin/security", "authorizationdb", "read", name))
    if not isinstance(value, dict):
        raise ValueError("Authorization database returned an unexpected value")
    return value


def write_right(name, value):
    run("/usr/bin/security", "authorizationdb", "write", name, data=plistlib.dumps(value))
    if comparable(read_right(name)) != comparable(value):
        raise RuntimeError(f"Read-back verification failed for {name}")


def remove_branch():
    try:
        current = read_right(BRANCH)
    except subprocess.CalledProcessError as error:
        # A failure before branch creation still has a recovery backup. Missing
        # rules are the only read error that permits completing the uninstall.
        if b"-60005" in (error.stderr or b""):  # errAuthorizationDenied: right not found
            return
        raise
    if comparable(current) != comparable(branch_policy()):
        raise ValueError("The skfiy branch changed since installation; refusing to delete newer policy")
    run("/usr/bin/security", "authorizationdb", "remove", BRANCH)


def secure_directory(path):
    """Root-owned, non-symlink ancestors; never follow user-writable install paths."""
    if path == Path("/"):
        return
    secure_directory(path.parent)
    try:
        info = path.lstat()
    except FileNotFoundError:
        path.mkdir(mode=0o755)
        info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError(f"Unsafe installation directory: {path}")


def ensure_idle():
    if not RUNTIME.exists():
        return
    for lockpath in RUNTIME.glob("*/guardian.lock"):
        fd = os.open(lockpath, os.O_RDWR | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Stop all mcp --locked-use sessions before changing the installation") from None
        finally:
            os.close(fd)


def save_state(state):
    temporary = STATE.with_suffix(".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(plistlib.dumps(state))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, STATE)
    finally:
        temporary.unlink(missing_ok=True)


def copy_bundle(source, destination):
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f"Missing bundle: {source}; run make locked-use first")
    # Reject symlinks before copying. Verify the copied bundle's signature too.
    if any(p.is_symlink() for p in source.rglob("*")):
        raise ValueError(f"Symlinks are not permitted in {source}")
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"Already exists: {destination}; uninstall first")
    shutil.copytree(source, destination, symlinks=True)
    for path in [destination, *destination.rglob("*")]:
        if path.is_symlink():
            raise ValueError(f"Unexpected symlink after copy: {path}")
        os.chown(path, 0, 0)
        os.chmod(path, 0o755 if path.is_dir() or path.parent.name == "MacOS" else 0o644)
    run("/usr/bin/codesign", "--verify", "--strict", str(destination))


def install(build, uid):
    if uid < 501:
        raise ValueError("Specify the local GUI user's UID (at least 501), never root")
    account = pwd.getpwuid(uid)
    secure_directory(ROOT)
    secure_directory(PLUGIN.parent)
    ensure_idle()
    if STATE.exists() or APP.exists() or PLUGIN.exists():
        raise ValueError("An installation or recovery backup exists; use status / uninstall first")
    original = read_right(RIGHT)
    installed = install_policy(original)
    state = {"original": original, "installed": installed, "uid": uid, "phase": "prepared"}
    # Persist recovery information before changing system policy.
    save_state(state)
    try:
        copy_bundle(build / "LockedUse.app", APP)
        copy_bundle(build / "SkfiyLockedUseAuthorization.bundle", PLUGIN)
        secure_directory(RUNTIME)
        user_directory = RUNTIME / str(uid)
        if user_directory.exists():
            info = user_directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
                raise ValueError("Unsafe existing locked-use runtime directory")
        else:
            user_directory.mkdir(mode=0o700)
            os.chown(user_directory, uid, account.pw_gid)
        write_right(BRANCH, branch_policy())
        write_right(RIGHT, installed)  # Last: only reference the fully installed plugin.
        state["phase"] = "installed"
        save_state(state)
    except Exception:
        current = read_right(RIGHT)
        if comparable(current) == comparable(installed):
            write_right(RIGHT, original)
        elif comparable(current) != comparable(original):
            raise RuntimeError(f"Installation interrupted and policy changed concurrently. Backup retained at {STATE}; do not delete the plugin before restoring the rule.") from None
        # Keep bundles/backup for diagnosis; they are unreachable from the restored policy.
        raise
    print("Experimental locked use installed. Run skfiy mcp --locked-use while unlocked to approve one session.")


def uninstall():
    secure_directory(ROOT)
    ensure_idle()
    if not STATE.exists():
        raise ValueError("No skfiy installation backup; refusing to guess an original system policy")
    if STATE.is_symlink():
        raise ValueError("Unsafe installation state")
    state = plistlib.loads(STATE.read_bytes())
    current = read_right(RIGHT)
    if comparable(current) != comparable(state["original"]):
        restored = uninstall_policy(current, state["original"], state["installed"])
        write_right(RIGHT, restored)
    # Remove the hook before its files; never strand loginwindow with a missing plugin.
    remove_branch()
    for path in [PLUGIN, APP]:
        if path.is_symlink():
            raise ValueError(f"Unsafe installed bundle: {path}")
        if path.exists():
            shutil.rmtree(path)
    archive = STATE.with_suffix(".last-uninstall.plist")
    os.replace(STATE, archive)
    print(f"Original screensaver policy restored. Recovery record retained: {archive}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "uninstall", "status"])
    parser.add_argument("--experimental", action="store_true")
    parser.add_argument("--uid", type=int, default=int(os.environ.get("SUDO_UID", "0")))
    parser.add_argument("--build", type=Path, default=Path(__file__).resolve().parents[1] / ".build/locked-use")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This command is macOS-only; policy tests run on any platform")
    if args.action == "status":
        print(plistlib.dumps(read_right(RIGHT)).decode(), end="")
        print(f"Guardian: {APP.exists()}; plugin: {PLUGIN.exists()}; recovery backup: {STATE.exists()}")
        return
    if os.geteuid() != 0:
        parser.error("Use sudo for this explicit system-component installation/removal")
    if args.action == "install":
        if not args.experimental:
            parser.error("Native unlock is not yet validated on Tahoe 26.6.1; use --experimental on a test Mac")
        install(args.build.resolve(), args.uid)
    else:
        uninstall()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, plistlib.InvalidFileException) as error:
        print(f"locked-use: {error}", file=sys.stderr)
        sys.exit(1)
