#!/usr/bin/env python3
"""Runs the unlocked (background) test suites listed in
scripts/unlocked_suites.txt once the Mac is unlocked and the user has been
idle for a while, one suite at a time, waiting again whenever the user is
active. Never locks, unlocks or brings anything forward itself.

    python3 scripts/run_when_unlocked.py .build/debug/skfiy [--idle 90]

Results: each suite writes its evidence under eval/results; one JSON line per
suite is appended to eval/results/unlocked-runs.jsonl.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_when_locked import ROOT, one_at_a_time, session  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--idle', type=float, default=90, help='seconds without user input before each suite')
    args = parser.parse_args()
    log = ROOT / 'eval/results/unlocked-runs.jsonl'
    snapshot = Path('/tmp/skfiy-compat/bin/skfiy-unlocked-run')
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.unlink(missing_ok=True)
    shutil.copy2(args.binary, snapshot)
    suites = [line.strip() for line in (ROOT / 'scripts/unlocked_suites.txt').read_text().splitlines()
              if line.strip() and not line.startswith('#')]
    print(f'{len(suites)} suite(s); waiting for an unlocked, idle Mac', flush=True)
    for command in suites:
        while True:
            state = session()
            if state['known'] and not state['locked'] and state['idleSeconds'] >= args.idle:
                with one_at_a_time():
                    state = session()
                    if state['known'] and not state['locked'] and state['idleSeconds'] >= args.idle:
                        started = time.time()
                        completed = subprocess.run(command.replace('{bin}', str(snapshot)), shell=True, cwd=ROOT,
                                                   capture_output=True, text=True, timeout=1800)
                        break
            time.sleep(10)
        after = session()
        row = {'command': command, 'started': started, 'seconds': round(time.time() - started, 1), 'exit': completed.returncode,
               'lockedAtEnd': after['locked'], 'userIdleAtEnd': after['idleSeconds'], 'tail': (completed.stdout + completed.stderr)[-3000:]}
        with log.open('a') as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(f"{row['exit']:>3} {row['seconds']:>6}s {command}", flush=True)


if __name__ == '__main__':
    sys.exit(main())
