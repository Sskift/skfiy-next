import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import subprocess
import tempfile
import types

path = Path(__file__).resolve().parents[2] / "scripts/locked_use.py"
spec = importlib.util.spec_from_file_location("locked_use", path)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.original = {"class": "rule", "rule": ["use-login-window-ui"], "k-of-n": 1,
                         "comment": "retain me", "created": 10, "modified": 20, "shared": True}

    def test_round_trip_preserves_complete_original(self):
        before = copy.deepcopy(self.original)
        installed = policy.install_policy(self.original)
        self.assertEqual(self.original, before)
        self.assertEqual(installed["rule"], [policy.BRANCH, "use-login-window-ui"])
        self.assertEqual(installed["shared"], before["shared"])
        self.assertNotIn("timeout-right", installed)
        self.assertEqual(installed["comment"], "retain me")
        current = dict(installed, modified=30, version=2)
        self.assertEqual(policy.uninstall_policy(current, before, installed), before)

    def test_refuses_unknown_policies(self):
        changes = [{"class": "allow"}, {"rule": []}, {"rule": ["allow"]},
                   {"rule": ["other-plugin", "use-login-window-ui"]}, {"k-of-n": 0},
                   {"k-of-n": True}, {"class": "user"}, {"rule": "use-login-window-ui"}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                policy.install_policy(dict(self.original, **change))

    def test_does_not_overwrite_subsequent_admin_changes(self):
        installed = policy.install_policy(self.original)
        for change in [{"rule": [policy.BRANCH, "mdm-rule"]}, {"k-of-n": 2}, {"timeout": 300}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                policy.uninstall_policy(dict(installed, **change), self.original, installed)

    def test_branch_does_not_cache_or_replace_password_mechanisms(self):
        rule = policy.branch_policy()
        self.assertEqual(rule["tries"], 1)
        self.assertNotIn("timeout-right", rule)
        self.assertNotIn("timeout", rule)
        self.assertTrue(rule["require-apple-signed"])
        self.assertFalse(rule["shared"])
        self.assertEqual(rule["mechanisms"], ["SkfiyLockedUseAuthorization:unlock,privileged"])


class TransactionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name, value in {"ROOT": root, "APP": root / "app", "PLUGIN": root / "plugin",
                            "STATE": root / "state.plist", "RUNTIME": root / "runtime"}.items():
            mock = patch.object(policy, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        self.original = {"class": "rule", "rule": ["use-login-window-ui"], "k-of-n": 1}
        self.rules = {policy.RIGHT: copy.deepcopy(self.original)}

        def read(name):
            if name not in self.rules:
                raise subprocess.CalledProcessError(1, "security", stderr=b"NO (-60005)")
            return copy.deepcopy(self.rules[name])

        def write(name, value):
            self.rules[name] = copy.deepcopy(value)

        def run(*args, **kwargs):
            self.assertEqual(args[:3], ("/usr/bin/security", "authorizationdb", "remove"))
            self.rules.pop(args[3])

        for name, implementation in {
            "read_right": read, "write_right": write, "run": run,
            "secure_directory": lambda p: p.mkdir(exist_ok=True, parents=True),
            "copy_bundle": lambda src, dst: dst.mkdir(),
        }.items():
            mock = patch.object(policy, name, side_effect=implementation)
            mock.start()
            self.addCleanup(mock.stop)
        for target, kwargs in [("pwd.getpwuid", {"return_value": types.SimpleNamespace(pw_gid=20)}),
                               ("os.chown", {})]:
            mock = patch.object(policy.pwd if target.startswith("pwd") else policy.os, target.split(".")[1], **kwargs)
            mock.start()
            self.addCleanup(mock.stop)

    def test_uninstall_after_failure_before_branch_exists(self):
        with patch.object(policy, "copy_bundle", side_effect=OSError("copy failed")):
            with self.assertRaises(OSError):
                policy.install(Path("build"), 501)
        self.assertTrue(policy.STATE.exists())
        self.assertEqual(self.rules[policy.RIGHT], self.original)
        policy.uninstall()
        self.assertFalse(policy.STATE.exists())

    def test_failure_after_hook_write_restores_original_before_cleanup(self):
        original_save = policy.save_state

        def fail_final_save(state):
            if state["phase"] == "installed":
                raise OSError("disk full")
            original_save(state)

        with patch.object(policy, "save_state", side_effect=fail_final_save):
            with self.assertRaises(OSError):
                policy.install(Path("build"), 501)
        self.assertEqual(self.rules[policy.RIGHT], self.original)
        self.assertTrue(policy.PLUGIN.exists())
        policy.uninstall()
        self.assertNotIn(policy.BRANCH, self.rules)

    def test_admin_change_keeps_files_and_recovery_backup(self):
        policy.install(Path("build"), 501)
        self.rules[policy.RIGHT]["rule"].append("mdm-rule")
        with self.assertRaises(ValueError):
            policy.uninstall()
        self.assertTrue(policy.STATE.exists())
        self.assertTrue(policy.PLUGIN.exists())

    def test_complete_install_uninstall(self):
        policy.install(Path("build"), 501)
        self.assertEqual(self.rules[policy.RIGHT]["rule"][0], policy.BRANCH)
        policy.uninstall()
        self.assertEqual(self.rules, {policy.RIGHT: self.original})
        self.assertFalse(policy.APP.exists())
        self.assertFalse(policy.PLUGIN.exists())


if __name__ == "__main__":
    unittest.main()
