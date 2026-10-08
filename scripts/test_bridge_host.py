#!/usr/bin/env python3
"""Browser bridge host check, without a browser: when the extension
reconnects, Chrome starts the next native host for the same browser before
the old one has exited. The old host must leave the new one's socket in
place; otherwise skfiy no longer finds a browser whose extension believes it
is connected, and it never reconnects.

    python3 scripts/test_bridge_host.py [path/to/skfiy]
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import wait_until  # noqa: E402

BINARY = sys.argv[1] if len(sys.argv) > 1 else '.build/debug/skfiy'
# Sockets are named after the host's parent, the browser; here that is us.
SOCKET = os.path.expanduser(f'~/Library/Application Support/skfiy/browsers/{os.getpid()}.sock')


def start_host():
    host = subprocess.Popen([BINARY, 'chrome-extension://bridge-host-test/'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
    hello = json.dumps({'event': 'hello', 'browser': 'bridge host test'}).encode()
    host.stdin.write(struct.pack('<I', len(hello)) + hello)
    host.stdin.flush()
    return host


def inode():
    try:
        return os.stat(SOCKET).st_ino
    except FileNotFoundError:
        return None


def main():
    old = start_host()
    new = None
    try:
        if not wait_until(inode, timeout=5, interval=0.05):
            sys.exit('FAIL: the first host never listened')
        first = inode()
        new = start_host()
        if not wait_until(lambda: inode() not in (None, first), timeout=5, interval=0.05):
            sys.exit('FAIL: the second host never listened')
        second = inode()
        old.stdin.close()
        old.wait(5)
        time.sleep(0.2)
        kept = inode() == second and new.poll() is None
        print(f"{'PASS' if kept else 'FAIL'}: the old host exiting {'kept' if kept else 'removed'} the new host's socket")
        new.stdin.close()
        new.wait(5)
        gone = wait_until(lambda: inode() is None, timeout=2, interval=0.05)
        print(f"{'PASS' if gone else 'FAIL'}: the last host exiting {'removed' if gone else 'left'} its socket")
        sys.exit(0 if kept and gone else 1)
    finally:
        for host in (old, new):
            if host and host.poll() is None:
                host.kill()


if __name__ == '__main__':
    main()
