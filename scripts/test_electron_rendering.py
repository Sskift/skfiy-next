#!/usr/bin/env python3
"""Controlled native Electron occlusion -> actual frames, AX and input recovery.

The window is physically covered. A test-only addon supplies AppKit's occluded
state/notification because some macOS sessions suppress it (e.g. capture).
The freeze itself is real: require hidden visibility AND a stopped rAF counter.
No WindowGuard, activation or raise is used. Only our own Electron is touched.
Requires cached Electron 32+, clang, and Node N-API headers. Run:
    python3 scripts/test_electron_rendering.py .build/release/skfiy
"""
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid

from harness import Client, Evidence, ROOT, require, wait_until
from scenario import Fixture, probe, tool
import test_covered_chromium as covered


def main():
    binary = Path(sys.argv[1]).resolve()
    fingerprint = hashlib.sha256(binary.read_bytes()).hexdigest()
    require(subprocess.run(['pgrep', '-x', 'Electron'], capture_output=True).returncode != 0,
            'Another Electron test runtime is running; close that fixture first.')
    require(not probe('session')['locked'], 'Run on an unlocked desktop.')
    nonce = uuid.uuid4().hex[:10]
    directory = ROOT / 'eval/results' / ('electron-rendering-' + time.strftime('%Y%m%d-%H%M%S-') + nonce)
    directory.mkdir(parents=True)
    checks = []
    def check(name, passed, detail=None):
        checks.append({'check': name, 'ok': bool(passed), 'detail': detail})
        print(('  ok  ' if passed else ' FAIL ') + name, flush=True)
        require(passed, f'{name}: {detail}')
    node = Path(shutil.which('node') or '/missing').resolve()
    includes = [Path(os.environ.get('SKFIY_NODE_INCLUDE', '/missing')), node.parent.parent / 'include/node',
                Path('/opt/homebrew/include/node'), Path('/usr/local/include/node')]
    include = next((p for p in includes if (p / 'node_api.h').exists()), None)
    require(include, 'Node headers are required to build the test-only N-API addon.')
    addon = directory / 'occlusion.node'
    subprocess.run(['clang++', '-bundle', '-undefined', 'dynamic_lookup', '-I' + str(include), '-framework', 'AppKit',
                    str(ROOT / 'scripts/fixtures/electron-rendering/occlusion.mm'), '-o', str(addon)], check=True)
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); covered.PORT = s.getsockname()[1]
    covered.WORK = directory
    server = covered.server()
    watch_output = (directory / 'focus.jsonl').open('w')
    watch = subprocess.Popen([str(tool('BackgroundWatch'))], stdout=watch_output)
    fixture = None
    pid = None
    clients = []
    control = directory / 'control.json'
    state_file = directory / 'electron.json'
    seq = 0
    def command(**values):
        nonlocal seq
        seq += 1
        temp = control.with_suffix('.tmp')
        temp.write_text(json.dumps({'sequence': seq, **values})); temp.replace(control)
    def state(): return json.loads(state_file.read_text())
    def client(label, **env):
        destination = directory / label; destination.mkdir()
        c = Client(binary, evidence=Evidence(destination), env={'SKFIY_CURSOR': '0', **env})
        clients.append(c)
        return c
    try:
        fixture = Fixture(directory, nonce).launch()
        full, _ = covered.places({fixture.pid})
        require(full, 'No fully covered place for the fixture.')
        command()
        run = 'rendering-' + nonce
        back = fixture.state()['windows'][0]['number']
        args = [str(tool('Launch')), str(covered.ELECTRON), str(ROOT / 'scripts/fixtures/electron-rendering'),
                f'--url=http://127.0.0.1:{covered.PORT}/covered.html?run={run}', f'--behind={back}',
                f'--bounds={",".join(map(str, full))}', f'--control={control}', f'--state={state_file}',
                f'--data={directory / "data"}', f'--addon={addon}']
        launched = int(subprocess.check_output(args, text=True, timeout=30).split()[0])
        # Launch Services could return an instance started by the user between
        # our initial check and launch. Only clean up a PID our own fixture has
        # identified through its unique state file.
        require(wait_until(lambda: state().get('pid') == launched), 'Launch did not return our fixture.')
        pid = launched
        require(wait_until(lambda: covered.page(run).get('run') == run), 'Fixture did not load.')
        before = state()
        window = int(before['windows'][0]['source'].split(':')[1])
        common = {'app': f'pid:{pid}', 'window': str(window)}
        check('target and sibling are loaded, behind the user and covered',
              len(before['windows']) == 2 and covered.coverage(full, probe('stack')['windows'], {pid, fixture.pid}) == 1)
        command(occluded=True)
        require(wait_until(lambda: covered.page(run).get('visibility') == 'hidden'), 'Native occlusion did not hide the page.')
        frames = covered.page(run)['frames']; time.sleep(2)
        check('native occlusion really stops animation frames', covered.page(run)['frames'] == frames, covered.page(run))
        disabled = client('disabled', SKFIY_ELECTRON_RENDERING='0')
        old = disabled.call('get_app_state', **common)
        check('disabled path retains uncertainty and does not open inspector',
              'live rendering could not be confirmed' in old['text'] and not state()['inspector'])
        disabled.close(); clients.remove(disabled)
        marker = 'RECOVERED-' + nonce[:6]
        covered.command(run, later=marker)
        require(wait_until(lambda: covered.page(run).get('later') == marker), 'Marker was not received by the frozen page.')
        c = client('native')
        result = c.call('get_app_state', **common)
        check('renderer resumes and AX is rebuilt', 'Background rendering:' in result['text'] and marker in result['text']
              and bool(wait_until(lambda: covered.page(run)['frames'] > frames)), result['text'])
        check('new pixels contain the independently delivered marker',
              result['images'] and any(marker in line for line in probe('ocr', result['images'][0])['lines']))
        check('temporary inspector closes after startup', wait_until(lambda: not state()['inspector'], timeout=3))
        check('only selected window has its throttling changed', state()['windows'][0]['throttling'] is False
              and state()['windows'][1]['throttling'] is True, state())
        c.call('click', app=f'pid:{pid}', target={'role': 'button', 'name': 'Increment'}, expect={'text': 'Clicks: 1', 'timeout': 3})
        check('background click reaches page', wait_until(lambda: covered.page(run)['clicks'] == 1))
        c.call('set_value', app=f'pid:{pid}', target={'role': 'text field', 'name': 'Covered input'}, value=nonce)
        check('background text input reaches page', wait_until(lambda: covered.page(run)['value'] == nonce))
        fresh = c.call('get_app_state', **common)
        web = int(re.search(r'\[(\d+)\] WebArea', fresh['text'])[1])
        c.call('scroll', app=f'pid:{pid}', element_index=web, direction='down', pages=1)
        check('wheel input reaches occluded renderer', wait_until(lambda: covered.page(run)['scrollY'] > 0), covered.page(run))
        c.call('scroll', app=f'pid:{pid}', element_index=web, direction='up', pages=1)
        # Wait across a lease renewal, so a long tool cannot silently freeze.
        timer = threading.Timer(12, lambda: covered.command(run, later='WAIT-' + nonce[:6])); timer.start()
        waited = c.call('wait_for', app=f'pid:{pid}', window=str(window), text='WAIT-' + nonce[:6], timeout=20, rpc_timeout=28)
        timer.join()
        check('long wait renews rendering and sees later text', not waited['is_error'])
        # expect uses its own observation loop: it must renew the same lease
        # even after the original ten-second confirmation has expired.
        marker = 'VERIFIED-' + nonce[:6]
        frames = covered.page(run)['frames']
        timer = threading.Timer(12, lambda: covered.command(run, later=marker)); timer.start()
        verified = c.call('click', app=f'pid:{pid}', target={'role': 'button', 'name': 'Increment'},
                          expect={'text': marker, 'timeout': 20}, rpc_timeout=30, allow_error=True)
        timer.join()
        check('long action verification renews rendering and sees later text',
              not verified['is_error'] and verified['structured']['verification']['status'] == 'verified'
              and covered.page(run)['clicks'] == 2 and covered.page(run)['frames'] > frames, verified['text'])
        second = client('second-client')
        second.call('get_app_state', **common)
        c.close(); clients.remove(c)
        second.close(); clients.remove(second)
        check('original true policy restores after both clients disconnect',
              wait_until(lambda: state()['windows'][0]['throttling'] is True, timeout=18), state())
        check('window bounds and sibling state are unchanged', [w['bounds'] for w in state()['windows']] == [w['bounds'] for w in before['windows']]
              and state()['windows'][1]['throttling'] is True and covered.page(run + '-sibling')['clicks'] == 0)
        # Exercise an existing inspector on a random port; never close it.
        command(occluded=True, openInspector=True)
        require(wait_until(lambda: state()['inspector']), 'Existing inspector did not open.')
        require(wait_until(lambda: covered.page(run)['visibility'] == 'hidden'), 'Repeated occlusion failed.')
        third = client('existing-inspector')
        again = third.call('get_app_state', **common)
        check('repeat recovery works with a pre-existing inspector', 'Background rendering:' in again['text'] and state()['inspector'])
        third.close(); clients.remove(third)
        check('pre-existing inspector survives lease cleanup', wait_until(lambda: state()['windows'][0]['throttling'] is True, timeout=18) and state()['inspector'])
        command(throttling=False)
        require(wait_until(lambda: state()['windows'][0]['throttling'] is False), 'Could not set original false policy.')
        fourth = client('original-false')
        fourth.call('get_app_state', **common)
        fourth.close(); clients.remove(fourth)
        time.sleep(16)
        check('original false policy remains false', state()['windows'][0]['throttling'] is False)
        command(throttling=True, closeInspector=True, stalledFrames=True)
        require(wait_until(lambda: not state()['inspector'] and state()['windows'][0]['throttling']), 'Could not prepare failed-frame case.')
        fifth = client('failed-frame')
        invalid = fifth.call('get_app_state', app=f'pid:{pid}', window='4294967294', allow_error=True)
        check('unknown window opens no inspector', invalid['is_error'] and not state()['inspector'])
        stalled = fifth.call('get_app_state', **common)
        check('missing frames retain uncertainty and restore original policy',
              'live rendering could not be confirmed' in stalled['text'] and state()['windows'][0]['throttling'] is True)
        check('failed recovery closes its temporary inspector', wait_until(lambda: not state()['inspector'], timeout=3))
    finally:
        for c in clients: c.close()
        if pid:
            command(quit=True)
            exited = bool(wait_until(lambda: subprocess.run(['kill', '-0', str(pid)], capture_output=True).returncode != 0, timeout=5))
            checks.append({'check': 'fixture exits normally after inspector cleanup', 'ok': exited})
            if not exited:
                subprocess.run(['kill', '-KILL', str(pid)], capture_output=True)
        if fixture: fixture.stop()
        if server: server.terminate(); server.wait()
        watch.terminate(); watch.wait(); watch_output.close()
        samples = [json.loads(line) for line in (directory / 'focus.jsonl').read_text().splitlines()]
        targets = {pid, fixture.pid if fixture else None}
        disturbed = [s for s in samples if s['frontPID'] in targets or s['topPID'] in targets]
        checks.append({'check': 'no test focus, top window or screen lock', 'ok': bool(samples) and not disturbed and not any(s['locked'] for s in samples),
                       'samples': len(samples), 'violations': disturbed})
        checks.append({'check': 'tested binary did not change during the run',
                       'ok': binary.exists() and hashlib.sha256(binary.read_bytes()).hexdigest() == fingerprint})
        summary = {'occlusion_source': 'test-only AppKit state override and native notification', 'checks': checks,
                   'binary': str(binary), 'binary_sha256': fingerprint, 'directory': str(directory)}
        (directory / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    require(all(c['ok'] for c in checks), 'Regression failed; inspect summary.json')
    print(f'PASS {directory} ({len(checks)}/{len(checks)})', flush=True)


if __name__ == '__main__':
    main()
