"""Exercise authorization-rule preservation and failure rollback without sudo."""
import contextlib
import copy
import importlib.util
import io
import pathlib
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parent / "install.py"
spec = importlib.util.spec_from_file_location("locked_use_install", SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.repo = root / "repo"
        self.binary_dir = self.repo / ".build/release"
        self.binary_dir.mkdir(parents=True)
        (self.binary_dir / "skfiy").write_text("new main")
        (self.binary_dir / "skfiy-locked-guardian").write_text("new guardian")
        plugin = self.repo / ".build/locked-use/SkfiyLockedUse.bundle"
        plugin.mkdir(parents=True)
        (plugin / "Info.plist").write_text("plugin")
        state = root / "state"
        self.paths = {"STATE": state, "MCP": state / "skfiy", "ORIGINAL": state / "original-screensaver.plist",
                      "PLUGIN_ROOT": root / "plugins", "PLUGIN": root / "plugins/SkfiyLockedUse.bundle",
                      "GUARDIAN": root / "helper", "SOCKET_ROOT": root / "sockets",
                      "__file__": str(self.repo / "locked-use/install.py")}
        self.original = {"class": "rule", "k-of-n": 1,
                         "rule": ["com.openai.sky.CUAService.AuthorizationPlugin.remote", "use-login-window-ui"],
                         "comment": "original policy", "version": 1}
        self.rights = {installer.SCREEN_RIGHT: copy.deepcopy(self.original)}
        self.patches = [patch.multiple(installer, **self.paths),
                        patch.object(installer, "root_directory"),
                        patch.object(installer, "fresh_owned_directory", side_effect=self.make_test_directory),
                        patch.object(installer, "set_root_tree"),
                        patch.object(installer.os, "chown"),
                        patch.object(installer, "run", return_value=b""),
                        patch.object(installer, "read_right", side_effect=self.read),
                        patch.object(installer, "write_right", side_effect=self.write),
                        patch.object(installer, "remove_right", side_effect=lambda key: self.rights.pop(key, None)),
                        patch.object(installer.pwd, "getpwuid")]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.args = types.SimpleNamespace(uid=501, binary_dir=str(self.binary_dir))

    def make_test_directory(self, path, *_):
        self.assertTrue(str(path).startswith(self.temp.name + "/") or str(path) == self.temp.name)
        path.mkdir(parents=True, exist_ok=True)

    def read(self, name):
        if name not in self.rights:
            raise subprocess.CalledProcessError(1, "security", stderr=b"not found")
        return copy.deepcopy(self.rights[name])

    def write(self, name, value):
        self.rights[name] = copy.deepcopy(value)

    def install(self):
        with contextlib.redirect_stdout(io.StringIO()):
            installer.install(self.args)

    def test_install_and_uninstall_preserve_other_vendor_and_fallback(self):
        self.install()
        self.assertEqual(self.rights[installer.SCREEN_RIGHT]["rule"], [installer.RIGHT, *self.original["rule"]])
        self.assertFalse(self.rights[installer.RIGHT]["shared"])
        with contextlib.redirect_stdout(io.StringIO()):
            installer.uninstall(self.args)
        self.assertEqual(self.rights[installer.SCREEN_RIGHT], self.original)
        self.assertNotIn(installer.RIGHT, self.rights)
        self.assertTrue(installer.ORIGINAL.exists())

    def test_reinstall_is_idempotent_and_keeps_first_backup(self):
        self.install()
        backup = installer.ORIGINAL.read_bytes()
        self.install()
        self.assertEqual(self.rights[installer.SCREEN_RIGHT]["rule"].count(installer.RIGHT), 1)
        self.assertEqual(installer.ORIGINAL.read_bytes(), backup)

    def test_rule_failure_restores_binaries_and_authorization(self):
        installer.STATE.mkdir(parents=True)
        installer.MCP.write_text("old main")
        installer.GUARDIAN.write_text("old guardian")
        fail_once = True

        def failing_write(name, value):
            nonlocal fail_once
            self.write(name, value)
            if name == installer.SCREEN_RIGHT and fail_once:
                fail_once = False
                raise RuntimeError("simulated write verification failure")

        with patch.object(installer, "write_right", side_effect=failing_write):
            with self.assertRaisesRegex(RuntimeError, "simulated"):
                self.install()
        self.assertEqual(self.rights[installer.SCREEN_RIGHT], self.original)
        self.assertNotIn(installer.RIGHT, self.rights)
        self.assertEqual(installer.MCP.read_text(), "old main")
        self.assertEqual(installer.GUARDIAN.read_text(), "old guardian")

    def test_unsupported_policy_is_not_modified(self):
        self.rights[installer.SCREEN_RIGHT]["k-of-n"] = 2
        before = copy.deepcopy(self.rights)
        with self.assertRaisesRegex(RuntimeError, "unsupported structure"):
            self.install()
        self.assertEqual(self.rights, before)
        self.assertFalse(installer.MCP.exists())

    def test_adhoc_plugin_rejected_before_any_policy_or_file_change(self):
        def files():
            return {
                str(path.relative_to(self.temp.name)): (path.stat().st_mode, None if path.is_dir() else path.read_bytes())
                for path in pathlib.Path(self.temp.name).rglob("*")
            }

        def reject_adhoc(*args, **_kwargs):
            if "-R=" + installer.PLUGIN_SIGNING_REQUIREMENT in args:
                self.assertIn("--all-architectures", args)
                raise subprocess.CalledProcessError(3, args, stderr=b"code failed to satisfy specified code requirements")
            return b""

        for already_installed in (False, True):
            with self.subTest(already_installed=already_installed):
                if already_installed:
                    installer.STATE.mkdir(parents=True)
                    installer.MCP.write_text("existing main")
                    installer.GUARDIAN.write_text("existing guardian")
                    installer.PLUGIN.mkdir(parents=True)
                    (installer.PLUGIN / "Info.plist").write_text("existing plugin")
                    self.rights[installer.RIGHT] = {"class": "evaluate-mechanisms", "mechanisms": ["existing:remote"]}
                before_files = files()
                before_rules = copy.deepcopy(self.rights)
                with patch.object(installer, "run", side_effect=reject_adhoc), \
                        patch.object(installer, "read_right") as read, \
                        patch.object(installer, "write_right") as write, \
                        patch.object(installer, "remove_right") as remove, \
                        patch.object(installer, "root_directory") as root_directory, \
                        patch.object(installer, "fresh_owned_directory") as fresh_directory:
                    with self.assertRaisesRegex(RuntimeError, "trusted Apple developer signature"):
                        self.install()
                    for action in (read, write, remove, root_directory, fresh_directory):
                        action.assert_not_called()
                self.assertEqual(self.rights, before_rules)
                self.assertEqual(files(), before_files)


if __name__ == "__main__":
    unittest.main()
