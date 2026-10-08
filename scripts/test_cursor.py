#!/usr/bin/env python3
"""The agent cursor (Codex style) against the scenario app:

    python3 scripts/test_cursor.py .build/debug/skfiy

Unlocked: a click by x/y brings up the cursor of a helper process (`skfiy
cursor-overlay`, a child of the MCP server) with its tip on the clicked
point, in a window directly above the target window (so covered wherever
the target is) and under 80 pt tall; the click still lands, the front app
never changes, the helper never comes forward, the screenshot does not show
the cursor, the cursor follows the window when it moves, fades after
SKFIY_CURSOR_IDLE seconds, comes back for scroll and keys, and goes away
with the session. SKFIY_CURSOR=0 starts no helper. Locked: no helper either.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, main_binary, ocr_lines, probe, tool, wait_until  # noqa: E402

HOTSPOT = (30, 30)  # CursorOverlay.hotspot


def helpers(parent):
    out = subprocess.run(['pgrep', '-P', str(parent), '-f', 'cursor-overlay'], capture_output=True, text=True).stdout.split()
    return [int(pid) for pid in out]


def alive(pid):
    return subprocess.run(['kill', '-0', str(pid)], capture_output=True).returncode == 0


def stack():
    return probe('stack')['windows']


def geometry(text):
    match = re.search(r'Screenshot: (\d+)×(\d+) px showing screen region x=([\d.-]+) y=([\d.-]+) w=([\d.]+) h=([\d.]+) pt', text)
    width, height, x, y, w, h = (float(v) for v in match.groups())
    return lambda px, py: (x + px * w / width, y + py * h / height)


def patch(path, x, y, size=8):
    return json.loads(subprocess.run([str(tool('AXProbe')), 'patch', path, str(x), str(y), str(size), str(size)],
                                     capture_output=True, text=True, timeout=20).stdout)


def main():
    main_binary()
    with Session('cursor', environment={'SKFIY_CURSOR': '1', 'SKFIY_CURSOR_IDLE': '4'}) as s:
        app, mcp = s.app, s.client.proc.pid
        state = s.call('get_app_state', app=app, ocr=True)
        apply = [hit for hit in ocr_lines(state['text']) if hit[0].strip() == 'Apply']
        if s.locked:
            hit = apply[0] if apply else ('', 40, 40)
            s.call('click', app=app, x=hit[1], y=hit[2])
            time.sleep(0.5)
            s.check('locked: no cursor helper started', not helpers(mcp), helpers(mcp))
            return
        to_screen = geometry(state['text'])
        before = s.call('get_app_state', app=app)
        front = probe('front')['front']
        s.check('the scenario app has its Apply button', apply, state['text'][-300:])
        if not apply:
            return
        _, px, py = min(apply, key=lambda hit: (hit[2], hit[1]))
        point = to_screen(px, py)

        clicked = s.call('click', app=app, x=px, y=py)
        pids = helpers(mcp)
        s.check('a click starts one cursor helper, a child of skfiy mcp', len(pids) == 1, pids)
        s.check('the click still lands', not clicked['is_error'] and s.fixture.state()['counters'].get('apply') == 1, clicked['text'][:160])
        if len(pids) != 1:
            return
        helper = pids[0]
        windows = stack()
        cursor = next((w for w in windows if w['pid'] == helper), None)
        s.check('the cursor window is on screen and under 80 pt tall', cursor and cursor['height'] < 80, cursor)
        if not cursor:
            return
        tip = (cursor['x'] + HOTSPOT[0], cursor['y'] + HOTSPOT[1])
        s.check('its tip is on the clicked point', abs(tip[0] - point[0]) <= 2 and abs(tip[1] - point[1]) <= 2, f'tip {tip} point {point}')
        target = next((w for w in windows if w['owner'] == app and w['width'] > 80 and w['height'] > 80), None)
        order = [w['id'] for w in windows]
        directly_above = target and order.index(cursor['id']) == order.index(target['id']) - 1
        covered = [w['owner'] for w in windows[:order.index(cursor['id'])]] if directly_above else None
        s.check('directly above the target window (covered by whatever covers it)', directly_above,
                f'cursor at {order.index(cursor["id"])}, target at {target and order.index(target["id"])}; above both: {covered}')
        s.check('the front app did not change and the helper never came forward', probe('front')['front'] == front, probe('front'))

        # The screenshot is of the app's windows only: the cursor's body is not in it.
        after = s.call('get_app_state', app=app)
        shot_before, shot_after = before['images'][0], after['images'][0]
        body = (px + 3, py + 8)  # inside the arrow, below and right of the tip, in screenshot pixels
        a, b = patch(shot_before, *body), patch(shot_after, *body)
        same = all(abs(a[c] - b[c]) < 18 for c in 'rgb') if 'r' in a and 'r' in b else False
        s.check('the screenshot does not show the cursor', same, f'before {a} after {b}')

        # It follows the window.
        s.fixture.command('move', dx=40, dy=30)
        moved = wait_until(lambda: any(w['pid'] == helper and abs(w['x'] - cursor['x'] - 40) <= 2 and abs(w['y'] - cursor['y'] - 30) <= 2
                                       for w in stack()), timeout=3)
        s.check('it follows the target window when that moves', moved, [w for w in stack() if w['pid'] == helper])
        s.fixture.command('move', dx=-40, dy=-30)

        gone = wait_until(lambda: not any(w['pid'] == helper for w in stack()), timeout=8)
        s.check('it fades after SKFIY_CURSOR_IDLE seconds without actions', gone, '')
        s.call('scroll', app=app, x=px, y=py + 60, direction='down', pages=1)
        s.check('a scroll brings it back', any(w['pid'] == helper for w in stack()), '')
        s.call('press_key', app=app, key='cmd+shift+F15')
        s.check('keys keep it over the same app', any(w['pid'] == helper for w in stack()), '')
        s.check('still only one helper', helpers(mcp) == [helper], helpers(mcp))
    gone = wait_until(lambda: not alive(helper), timeout=3)
    print(f"  {'ok ' if gone else 'FAIL'} the helper quits with the session")

    with Session('cursor-off', environment={'SKFIY_CURSOR': '0'}) as s:
        state = s.call('get_app_state', app=s.app, ocr=True)
        apply = [hit for hit in ocr_lines(state['text']) if hit[0].strip() == 'Apply']
        if apply:
            s.call('click', app=s.app, x=apply[0][1], y=apply[0][2])
        s.check('SKFIY_CURSOR=0: no helper', not helpers(s.client.proc.pid), helpers(s.client.proc.pid))
    if not gone:
        sys.exit(1)


if __name__ == '__main__':
    main()
