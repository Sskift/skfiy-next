#!/usr/bin/env python3
"""Waits until the Mac is really locked (by its user; this never locks or
unlocks it), then runs the locked-mode test suites listed in
scripts/locked_suites.txt, one command per line, with {bin} replaced by a
snapshot of the given skfiy binary. Stops starting suites once the Mac is
unlocked again.

    python3 scripts/run_when_locked.py .build/debug/skfiy [--settle 20] [--once]

Results: each suite writes its own evidence under eval/results; this script
appends one JSON line per suite to eval/results/locked-runs.jsonl.
"""
import argparse
import fcntl
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
PROBE = Path('/tmp/skfiy-compat/bin/AXProbe')
SUITE_LOCK = Path('/tmp/skfiy-compat/suite.lock')


def one_at_a_time():
    """The locked and unlocked runners share Chrome for Testing and the test
    apps: only one suite runs at a time."""
    SUITE_LOCK.parent.mkdir(parents=True, exist_ok=True)
    handle = SUITE_LOCK.open('w')
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def session():
    if not PROBE.exists():
        PROBE.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['/usr/bin/swiftc', '-O', str(ROOT / 'scripts/fixtures/AXProbe.swift'), '-o', str(PROBE)], check=True)
    return json.loads(subprocess.run([str(PROBE), 'session'], capture_output=True, text=True, timeout=10).stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--settle', type=float, default=20, help='seconds the Mac must stay locked first')
    parser.add_argument('--once', action='store_true', help='exit after one locked period')
    args = parser.parse_args()
    log = ROOT / 'eval/results/locked-runs.jsonl'
    log.parent.mkdir(parents=True, exist_ok=True)
    print('waiting for the Mac to be locked', flush=True)
    while True:
        locked_since = None
        while True:
            state = session()
            if state['known'] and state['locked']:
                locked_since = locked_since or time.time()
                if time.time() - locked_since >= args.settle:
                    break
            else:
                locked_since = None
            time.sleep(5)
        snapshot = Path('/tmp/skfiy-compat/bin/skfiy-locked-run')
        snapshot.unlink(missing_ok=True)
        shutil.copy2(args.binary, snapshot)
        suites = [line.strip() for line in (ROOT / 'scripts/locked_suites.txt').read_text().splitlines()
                  if line.strip() and not line.startswith('#')]
        print(f'locked: running {len(suites)} suite(s)', flush=True)
        for command in suites:
            if not session()['locked']:
                print('unlocked: remaining suites not started', flush=True)
                break
            with one_at_a_time():
                if not session()['locked']:
                    print('unlocked: remaining suites not started', flush=True)
                    break
                started = time.time()
                completed = subprocess.run(command.replace('{bin}', str(snapshot)), shell=True, cwd=ROOT,
                                           capture_output=True, text=True, timeout=1800)
            row = {'command': command, 'started': started, 'seconds': round(time.time() - started, 1),
                   'exit': completed.returncode, 'lockedAtEnd': session()['locked'],
                   'tail': (completed.stdout + completed.stderr)[-3000:]}
            with log.open('a') as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + '\n')
            print(f"{row['exit']:>3} {row['seconds']:>6}s {command}", flush=True)
        if args.once:
            return
        while session()['locked']:
            time.sleep(10)
        print('unlocked; waiting for the next lock', flush=True)


if __name__ == '__main__':
    sys.exit(main())
