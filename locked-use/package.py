#!/usr/bin/env python3
"""Build a local Installer package without requiring root or accessing authdb.

The package carries its own installer and signed build artifacts. Installer
extracts these scripts outside Desktop before running them as administrator,
so the privileged installer never needs access to the source checkout.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tempfile
import time

from install import verify_plugin_signature


def run(*args):
    subprocess.run(args, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uid", type=int, default=os.getuid(),
                        help="Logged-in owner UID; fixed in the resulting package")
    parser.add_argument("--output", type=Path,
                        help="Package path (default: /Users/Shared/skfiy-locked-use-UID.pkg)")
    parser.add_argument("--uninstall", action="store_true",
                        help="Build a removal package without requiring signed build artifacts")
    args = parser.parse_args()
    if not args.uninstall and args.uid <= 0:
        parser.error("--uid must identify a non-root account")
    if not args.uninstall:
        pwd.getpwuid(args.uid)
    default_name = "skfiy-locked-use-uninstall.pkg" if args.uninstall else f"skfiy-locked-use-{args.uid}.pkg"
    output = (args.output or Path("/Users/Shared") / default_name).absolute()
    if output.suffix != ".pkg":
        parser.error("--output must end with .pkg")
    if output.exists() or output.is_symlink():
        parser.error(f"Refusing to replace existing package: {output}")
    repo = Path(__file__).resolve().parent.parent
    sources = [] if args.uninstall else [
        (repo / ".build/release/skfiy", Path(".build/release/skfiy")),
        (repo / ".build/release/skfiy-locked-guardian", Path(".build/release/skfiy-locked-guardian")),
        (repo / ".build/locked-use/SkfiyLockedUse.bundle", Path(".build/locked-use/SkfiyLockedUse.bundle")),
    ]
    for source, _ in sources:
        if not source.exists():
            parser.error(f"Missing artifact {source}; run locked-use/build.sh first")
        run("/usr/bin/codesign", "--verify", "--strict", str(source))
    if not args.uninstall:
        try:
            verify_plugin_signature(repo / ".build/locked-use/SkfiyLockedUse.bundle")
        except RuntimeError as error:
            parser.error(str(error))
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="skfiy-installer-package-") as temporary:
        staging = Path(temporary)
        scripts = staging / "scripts"
        artifacts = scripts / "artifacts"
        (artifacts / "locked-use").mkdir(parents=True)
        shutil.copy2(repo / "locked-use/install.py", artifacts / "locked-use/install.py")
        for source, relative in sources:
            destination = artifacts / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
            run("/usr/bin/codesign", "--verify", "--strict", str(destination))
        if not args.uninstall:
            verify_plugin_signature(artifacts / ".build/locked-use/SkfiyLockedUse.bundle")

        # Preserve install.py's repository-relative artifact layout. Installer
        # places scripts and resources in a private temporary directory; $0
        # must be used rather than the source checkout or the user's cwd.
        postinstall = scripts / "postinstall"
        command = "uninstall" if args.uninstall else f"install --uid {args.uid}"
        postinstall.write_text("""#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 022
if [[ "${3:-/}" != "/" ]]; then
  printf '%s\\n' 'skfiy locked use must be installed on the current startup volume.' >&2
  exit 1
fi
package_scripts="$(cd "$(dirname "$0")" && pwd)"
cd "$package_scripts/artifacts"
exec /usr/bin/python3 -I "$package_scripts/artifacts/locked-use/install.py" """
                               + command + "\n")
        postinstall.chmod(0o755)
        hashes = {
            str(item.relative_to(artifacts)): hashlib.sha256(item.read_bytes()).hexdigest()
            for item in sorted(artifacts.rglob("*")) if item.is_file()
        }
        manifest = {"uid": None if args.uninstall else args.uid,
                    "operation": "uninstall" if args.uninstall else "install",
                    "files": hashes, "version": f"1.0.{int(time.time())}"}
        (scripts / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        run("/bin/bash", "-n", str(postinstall))
        run("/usr/bin/pkgbuild", "--nopayload", "--scripts", str(scripts),
            "--identifier", "com.skfiy.locked-use.uninstall" if args.uninstall else "com.skfiy.locked-use.local",
            "--version", manifest["version"],
            str(output))

        # Validate the actual completed archive, not just the input directory.
        expanded = staging / "expanded"
        run("/usr/sbin/pkgutil", "--expand-full", str(output), str(expanded))
        archived_scripts = expanded / "Scripts"
        archived_artifacts = archived_scripts / "artifacts"
        if (archived_scripts / "postinstall").read_bytes() != postinstall.read_bytes():
            raise RuntimeError("Package postinstall differs from the validated script")
        for relative, expected in hashes.items():
            if hashlib.sha256((archived_artifacts / relative).read_bytes()).hexdigest() != expected:
                raise RuntimeError(f"Package artifact differs from source: {relative}")
        for _, relative in sources:
            run("/usr/bin/codesign", "--verify", "--strict", str(archived_artifacts / relative))
        if not args.uninstall:
            verify_plugin_signature(archived_artifacts / ".build/locked-use/SkfiyLockedUse.bundle")
        manifest["package"] = str(output)
        manifest["package_sha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
        manifest["expanded_archive_verified"] = True
        manifest_path = output.with_suffix(".manifest.json")
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"package": str(output), "manifest": str(manifest_path),
                          "uid": manifest["uid"], "operation": manifest["operation"],
                          "verified": True}, indent=2))


if __name__ == "__main__":
    main()
