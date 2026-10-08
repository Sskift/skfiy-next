#!/usr/bin/env python3
"""A Chromium (Electron) window that other windows cover completely:

    SKFIY_TEST_BIN=/tmp/skfiy-wf4/bin python3 scripts/test_covered_chromium.py .build/debug/skfiy

Chromium stops drawing a window that is fully covered, stops updating its
accessibility tree and drops wheel input to it; with one corner showing it
works normally. skfiy must say so instead of reporting "looks the same" or
no_effect for an action it cannot observe, refuse wheel scrolling there, and
find the page's tree once part of the window shows again.

The Electron window (scripts/fixtures/electron-covered) never shows over the
user's windows: it appears transparent and click-through, is ordered right
above the scenario app's window at the back of the stack, and only then turns
opaque. It is placed where the user's windows cover it completely, and (when
there is such a place) where only a corner shows on the desktop. The page
reports its own clicks, field value, scroll position and visibility to
scripts/compat_server.py. Unlocked only; needs Electron in
~/.cache/skfiy-test/electron (as the compatibility baseline does).
"""
import atexit
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import ROOT, Session, main_binary, probe, tool, wait_until  # noqa: E402
from test_background_windows import Watch, tree_index  # noqa: E402

ELECTRON = Path.home() / '.cache/skfiy-test/electron/node_modules/electron/dist/Electron.app'
PORT = 8771
WORK = Path('/tmp/skfiy-wf4/covered')
SIZE = (420, 320)


def server():
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{PORT}/state?run=ping', timeout=1).read()
        return None
    except OSError:
        pass
    (WORK / 'events').mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/compat_server.py'), '--port', str(PORT), '--root', str(ROOT / 'scripts/fixtures'),
                                '--events', str(WORK / 'events')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_until(lambda: urllib.request.urlopen(f'http://127.0.0.1:{PORT}/state?run=ping', timeout=1).read(), timeout=5)
    return process


def page(run):
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/state?run={run}', timeout=2).read()).get('state', {})


def command(run, **state):
    body = json.dumps({'event': 'command', 'state': {'run': run + '-command', **state}}).encode()
    urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/event', data=body, headers={'Content-Type': 'application/json'}), timeout=2).read()


def coverage(rect, stack, skip):
    """Share of rect under the on-screen windows (all but `skip`), the menu bar and the Dock strip counted as cover."""
    x, y, w, h = rect
    # Rounded corners (24 pt) of the windows above let what is under them show.
    covers = [rect for r in stack if r['pid'] not in skip and r['alpha'] > 0.01
              for rect in ((r['x'] + 24, r['y'], r['width'] - 48, r['height']), (r['x'], r['y'] + 24, r['width'], r['height'] - 48))]
    hits = total = 0
    for i in range(48):
        for j in range(48):
            px, py = x + (i + 0.5) * w / 48, y + (j + 0.5) * h / 48
            total += 1
            hits += py < 40 or any(cx <= px < cx + cw and cy <= py < cy + ch for cx, cy, cw, ch in covers)
    return hits / total


def places(skip):
    """A rectangle the user's windows cover completely, and one that shows only a corner."""
    stack = probe('stack')['windows']
    display = probe('displays')['displays'][0]
    width, height = display['width'], display['height']
    full = corner = None
    for y in range(60, int(height - SIZE[1] - 110), 20):
        for x in range(0, int(width - SIZE[0]), 20):
            share = coverage((x, y, *SIZE), stack, skip)
            if share >= 1 and not full:
                full = (x, y, *SIZE)
            if 0.85 <= share < 1 and not corner:
                corner = (x, y, *SIZE)
    return full, corner


def main():
    main_binary()
    tool('AXProbe')
    tool('Launch')
    if not ELECTRON.exists():
        sys.exit('Electron is not installed in ~/.cache/skfiy-test/electron')
    if subprocess.run(['pgrep', '-x', 'Electron'], capture_output=True).returncode == 0:
        sys.exit('another app named Electron is running')
    started = server()
    if started:  # also when a check returns early
        atexit.register(started.terminate)
    with Session('covered-chromium', window_guard=False, environment={'SKFIY_CURSOR': '0'}) as s:
        if s.locked:
            s.check('the Mac is unlocked', False, 'skipped')
            return
        w = Watch(s)
        back = s.fixture.state()['windows'][0]['number']
        full, corner = places({s.fixture.pid})
        s.summary['places'] = {'covered': full, 'corner': corner}
        if not full:
            s.check('a place where the user\'s windows cover the test window completely', False, 'none on screen now; skipped')
            return
        run = f'covered-{s.nonce}'
        control = WORK / f'{s.nonce}.json'
        WORK.mkdir(parents=True, exist_ok=True)
        control.write_text('{}')
        pid = int(subprocess.run([str(tool('Launch')), str(ELECTRON), str(ROOT / 'scripts/fixtures/electron-covered'),
                                  f'--url=http://127.0.0.1:{PORT}/covered.html?run={run}', f'--behind={back}',
                                  f'--bounds={",".join(map(str, full))}', f'--control={control}', f'--data={WORK / "data"}'],
                                 capture_output=True, text=True, timeout=30, check=True).stdout.split()[0])
        try:
            loaded = wait_until(lambda: page(run).get('run') == run, timeout=20)
            # Chromium marks a covered page hidden a while after it is covered.
            s.summary['hiddenAtStart'] = bool(wait_until(lambda: page(run).get('visibility') == 'hidden', timeout=40))
            mine = [r for r in probe('stack')['windows'] if r['pid'] == pid]
            stack = probe('stack')['windows']
            share = coverage((mine[0]['x'], mine[0]['y'], mine[0]['width'], mine[0]['height']), stack, {s.fixture.pid, pid}) if mine else None
            s.check('setup: the page loaded, the Electron window is behind the user\'s windows and fully covered',
                    loaded and mine and share == 1 and probe('front')['topOwner'] != 'Electron',
                    {'coverage': share, 'visibility': page(run).get('visibility'), 'top': probe('front')['topOwner']})

            first = w.call('get_app_state', mine[0]['id'], app='Electron')
            s.check('get_app_state of the fully covered window says Chromium is not updating it', not first['is_error'] and 'completely covered' in first['text'],
                    first['text'][:300])
            capabilities = w.call('get_app_capabilities', None, app='Electron')
            s.check('get_app_capabilities says the screenshot is stale while the window is covered', 'completely covered' in capabilities['text'],
                    capabilities['text'][:300])

            if corner:
                control.write_text(json.dumps({'bounds': list(corner)}))
                wait_until(lambda: page(run).get('visibility') == 'visible', timeout=6)
                time.sleep(1.5)
                shown = w.call('get_app_state', mine[0]['id'], app='Electron')
                s.check('with a corner showing, the page\'s tree is there (asked for again) and no stale note',
                        tree_index(shown['text'], r'Button[^\n]*Increment') is not None and 'completely covered' not in shown['text'],
                        {'visibility': page(run).get('visibility'), 'head': shown['text'][:200]})
                before = page(run).get('scrollY', 0)
                scrolled = w.call('scroll', mine[0]['id'], app='Electron', element_index=tree_index(shown['text'], r'WebArea') or 0, direction='down', pages=1)
                after = wait_until(lambda: page(run).get('scrollY', 0) > before and page(run).get('scrollY'), timeout=3)
                s.check('with a corner showing, wheel scrolling works', not scrolled['is_error'] and after, (before, page(run).get('scrollY'), scrolled['text'][:120]))
                control.write_text(json.dumps({'bounds': list(full)}))
                s.summary['hiddenAgain'] = bool(wait_until(lambda: page(run).get('visibility') == 'hidden', timeout=40))
                time.sleep(1.5)

            look = w.call('get_app_state', mine[0]['id'], app='Electron')
            increment = tree_index(look['text'], r'Button[^\n]*Increment')
            s.summary['visibilityCovered'] = page(run).get('visibility')
            if increment is None:
                s.check('covered again: the tree from before is still there to act on', False, look['text'][:300])
                return
            clicks = page(run).get('clicks', 0)
            clicked = w.call('click', mine[0]['id'], app='Electron', element_index=increment)
            done = wait_until(lambda: page(run).get('clicks', 0) > clicks, timeout=4)
            s.check('a click by element_index reaches the covered page, and the reply does not claim the window looks the same',
                    not clicked['is_error'] and done and 'looks the same as in the latest screenshot, so none is attached' not in clicked['text']
                    and 'completely covered' in clicked['text'], (page(run).get('clicks'), clicked['text'][-300:]))
            clicks = page(run).get('clicks', 0)
            verified = w.call('click', mine[0]['id'], app='Electron', element_index=increment, expect={'text': f'Clicks: {clicks + 1}', 'timeout': 2})
            first_line = verified['text'].splitlines()[0]
            s.check('with expect, an unseen effect is not reported as no_effect', 'no_effect' not in first_line
                    and ('verified' in first_line or 'unknown' in first_line or 'out of date' in first_line), (first_line, page(run).get('clicks')))
            before = page(run).get('scrollY', 0)
            wheel = w.call('scroll', mine[0]['id'], app='Electron', element_index=increment, direction='down', pages=1)
            time.sleep(1)
            s.check('wheel scrolling on the covered window says it may have done nothing', not wheel['is_error'] and 'completely covered' in wheel['text'],
                    (before, page(run).get('scrollY', 0), page(run).get('visibility'), wheel['text'][-240:]))
            field = tree_index(look['text'], r'TextField[^\n]*Covered input')
            if field is not None:
                value = w.call('set_value', mine[0]['id'], app='Electron', element_index=field, value=f'cov{s.nonce[:4]}')
                got = wait_until(lambda: page(run).get('value') == f'cov{s.nonce[:4]}', timeout=4)
                s.check('set_value on the covered page: the page gets the value, and a stale read-back is not called a rejection',
                        not value['is_error'] and got and 'rejected' not in value['text'], (page(run).get('value'), value['text'][:200]))
            later = f'LATE{s.nonce[:6]}'
            command(run, later=later)
            waited = w.call('wait_for', mine[0]['id'], app='Electron', text=later, timeout=4)
            seen = page(run).get('later') == later
            s.check('wait_for on the covered page: found, or a timeout that says the window is not being updated',
                    seen and (not waited['is_error'] or 'not been updating' in waited['text']), (seen, waited['text'][:200]))
            w.finish()
        finally:
            control.write_text(json.dumps({'quit': True}))
            if not wait_until(lambda: subprocess.run(['kill', '-0', str(pid)], capture_output=True).returncode != 0, timeout=5):
                subprocess.run(['kill', '-TERM', str(pid)])


if __name__ == '__main__':
    main()
