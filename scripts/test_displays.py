#!/usr/bin/env python3
"""Several displays, for real: temporary virtual displays beside the built-in
one (scripts/fixtures/VirtualDisplay.swift), with the scenario app's window
moved between them.

    python3 scripts/test_displays.py .build/debug/skfiy [--allow-unlocked]

Only while nobody is there: a new display changes the space the user's
pointer and windows live in. While macOS is locked the helper removes the
display at once if the Mac is unlocked; with --allow-unlocked it also runs
unlocked after 5 minutes without keyboard, mouse or trackpad input when no
app keeps the display awake, and removes the display at the first input. Each display goes away when its helper exits,
and macOS moves its windows back.

Screenshots are one pixel per point everywhere; zoom and OCR use each
display's own detail, which zoom reports.

- A 1× display left of the main one (negative x), made before skfiy starts:
  OCR coordinates click a button, a 10×10 pt target is hit from screenshot
  and from zoom coordinates, and zoom at 2× says it is beyond the display's
  1× detail.
- A Retina display right of the main one, made while skfiy runs: moving the
  window there makes old coordinates refused; a fresh screenshot hits the
  target, and zoom at 2× is the display's full detail.
- A window across two displays: the part on the other display is in the
  screenshot (while locked) and can be clicked.
- The display under the window removed (unplugged): old coordinates refused,
  a fresh screenshot finds the window where macOS put it.
"""
import argparse
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, canvas_target, geometry, main_binary, ocr_lines, probe, to_pixels, tool, wait_until  # noqa: E402


class VirtualDisplay:
    def __init__(self, side, hidpi=False, allow_unlocked=False):
        command = [str(tool('VirtualDisplay')), '--side', side] + (['--hidpi'] if hidpi else []) + (['--allow-unlocked'] if allow_unlocked else [])
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = []
        reader = threading.Thread(target=lambda: line.append(self.process.stdout.readline()), daemon=True)
        reader.start()
        reader.join(timeout=20)
        if not line or not line[0].strip():
            self.close()
            raise RuntimeError(f'no virtual display: {self.process.stderr.read()[:300] if self.process.poll() is not None else "timed out"}')
        self.info = json.loads(line[0])
        self.frame = self.info['display']

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


def window_frame(s):
    """The main window's frame as the window server has it (the app itself
    can hear late that its window was moved off a removed display)."""
    number = s.fixture.state()['windows'][0]['number']
    return next((w for w in probe('windows', s.fixture.pid)['windows'] if w['id'] == number), None)


def on(display, frame):
    center = (frame['x'] + frame['width'] / 2, frame['y'] + frame['height'] / 2)
    return display['x'] <= center[0] < display['x'] + display['width'] and display['y'] <= center[1] < display['y'] + display['height']


def place(s, x, y):
    s.fixture.command('place', x=x, y=y)
    placed = s.fixture.wait(lambda st: abs(st['windows'][0]['frame']['x'] - x) < 1 and abs(st['windows'][0]['frame']['y'] - y) < 1, timeout=4)
    time.sleep(0.6)  # the window server's list catches up
    return placed


def counter(s, name):
    return s.fixture.state()['counters'].get(name, 0)


def click_counts(s, name, **arguments):
    before = counter(s, name)
    result = s.call('click', app=s.app, **arguments)
    return result, s.fixture.wait(lambda st: st['counters'].get(name, 0) > before, timeout=4)


def target_pixels(s, g):
    """The red target's centre in pixels of screenshot g, to 0.1 px."""
    x, y = to_pixels(g, canvas_target(s.fixture.state()['canvas']))
    return round(x, 1), round(y, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('binary')
    parser.add_argument('--allow-unlocked', action='store_true')
    args = parser.parse_args()
    main_binary(args.binary)
    state = probe('session')
    if not state['locked'] and not args.allow_unlocked:
        print('skipped: the Mac is not locked (a virtual display would change the user\'s screen space; see --allow-unlocked)')
        return
    if not state['locked'] and state.get('displayAsleep'):
        print('skipped: unlocked with the display asleep (skfiy rightly does not wake it, so nothing can be captured)')
        return
    original = probe('displays')['displays']
    try:
        left = VirtualDisplay('left', allow_unlocked=args.allow_unlocked)
    except RuntimeError as error:
        if 'refused' not in str(error):
            raise
        print(f'skipped: {error}')
        return
    right = None
    try:
        with Session('displays') as s:
            app = s.app
            a = left.frame
            s.check('a 1× display left of the main one (negative x)', a['x'] < 0 and a['scale'] == 1 and left.info['placed'], left.info)

            # 1. On the 1× display left of the main one.
            s.check('window placed on the left display', place(s, a['x'] + 80, a['y'] + 60), window_frame(s))
            state = s.call('get_app_state', app=app, ocr=True)
            g = geometry(state['text'])
            s.check('screenshot on the left display (negative x)', g and g['x'] < 0 and abs(g['sx'] - 1) < 0.05, state['text'][:240])
            apply = [hit for hit in ocr_lines(state['text']) if hit[0].strip() == 'Apply']
            if s.check('OCR finds Apply on the left display', apply, [hit[0] for hit in ocr_lines(state['text'])][:20]):
                result, pressed = click_counts(s, 'apply', x=apply[0][1], y=apply[0][2])
                s.check('click at OCR coordinates presses Apply there', not result['is_error'] and pressed, result['text'][:160])
            if g:
                x, y = target_pixels(s, g)
                result, hit = click_counts(s, 'target', x=x, y=y)
                last = (s.fixture.state()['canvasClicks'] or [{}])[-1]
                s.check('screenshot coordinates hit the 10×10 pt target on the left display', not result['is_error'] and hit,
                        f"canvas point {last.get('x')},{last.get('y')}; {result['text'][:120]}")
                region = dict(x=round(x - 24, 1), y=round(y - 18, 1), width=48, height=36)
                zoomed = s.call('zoom', app=app, scale=2, ocr=False, **region)
                if s.check("zoom on the left display: 2× is beyond its 1× detail", not zoomed['is_error'] and zoomed['images']
                           and "beyond the display's 1× detail" in zoomed['text'], zoomed['text'][:260]):
                    zoom_id = re.search(r'Zoom (z\d+)', zoomed['text'])[1]
                    red = probe('red', zoomed['images'][0])
                    result, hit = click_counts(s, 'target', x=red['x'], y=red['y'], zoom_id=zoom_id)
                    s.check('zoom coordinates hit the target on the left display', not result['is_error'] and hit, result['text'][:160])
            old = apply[0] if apply else None

            # 2. A Retina display made while skfiy runs; the window moves there.
            right = VirtualDisplay('right', hidpi=True, allow_unlocked=args.allow_unlocked)
            b = right.frame
            s.check('a Retina (2×) display right of the main one, made while skfiy runs', b['x'] >= max(d['x'] + d['width'] for d in original)
                    and b['scale'] == 2 and right.info['placed'], right.info)
            s.check('window moved to the right display', place(s, b['x'] + 60, b['y'] + 40), window_frame(s))
            if old:
                before = dict(s.fixture.state()['counters'])
                stale = s.call('click', app=app, x=old[1], y=old[2])
                s.check('after moving across displays, old coordinates are refused, nothing sent', stale['is_error']
                        and s.fixture.state()['counters'] == before, stale['text'][:200])
            state = s.call('get_app_state', app=app, ocr=True)
            g = geometry(state['text'])
            s.check('screenshot on the right display', g and g['x'] >= b['x'] - 1, state['text'][:240])
            if g:
                x, y = target_pixels(s, g)
                result, hit = click_counts(s, 'target', x=x, y=y)
                s.check('screenshot coordinates hit the target on the right display', not result['is_error'] and hit, result['text'][:160])
                zoomed = s.call('zoom', app=app, scale=2, ocr=False, x=round(x - 24, 1), y=round(y - 18, 1), width=48, height=36)
                expected = "100% of the display's detail" if b['scale'] == 2 else f"beyond the display's {b['scale']:g}× detail"
                s.check(f"zoom on the right display ({b['scale']:g}×) follows its detail: {expected}", not zoomed['is_error']
                        and expected in zoomed['text'], zoomed['text'][:260])

            # 3. Across the left display and the main one: center on the main one.
            main_display = next(d for d in original if d['main'])
            s.check('window placed across the left and main displays', place(s, main_display['x'] - 200, main_display['y'] + 120), window_frame(s))
            state = s.call('get_app_state', app=app, ocr=True)
            g = geometry(state['text'])
            edits = sorted((hit for hit in ocr_lines(state['text']) if hit[0].strip() == 'Edit'), key=lambda hit: hit[1])
            if s.locked:
                profile = edits[0] if edits else None
                s.check('the part on the other display is in the screenshot (left Edit button)', g and g['x'] < main_display['x'] and profile,
                        f"{state['text'][:200]}; Edit at {[(e[1], e[2]) for e in edits]}")
                if profile:
                    result, pressed = click_counts(s, 'edit-profile', x=profile[1], y=profile[2])
                    s.check('clicking it there presses it (event on the left display)', not result['is_error'] and pressed, result['text'][:160])
            else:
                s.check('across displays (unlocked): screenshot taken', g is not None, state['text'][:240])

            # 4. The window's display removed: macOS moves the window back.
            s.check('window back on the right display', place(s, b['x'] + 60, b['y'] + 40), window_frame(s))
            state = s.call('get_app_state', app=app, ocr=True)
            apply = [hit for hit in ocr_lines(state['text']) if hit[0].strip() == 'Apply']
            right.close()
            right = None
            gone = wait_until(lambda: (frame := window_frame(s)) and not on(b, frame), timeout=8)
            time.sleep(0.5)
            s.check('display removed: macOS moved the window off it', gone, f"now at {window_frame(s)}; the app itself says {s.fixture.state()['windows'][0]['frame']}")
            if apply:
                before = dict(s.fixture.state()['counters'])
                stale = s.call('click', app=app, x=apply[0][1], y=apply[0][2])
                s.check('old coordinates from the removed display are refused, nothing sent', stale['is_error']
                        and s.fixture.state()['counters'] == before, stale['text'][:200])
            state = s.call('get_app_state', app=app, ocr=True)
            apply = [hit for hit in ocr_lines(state['text']) if hit[0].strip() == 'Apply']
            s.check('a fresh screenshot finds the window where macOS put it', not state['is_error'] and apply, state['text'][:200])
            if apply:
                result, pressed = click_counts(s, 'apply', x=apply[0][1], y=apply[0][2])
                s.check('and its coordinates work', not result['is_error'] and pressed, result['text'][:160])
            place(s, main_display['x'] + 100, main_display['y'] + 100)
            left.close()
            s.check('afterwards only the original displays remain', wait_until(lambda: len(probe('displays')['displays']) == len(original), timeout=6),
                    probe('displays'))
    finally:
        if right:
            right.close()
        left.close()


if __name__ == '__main__':
    main()
