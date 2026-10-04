#!/usr/bin/env python3
"""Install/remove skfiy's optional, fail-closed screen-unlock mechanism.

No credentials are read or stored. The system's existing login fallback and
other vendors' mechanisms are preserved. The root installation pins the exact
signed binaries used for local peer verification.
"""

import argparse
import json
import os
from pathlib import Path
import plistlib
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile

RIGHT = "com.skfiy.locked-use.remote"
SCREEN_RIGHT = "system.login.screensaver"
PLUGIN_ROOT = Path("/Library/Security/SecurityAgentPlugins")
PLUGIN = PLUGIN_ROOT / "SkfiyLockedUse.bundle"
STATE = Path("/Library/Application Support/skfiy/locked-use")
MCP = STATE / "skfiy"
GUARDIAN = Path("/Library/PrivilegedHelperTools/com.skfiy.LockedUseGuardian")
SOCKET_ROOT = STATE / "run"
ORIGINAL = STATE / "original-screensaver.plist"
PLUGIN_SIGNING_REQUIREMENT = "anchor apple generic and certificate leaf[subject.OU] exists"


def run(*args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def verify_plugin_signature(path):
    """Reject ad-hoc/local certificates before installing an authorization plugin.

    A valid code hash alone is insufficient for loading into SecurityAgentHelper.
    Require an Apple developer certificate chain with a leaf Team ID. This is a
    prerequisite, not a promise that the OS will accept the plugin at runtime.
    """
    try:
        run("/usr/bin/codesign", "--verify", "--strict", "--all-architectures",
            "-R=" + PLUGIN_SIGNING_REQUIREMENT, str(path))
    except subprocess.CalledProcessError as error:
        raise RuntimeError("Authorization plugin requires a trusted Apple developer signature with a Team ID; "
                           "ad-hoc and local/self-signed certificates are unsupported. No installation or "
                           "authorization-rule changes were made. OS plugin loading still requires a real "
                           "runtime test after signing.") from error


def read_right(name):
    return plistlib.loads(run("/usr/bin/security", "authorizationdb", "read", name))


def write_right(name, value):
    run("/usr/bin/security", "authorizationdb", "write", name, data=plistlib.dumps(value))


def remove_right(name):
    run("/usr/bin/security", "authorizationdb", "remove", name)


def root_directory(path):
    if path.is_symlink():
        raise RuntimeError(f"Refusing symbolic-link installation directory: {path}")
    path.mkdir(parents=False, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"Not a directory: {path}")
    # Existing system parent directories are never chmodded by this helper.
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError(f"Installation directory is not protected by root ownership: {path}")


def fresh_owned_directory(path, uid=0, mode=0o755):
    if path.is_symlink():
        raise RuntimeError(f"Refusing symbolic-link installation directory: {path}")
    if path.exists():
        if not path.is_dir() or path.stat().st_uid not in (0, uid):
            raise RuntimeError(f"Unexpected owner/type at {path}")
    else:
        path.mkdir(mode=mode)
    os.chown(path, uid, 0)
    path.chmod(mode)


def set_root_tree(path):
    for item in [path, *path.rglob("*")]:
        if item.is_symlink():
            raise RuntimeError(f"Unexpected symlink inside artifact: {item}")
        os.chown(item, 0, 0)
        item.chmod(0o755 if item.is_dir() or item.parent.name == "MacOS" else 0o644)


def install_artifact(source, destination):
    staging = destination.with_name(destination.name + ".new")
    if staging.exists() or staging.is_symlink():
        raise RuntimeError(f"Previous staging path exists: {staging}")
    if source.is_dir():
        shutil.copytree(source, staging, symlinks=True)
        set_root_tree(staging)
    else:
        shutil.copy2(source, staging)
        os.chown(staging, 0, 0)
        staging.chmod(0o755)
    run("/usr/bin/codesign", "--verify", "--strict", str(staging))
    if destination == PLUGIN:
        verify_plugin_signature(staging)
    if destination.is_dir():
        shutil.rmtree(destination)
    os.replace(staging, destination)


def install(args):
    uid = args.uid
    if uid is None or uid == 0:
        raise RuntimeError("Specify the logged-in owner's numeric UID with --uid (a non-root account).")
    pwd.getpwuid(uid)
    repo = Path(__file__).resolve().parent.parent
    binary_dir = Path(args.binary_dir).resolve() if args.binary_dir else repo / ".build/release"
    plugin_source = repo / ".build/locked-use/SkfiyLockedUse.bundle"
    sources = [(plugin_source, PLUGIN), (binary_dir / "skfiy", MCP),
               (binary_dir / "skfiy-locked-guardian", GUARDIAN)]
    for source, _ in sources:
        if not source.exists() or source.is_symlink():
            raise RuntimeError(f"Missing/non-regular build artifact: {source}; run locked-use/build.sh first.")
        run("/usr/bin/codesign", "--verify", "--strict", str(source))
    # This gate runs before reading or writing authorization policy, making
    # installation directories, replacing files, or creating backups.
    verify_plugin_signature(plugin_source)
    existing = read_right(SCREEN_RIGHT)
    rules = existing.get("rule")
    if isinstance(rules, str):
        rules = [rules]
    if existing.get("class") != "rule" or not isinstance(rules, list) or existing.get("k-of-n", 1) != 1:
        raise RuntimeError("The existing screen-unlock rule has an unsupported structure; no authorization rules were changed.")
    if not rules or not all(isinstance(rule, str) and rule for rule in rules):
        raise RuntimeError("The existing screen-unlock fallback is invalid; no authorization rules were changed.")
    root_directory(Path("/Library/Application Support"))
    root_directory(Path("/Library/Security"))
    root_directory(Path("/Library/PrivilegedHelperTools"))
    fresh_owned_directory(STATE.parent)
    fresh_owned_directory(STATE)
    fresh_owned_directory(PLUGIN_ROOT)
    fresh_owned_directory(SOCKET_ROOT)
    fresh_owned_directory(SOCKET_ROOT / str(uid), uid, 0o711)
    if not ORIGINAL.exists():
        ORIGINAL.write_bytes(plistlib.dumps(existing))
        ORIGINAL.chmod(0o600)
    backup_dir = Path(tempfile.mkdtemp(prefix="install-backup-", dir=STATE))
    backup_dir.chmod(0o700)
    backups = {}
    for _, destination in sources:
        if destination.exists():
            backup = backup_dir / destination.name
            if destination.is_dir():
                shutil.copytree(destination, backup)
            else:
                shutil.copy2(destination, backup)
            backups[destination] = backup
    try:
        old_custom = read_right(RIGHT)
    except subprocess.CalledProcessError:
        old_custom = None
    rollback_errors = []
    try:
        for source, destination in sources:
            install_artifact(source, destination)
        remote = {
            "class": "evaluate-mechanisms",
            "comment": "Ask the pinned skfiy guardian for a one-use authorization during an active protected computer-use operation.",
            "identifier": "com.apple.security",
            "requirement": 'identifier "com.apple.security" and anchor apple',
            "mechanisms": ["SkfiyLockedUse:remote"],
            "shared": False,
            "tries": 1,
            "version": 1,
        }
        write_right(RIGHT, remote)
        updated = dict(existing)
        updated["rule"] = [RIGHT, *(rule for rule in rules if rule != RIGHT)]
        updated["k-of-n"] = 1
        write_right(SCREEN_RIGHT, updated)
        verified = read_right(SCREEN_RIGHT)
        if verified.get("rule") != updated["rule"] or verified.get("k-of-n") != 1:
            raise RuntimeError("Authorization rule verification failed")
        manifest = {"uid": uid, "plugin": str(PLUGIN), "guardian": str(GUARDIAN), "mcp": str(MCP), "version": 1}
        (STATE / "installation.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (STATE / "installation.json").chmod(0o644)
    except BaseException as original_error:
        try:
            write_right(SCREEN_RIGHT, existing)
        except Exception as error:
            rollback_errors.append(f"screen-unlock rule: {error}")
        try:
            if old_custom is not None:
                write_right(RIGHT, old_custom)
            else:
                remove_right(RIGHT)
        except Exception as error:
            rollback_errors.append(f"skfiy rule: {error}")
        for _, destination in sources:
            try:
                if destination.is_dir():
                    shutil.rmtree(destination)
                elif destination.exists():
                    destination.unlink()
                if destination in backups:
                    # Copy, retaining the backup if another rollback step fails.
                    if backups[destination].is_dir():
                        shutil.copytree(backups[destination], destination)
                    else:
                        shutil.copy2(backups[destination], destination)
                staging = destination.with_name(destination.name + ".new")
                if staging.is_dir() and not staging.is_symlink():
                    shutil.rmtree(staging)
                elif staging.exists() or staging.is_symlink():
                    staging.unlink()
            except Exception as error:
                rollback_errors.append(f"{destination}: {error}")
        if rollback_errors:
            raise RuntimeError(f"Install failed ({original_error}); rollback incomplete; backup retained at {backup_dir}: "
                               + "; ".join(rollback_errors)) from original_error
        raise
    finally:
        if not rollback_errors:
            shutil.rmtree(backup_dir, ignore_errors=True)
    print(json.dumps({"installed": True, "uid": uid, "authorization_rules": updated["rule"],
                      "mcp": str(MCP), "guardian": str(GUARDIAN)}, indent=2))


def uninstall(_args):
    existing = read_right(SCREEN_RIGHT)
    rules = existing.get("rule")
    if isinstance(rules, str):
        rules = [rules]
    if isinstance(rules, list) and RIGHT in rules:
        kept = [rule for rule in rules if rule != RIGHT]
        if not kept:
            raise RuntimeError("Refusing to remove the last unlock rule; the saved fallback needs manual review.")
        updated = dict(existing)
        updated["rule"] = kept
        write_right(SCREEN_RIGHT, updated)
        if read_right(SCREEN_RIGHT).get("rule") != kept:
            raise RuntimeError("Unlock-rule removal did not verify; installed artifacts were retained.")
    try:
        remove_right(RIGHT)
    except subprocess.CalledProcessError:
        pass
    for path in (PLUGIN, GUARDIAN, MCP, STATE / "installation.json"):
        if path.is_symlink():
            raise RuntimeError(f"Unexpected installed symbolic link: {path}")
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    # Keep the original rule backup and sockets of any running guardian. The
    # caller must stop active locked-use sessions before removing the helper.
    print(json.dumps({"uninstalled": True, "authorization_rules": read_right(SCREEN_RIGHT).get("rule"),
                      "original_backup_retained": str(ORIGINAL)}, indent=2))


def status(_args):
    current = read_right(SCREEN_RIGHT)
    rules = current.get("rule", [])
    print(json.dumps({"installed": RIGHT in rules, "authorization_rules": rules,
                      "plugin_exists": PLUGIN.exists(), "guardian_exists": GUARDIAN.exists(),
                      "mcp_exists": MCP.exists()}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    install_parser = sub.add_parser("install")
    install_parser.add_argument("--uid", type=int, default=int(os.environ["SUDO_UID"]) if "SUDO_UID" in os.environ else None)
    install_parser.add_argument("--binary-dir")
    sub.add_parser("uninstall")
    sub.add_parser("status")
    args = parser.parse_args()
    if args.command != "status" and os.geteuid() != 0:
        parser.error("Install/uninstall requires administrator execution (sudo); status is read-only.")
    try:
        {"install": install, "uninstall": uninstall, "status": status}[args.command](args)
    except (RuntimeError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"locked-use: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode(errors="replace").strip(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
