#!/usr/bin/env python3
"""Real Apple Screen Sharing against a disposable loopback RFB framebuffer.

--accept permits temporary focus during fixture authentication and the explicit
run_in_front shortcut check. All other inputs are independently sampled in the
background. No existing remote connection receives input; only summary counts
are printed. The fixture exports no real desktop and discards clipboard data.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / 'fixtures'))
from rfb_fixture import RFBFixture
from harness import APPROVE, Client, ROOT

APP = 'com.apple.ScreenSharing'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--accept', action='store_true')
    args = parser.parse_args()
    if not args.accept:
        parser.error('--accept is required for opening/briefly focusing a disposable test connection')
    checks = []
    samples = []
    stop = threading.Event()
    watcher = None
    with tempfile.TemporaryDirectory(prefix='skfiy-sharing-') as temp:
        helper = Path(temp) / 'UI'
        subprocess.run(['swiftc', str(ROOT / 'scripts/fixtures/ScreenSharingFixtureUI.swift'), '-o', str(helper)], check=True, capture_output=True)
        def ui(*values):
            return subprocess.check_output([str(helper), *map(str, values)], text=True).strip()
        def status():
            return json.loads(ui('status'))
        def check(label, ok):
            checks.append({'check': label, 'ok': bool(ok)})
            print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        name = 'skfiy Screen Sharing Fixture ' + uuid.uuid4().hex[:8]
        fixture = RFBFixture(name)
        client = Client(args.binary, answer=APPROVE, env={'SKFIY_CURSOR': '0'})
        original = status()['front']
        try:
            assert 'unlocked' in client.call('get_desktop_status')['text'], 'unlock the local Mac before running'
            subprocess.run(['open', '-g', '-a', '/System/Applications/Utilities/Screen Sharing.app', f'vnc://127.0.0.1:{fixture.port}'], check=True)
            auth = None
            for _ in range(40):
                result = client.call('get_app_state', app=APP, screenshot=False)
                if str(fixture.port) in result['text'] and 'TextField(SecureTextField)' in result['text']:
                    auth = result['text']
                    break
                time.sleep(.25)
            assert auth is not None, 'fixture authentication dialog did not appear'
            field = int(re.search(r'\[(\d+)\] TextField', auth)[1])
            button = int(re.search(r'\[(\d+)\] Button "Sign In"', auth)[1])
            client.call('click', app=APP, element_index=field)
            client.call('type_text', app=APP, text='fixture')
            original = status()['front']
            setup = client.call('run_in_front', app=APP, element_index=button,
                                reason='authenticate only this temporary loopback test screen', allow_error=True)
            assert not setup['is_error'], setup['text'].splitlines()[0]
            assert fixture.ready.wait(10), 'native client did not connect to fixture'
            check('fixture setup restores the original foreground app', status()['front'] == original)
            result = client.call('get_app_state', app=APP, window=name, ocr=False)
            pid = int(re.search(r'\(pid (\d+)\)', result['text'])[1])
            window = re.search(r'Window:.*?\(id (\d+)\)', result['text'])[1]
            region = re.search(r'Shared screen region: x=([-\d.]+) y=([-\d.]+) w=([-\d.]+) h=([-\d.]+)', result['text'])
            assert region, 'no remote coordinate region'
            rx, ry, rw, rh = map(float, region.groups())
            x, y = rx + rw / 2, ry + rh / 2
            check('remote screen has independent screenshot and coordinate region', bool(result['images']) and 'remote screen' in result['text'])
            before = status()
            def watch():
                while not stop.is_set():
                    try:
                        samples.append(status())
                    except Exception:
                        samples.append({})
                    stop.wait(.04)
            watcher = threading.Thread(target=watch, daemon=True)
            watcher.start()
            def act(tool, **values):
                start = len(fixture.events)
                out = client.call(tool, app=APP, window_id=window, allow_error=True, **values)
                time.sleep(.12)
                return out, fixture.events[start:]
            def pointers(events):
                return [e for e in events if e[0] == 'pointer']
            out, events = act('click', x=x, y=y)
            check('background left click reaches remote center exactly once', not out['is_error'] and sum(e[1] == 1 for e in pointers(events)) == 1 and any(e[2:] == (320, 240) for e in pointers(events)))
            out, events = act('click', x=x, y=y, click_count=2)
            check('double click has exactly two remote button downs', not out['is_error'] and sum(e[1] == 1 for e in pointers(events)) == 2)
            out, events = act('click', x=x, y=y, mouse_button='right')
            check('right click reaches remote instead of local context menu', not out['is_error'] and any(e[1] == 4 for e in pointers(events)))
            out, events = act('click', x=x, y=y, mouse_button='middle')
            check('middle click preserves remote button mapping', not out['is_error'] and any(e[1] == 2 for e in pointers(events)))
            out, events = act('type_text', text='aAZ +\n\t')
            down = [e[2] for e in events if e[:2] == ('key', 1)]
            up = [e[2] for e in events if e[:2] == ('key', 0)]
            check('ASCII case punctuation return and tab arrive with releases', not out['is_error'] and down == up == [97, 65, 90, 32, 43, 65293, 65289])
            out, events = act('type_text', text='must-not-send-prefix中😀')
            check('Unicode is refused before sending even the ASCII prefix', out['is_error'] and not events)
            out, events = act('press_key', key='cmd+a')
            check('unsupported background modifier chord sends nothing', out['is_error'] and 'run_in_front' in out['text'] and not events)
            out, events = act('press_key', key='left', repeat=2)
            check('plain navigation key repeats include key-up', not out['is_error'] and [e[2] for e in events if e[:2] == ('key', 1)] == [65361, 65361] and sum(e[:2] == ('key', 0) for e in events) == 2)
            for direction, mask in [('up', 8), ('down', 16)]:
                out, events = act('scroll', x=x, y=y, direction=direction, pages=.1)
                check(f'{direction} wheel reaches remote', not out['is_error'] and any(e[1] == mask for e in pointers(events)))
            for direction in ['left', 'right']:
                out, events = act('scroll', x=x, y=y, direction=direction, pages=.1)
                check(f'{direction} unsupported horizontal wheel is refused', out['is_error'] and not events)
            out, events = act('drag', from_x=x, from_y=y, to_x=x+80, to_y=y+40)
            trace = pointers(events)
            check('drag holds left through movement and releases at destination', not out['is_error'] and len([e for e in trace if e[1] == 1]) > 5 and trace[-1] == ('pointer', 0, 400, 280))
            out, events = act('drag', from_x=x, from_y=y, to_x=x, to_y=10)
            check('drag cannot leave remote surface for local toolbar', out['is_error'] and not events)
            client.call('get_app_state', app=APP, window=name, screenshot=False)
            out, events = act('press_key', key='a')
            check('tree-only refresh invalidates remote input lease', out['is_error'] and not events)
            client.call('get_app_state', app=APP, window=name, ocr=False)
            ui('resize', name, 760, 620)
            out, events = act('click', x=x, y=y)
            check('resize invalidates previously observed coordinates', out['is_error'] and not events)
            stop.set(); watcher.join(timeout=3); watcher = None
            after = status()
            check('background input never activates or raises Screen Sharing', bool(samples) and all(s and s['front'] != pid and s['topPID'] != pid for s in samples))
            check('background input leaves local pointer and clipboard alone', before['pointer'] == after['pointer'] and before['clipboard'] == after['clipboard'])
            # Real production approval path, scoped to this disposable screen.
            client.call('get_app_state', app=APP, window=name, ocr=False)
            n = len(fixture.events)
            original = status()['front']
            out = client.call('run_in_front', app=APP, key='cmd+a', reason='temporary loopback test screen', allow_error=True)
            time.sleep(.2)
            events = fixture.events[n:]
            check('approved foreground Command chord reaches remote with modifier release', not out['is_error'] and any(e[:2] == ('key', 1) and e[2] in (65511, 65513, 65515) for e in events) and any(e[:2] == ('key', 0) and e[2] in (65511, 65513, 65515) for e in events))
            check('foreground fallback restores original app', status()['front'] == original)
            check('fixture protocol remained healthy', not fixture.errors)
        finally:
            stop.set()
            if watcher: watcher.join(timeout=3)
            ui('close', name)
            ui('close', f'127.0.0.1:{fixture.port}')
            client.close()
            fixture.close()
            saved = Path.home() / 'Library/Containers/com.apple.ScreenSharing/Data/Library/Application Support/Screen Sharing'
            for entry in saved.glob(name + ' *.vncloc'):
                entry.unlink()
        print(json.dumps({'passed': sum(x['ok'] for x in checks), 'total': len(checks), 'backgroundSamples': len(samples)}, sort_keys=True))
        if not checks or not all(x['ok'] for x in checks):
            raise SystemExit(1)


if __name__ == '__main__':
    main()
