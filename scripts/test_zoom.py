#!/usr/bin/env python3
"""zoom against the scenario app, in whatever state the Mac is in:

    python3 scripts/test_zoom.py .build/debug/skfiy

Tiny text becomes readable (zoom's own OCR, and an independent OCR of the
zoom image); at scales 1–4 a 10×10 pt target found in the zoom image is hit
by clicking with zoom_id, and the printed formula agrees; a moved or resized
window, a newer screenshot, or (while locked) a screenshot older than 30 s
make zoom and zoom coordinates refuse, without sending anything.
"""
import json
import random
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, main_binary, probe, tool  # noqa: E402

SHOT = re.compile(r'Screenshot: (\d+)×(\d+) px showing screen region x=(-?[\d.]+) y=(-?[\d.]+) w=([\d.]+) h=([\d.]+)')
NUMBER = r'(-?\d+(?:\.\d+)?)'
FORMULA = re.compile(rf'screenshot x = {NUMBER} \+ zoom_x / {NUMBER}, y = {NUMBER} \+ zoom_y / {NUMBER}')


def geometry(text):
    m = SHOT.search(text)
    width, height, x, y, w, h = (float(v) for v in m.groups())
    return {'x': x, 'y': y, 'sx': width / w, 'sy': height / h, 'width': width, 'height': height}


def to_pixels(g, point):
    return ((point[0] - g['x']) * g['sx'], (point[1] - g['y']) * g['sy'])


def readable_code(length):
    """A random marker without the characters text recognition commonly
    confuses at small sizes (0/O, 1/l/I/f, c/o/e, 5/S, 8/B, 6/b, 2/Z, 9/g), so a
    misread tells about readability, not about which pair the nonce drew."""
    return ''.join(random.SystemRandom().choice('adhkmnprtwxy347') for _ in range(length))


def main():
    main_binary()
    with Session('zoom') as s:
        app = s.app
        code = readable_code(6)
        s.fixture.command('tiny', code=code)
        state = s.call('get_app_state', app=app, ocr=True)
        g = geometry(state['text'])
        fixture = s.fixture.state()
        canvas = fixture['canvas']
        before_clicks = fixture['counters'].get('canvas', 0)
        tiny_lines = [line for line in state['text'].splitlines() if 'tiny' in line.lower()]
        s.check('tiny text in the whole-window OCR (informational)', True, f"lines with 'tiny': {tiny_lines[:2]}; code read: {any(code in l for l in tiny_lines)}")

        # 1. Tiny text (6 and 7 pt): zoom on the canvas's top-left corner.
        read = {}
        for size, offset in ((6, 36), (7, 48)):
            tiny = to_pixels(g, (canvas['x'], canvas['y'] + offset))
            result = s.call('zoom', app=app, x=max(0, tiny[0] - 4), y=max(0, tiny[1] - 2), width=90, height=18, scale=4, ocr=True)
            independent = probe('ocr', result['images'][0]) if result['images'] else {'lines': []}
            read[size] = (code in result['text'], any(code in line for line in independent['lines']))
            whole = any(code in line for line in state['text'].splitlines() if f'tiny{size}' in line)
            s.check(f'{size} pt text (zoom OCR / independent OCR exact: {read[size]}; whole-window OCR exact: {whole})',
                    not result['is_error'] and result['images'] and (read[size][0] or not whole),
                    ' | '.join(l for l in result['text'].splitlines() if 'tiny' in l)[:150] + ' || ' + ' | '.join(independent['lines']))
        s.check('7 pt text read exactly in the zoom', read[7] == (True, True), read)

        # 2. Coordinates at several scales: find the red target in the zoom, click it there.
        target_center = (canvas['x'] + 235, canvas['y'] + 25)   # canvas is flipped: target at (230, 20, 10, 10)
        target_pixel = to_pixels(g, target_center)
        for scale in (1, 2, 3, 4):
            state = s.call('get_app_state', app=app, ocr=False)
            g = geometry(state['text'])
            target_pixel = to_pixels(g, target_center)
            region = dict(x=round(target_pixel[0] - 24, 1), y=round(target_pixel[1] - 18, 1), width=48, height=36)
            zoomed = s.call('zoom', app=app, scale=scale, ocr=False, **region)
            if not s.check(f'scale {scale}: zoom', not zoomed['is_error'] and zoomed['images'], zoomed['text'][:200]):
                continue
            zoom_id = re.search(r'Zoom (z\d+)', zoomed['text'])[1]
            red = probe('red', zoomed['images'][0])
            formula = FORMULA.search(zoomed['text'])
            fx, fy = float(formula[2]), float(formula[4])
            mapped = (float(formula[1]) + red['x'] / fx, float(formula[3]) + red['y'] / fy)
            # The cut follows whole display pixels, so the region shown can be a fraction wider.
            s.check(f'scale {scale}: zoom is {scale}× the region', abs(fx - scale) < 0.06 and abs(fy - scale) < 0.06,
                    f"{red['width']}×{red['height']} px, factors {fx}, {fy}")
            s.check(f'scale {scale}: formula maps the target back', abs(mapped[0] - target_pixel[0]) <= 1.2 and abs(mapped[1] - target_pixel[1]) <= 1.2,
                    f'mapped {mapped[0]:.2f},{mapped[1]:.2f} vs {target_pixel[0]:.2f},{target_pixel[1]:.2f}')
            clicks = s.fixture.state()['counters'].get('target', 0)
            clicked = s.call('click', app=app, zoom_id=zoom_id, x=red['x'], y=red['y'])
            hit = s.fixture.wait(lambda st: st['counters'].get('target', 0) > clicks, timeout=4)
            last = (s.fixture.state()['canvasClicks'] or [{}])[-1]
            s.check(f'scale {scale}: click at zoom coordinates hits the target', not clicked['is_error'] and hit,
                    f"{clicked['text'].splitlines()[0][:100]}; canvas point {last.get('x')},{last.get('y')}")

        # 3. Refusals: moved, resized, newer screenshot, expired. Nothing may reach the app.
        s.call('get_app_state', app=app, ocr=False)
        zoomed = s.call('zoom', app=app, x=10, y=10, width=40, height=40, ocr=False)
        zoom_id = re.search(r'Zoom (z\d+)', zoomed['text'])[1]
        counts = dict(s.fixture.state()['counters'])
        s.fixture.command('move', dx=30, dy=0)
        time.sleep(0.4)
        moved = s.call('zoom', app=app, x=10, y=10, width=40, height=40, ocr=False)
        s.check('moved window: zoom refused', moved['is_error'] and ('moved' in moved['text'] or 'changed' in moved['text'] or 'no longer' in moved['text']),
                moved['text'][:200])
        stale = s.call('click', app=app, zoom_id=zoom_id, x=20, y=20)
        s.check('moved window: old zoom coordinates refused', stale['is_error'], stale['text'][:200])
        s.call('get_app_state', app=app, ocr=False)
        s.fixture.command('resize', width=760, height=560)
        time.sleep(0.4)
        resized = s.call('zoom', app=app, x=10, y=10, width=40, height=40, ocr=False)
        s.check('resized window: zoom refused', resized['is_error'], resized['text'][:200])
        s.call('get_app_state', app=app, ocr=False)
        fresh = s.call('zoom', app=app, x=10, y=10, width=40, height=40, ocr=False)
        old_id = re.search(r'Zoom (z\d+)', fresh['text'])[1] if not fresh['is_error'] else 'z0'
        s.check('after get_app_state: zoom works again', not fresh['is_error'], fresh['text'][:120])
        s.call('get_app_state', app=app, ocr=False)
        older = s.call('click', app=app, zoom_id=old_id, x=20, y=20)
        s.check('zoom of an older screenshot refused', older['is_error'] and 'older screenshot' in older['text'], older['text'][:200])
        if s.locked:
            time.sleep(31)
            expired = s.call('zoom', app=app, x=10, y=10, width=40, height=40, ocr=False)
            s.check('expired screenshot (31 s): zoom refused', expired['is_error'] and 'too old' in expired['text'], expired['text'][:200])
        s.check('refusals sent nothing', s.fixture.state()['counters'] == counts, (counts, s.fixture.state()['counters']))


def chrome(s):
    """A real app: 7 px text on the compat page in Chrome for Testing's front tab."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from compat_baseline import ensure_server, PORT
    pids = subprocess.run(['pgrep', '-f', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
                          capture_output=True, text=True).stdout.split()
    if not s.check('Chrome for Testing running', pids, ''):
        return
    ensure_server()
    browser = pids[0]
    tabs = s.call('browser_tabs', browser=browser)
    front = re.search(r'tab (\d+) \[(?:front tab of its window|shown)\]', tabs['text'])
    run = readable_code(8)
    s.call('browser_open', browser=browser, tab_id=int(front[1]), url=f'http://127.0.0.1:{PORT}/compat.html?run={run}')
    app = 'Google Chrome for Testing'
    state = s.call('get_app_state', app=app, ocr=True)
    heading = next(((label, x, y) for label, x, y in __import__('scenario').ocr_lines(state['text']) if 'COMPAT PAGE' in label), None)
    fine_in_state = any(run in line and 'Fine' in line for line in state['text'].splitlines())
    s.check('Chrome: heading located in the whole screenshot', heading, state['text'][:200])
    g = geometry(state['text'])
    width = min(g['width'] - 1, 520)
    zoomed = s.call('zoom', app=app, x=0, y=max(0, heading[2] - 30), width=width, height=min(330, g['height'] - heading[2] + 29), scale=2, ocr=True)
    s.check('Chrome: zoom answers', not zoomed['is_error'] and zoomed['images'], zoomed['text'][:160])
    # As a model would: the first zoom locates the fine print, a closer one reads it.
    status = re.search(r'"Status: ready" zoom x=\d+ y=\d+ → screenshot x=(\d+) y=(\d+)', zoomed['text'])
    s.check('Chrome: status line located by the first zoom', status, '')
    if not status:
        return
    whole = state['text']
    exact = {}
    for offset, size in ((14, 7), (24, 8), (35, 9)):
        located = re.search(rf'"Fine{size}[^"]*" zoom x=\d+ y=\d+ → screenshot x=(\d+) y=(\d+)', zoomed['text'])
        where = (int(located[1]), int(located[2])) if located else (int(status[1]), int(status[2]) + offset)
        close = s.call('zoom', app=app, x=max(0, where[0] - 70), y=max(0, where[1] - 8), width=150, height=16, scale=4, ocr=True)
        read = [l for l in close['text'].splitlines() if f'Fine{size}' in l or 'ine' in l]
        independent = probe('ocr', close['images'][0])['lines'] if close['images'] else []
        exact[size] = (any(run in l for l in read), any(run in l for l in independent), any(run in l and f'Fine{size}' in l for l in whole.splitlines()))
        s.check(f'Chrome: {size} px text (zoom OCR / independent OCR / whole-window OCR exact: {exact[size]})',
                exact[size][0] or not exact[size][2], ' | '.join(read)[:160] + ' || ' + ' | '.join(independent)[:120])
    s.check('Chrome: 9 px text read exactly in the zoom', exact[9][0] and exact[9][1], exact)
    mapped = re.search(r'"COMPAT PAGE" zoom x=(\d+) y=(\d+) → screenshot x=(\d+) y=(\d+)', zoomed['text'])
    s.check('Chrome: zoom coordinates map onto the whole-screenshot position', mapped and abs(int(mapped[3]) - heading[1]) <= 4
            and abs(int(mapped[4]) - heading[2]) <= 4, f'zoom says {mapped.groups() if mapped else None}, screenshot OCR {heading[1:]}')


if __name__ == '__main__':
    main()
    if '--chrome' in sys.argv:
        with Session('zoom-chrome', fixture=False) as session:
            chrome(session)
