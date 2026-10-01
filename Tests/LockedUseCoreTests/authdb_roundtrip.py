"""macOS CI: test serialization using temporary, unreferenced authdb rights.

Never changes screensaver/login policy, installs a plugin or authorizes a right.
Only this test's UUID-named rules are written and removed. Requires sudo.
"""
import importlib.util
from pathlib import Path
import sys
import uuid

spec = importlib.util.spec_from_file_location("locked_use", Path(__file__).resolve().parents[2] / "scripts/locked_use.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

if sys.platform != "darwin" or policy.os.geteuid() != 0:
    sys.exit("Run only on macOS as root: sudo python3 Tests/LockedUseCoreTests/authdb_roundtrip.py")

prefix = "io.github.sskift.skfiy.ci." + uuid.uuid4().hex
policy.BRANCH = prefix + ".mechanism"
right = prefix + ".rule"
try:
    policy.write_right(policy.BRANCH, policy.branch_policy())
    original = policy.read_right(policy.RIGHT)  # Read only; never write this name.
    print("Host screensaver policy:", policy.comparable(original), flush=True)
    installed = policy.install_policy(original)
    policy.write_right(right, installed)
    observed = policy.read_right(right)
    restored = policy.uninstall_policy(observed, original, installed)
    policy.write_right(right, restored)
    policy.remove_branch()
    policy.remove_branch()  # Missing branch after a partial install is recoverable.
    print("PASS: mechanism/delegation round-trip, restoration and missing-branch cleanup")
finally:
    for name in [right, policy.BRANCH]:
        try:
            policy.run("/usr/bin/security", "authorizationdb", "remove", name)
        except policy.subprocess.CalledProcessError:
            pass
