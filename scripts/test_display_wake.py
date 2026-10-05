#!/usr/bin/env python3
"""Locked with the display off: window capture needs the display on.

    python3 scripts/test_display_wake.py .build/debug/skfiy [--wait 720]

Only while macOS is locked. If the display is still on, waits (up to --wait
seconds) for it to go to sleep by itself; never turns it off. Then:

- with SKFIY_LOCKED_WAKE_DISPLAY=0: get_app_capabilities says the display is
  off and screenshots are unavailable, get_app_state refuses with that
  reason, and the display stays asleep;
- by default: get_app_capabilities says the next capture wakes it,
  get_app_state wakes the display to the lock screen and returns the
  screenshot with the window's text, and the Mac stays locked;
- after skfiy exits, its "prevent display sleep" assertion is gone, so the
  display can go back to sleep.
"""
import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, main_binary, ocr_lines, probe  # noqa: E402


def skfiy_assertions():
    out = subprocess.run(['pmset', '-g', 'assertions'], capture_output=True, text=True).stdout
    return [line.strip() for line in out.splitlines() if 'skfiy direct locked use' in line]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('binary')
    parser.add_argument('--wait', type=float, default=720)
    args = parser.parse_args()
    main_binary()
    state = probe('session')
    if not state['locked']:
        print('skipped: the Mac is not locked (this test is about the locked display)')
        return
    deadline = time.time() + args.wait
    while not probe('session').get('displayAsleep') and time.time() < deadline and probe('session')['locked']:
        time.sleep(10)
    state = probe('session')
    if not state['locked'] or not state.get('displayAsleep'):
        print(f"skipped: display asleep={state.get('displayAsleep')}, locked={state['locked']} after waiting")
        return

    with Session('display-nowake', environment={'SKFIY_LOCKED_WAKE_DISPLAY': '0'}) as s:
        caps = s.call('get_app_capabilities', app=s.app)
        s.check('wake off: capabilities say the display is off, no screenshot', 'SKFIY_LOCKED_WAKE_DISPLAY=0' in caps['text']
                and re.search(r'screenshot[^\n]*(unavailable|no)', caps['text'], re.I), caps['text'][:400])
        refused = s.call('get_app_state', app=s.app)
        s.check('wake off: get_app_state refuses, saying the display is asleep', refused['is_error'] and 'asleep' in refused['text'], refused['text'][:200])
        s.check('wake off: the display is still asleep', probe('session').get('displayAsleep'), probe('session'))

    with Session('display-wake') as s:
        caps = s.call('get_app_capabilities', app=s.app)
        s.check('capabilities say the next capture wakes the display', 'wakes it to the lock screen' in caps['text'], caps['text'][:400])
        state = s.call('get_app_state', app=s.app)
        words = ' '.join(label for label, _, _ in ocr_lines(state['text']))
        s.check('get_app_state wakes the display and captures the window', not state['is_error'] and state['images'] and 'Apply' in words,
                state['text'][:300])
        after = probe('session')
        s.check('the display is on now, the Mac still locked', not after.get('displayAsleep') and after['locked'], after)
        s.check('skfiy holds the display on while it works', bool(skfiy_assertions()), skfiy_assertions())
        s.client.close()  # skfiy exits
        time.sleep(2)
        s.check('after skfiy exits, it no longer holds the display on', not skfiy_assertions(), skfiy_assertions())


if __name__ == '__main__':
    main()
