#!/usr/bin/env python3
"""SSH desktop acceptance using a disposable Windows fixture and independent receipts.

python3 scripts/test_remote_desktop.py .build/debug/skfiy --host lil-win --ssh lil-win --accept

Deploys/opens only its own test form on Windows; Mac focus/windows are sampled,
never restored or raised. No user documents, credentials, screen images or
remote screen text are retained. Removes the fixture/task on exit.
"""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from harness import Client, ROOT
from scenario import probe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--host', required=True)
    parser.add_argument('--ssh', required=True)
    parser.add_argument('--accept', action='store_true')
    args = parser.parse_args()
    if not args.accept:
        parser.error('--accept confirms opening a disposable test window on the remote desktop')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*', args.ssh):
        parser.error('use an SSH host alias')
    nonce = uuid.uuid4().hex
    directory = ROOT / 'eval/results' / ('remote-desktop-' + time.strftime('%Y%m%d-%H%M%S-') + nonce[:10])
    directory.mkdir(parents=True)
    checks, samples, latencies = [], [], []
    stop = threading.Event()
    def sample():
        while not stop.is_set():
            try:
                samples.append(probe('front'))
            except Exception:
                samples.append({})
            stop.wait(0.1)
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()

    def check(name, passed, fatal=False):
        checks.append({'check': name, 'ok': bool(passed)})
        print(('ok  ' if passed else 'FAIL ') + name, flush=True)
        if not passed and fatal:
            raise AssertionError(name)

    def ssh(script, input_text=None):
        prefix = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';"
        prefix += "$root=Join-Path $env:LOCALAPPDATA 'skfiy\\test-" + nonce + "';$task='SkfiyTest-" + nonce + "';"
        encoded = base64.b64encode((prefix + script).encode('utf-16le')).decode()
        result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', args.ssh,
                                 'powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded], capture_output=True, input=input_text.encode() if input_text else None, timeout=30)
        if result.returncode:
            raise RuntimeError('Fixture SSH command failed: ' + result.stderr.decode('utf-8', errors='replace')[:300])
        return result.stdout.decode('utf-8-sig').strip()

    fixture_source = (ROOT / 'scripts/fixtures/RemoteDesktopFixture.ps1').read_bytes()
    encoded_fixture = base64.b64encode(fixture_source).decode()
    client = None
    error = None
    try:
        ssh("[IO.Directory]::CreateDirectory($root)|Out-Null;$file=Join-Path $root 'fixture.ps1';[IO.File]::WriteAllBytes($file,[Convert]::FromBase64String([Console]::In.ReadLine()));"
            "$exe=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';"
            "$a=New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"'+$file+'\" -Root \"'+$root+'\"');"
            "$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;"
            "Register-ScheduledTask -TaskName $task -Action $a -Principal $p -Force|Out-Null;Start-ScheduledTask -TaskName $task;exit 0", encoded_fixture + "\n")
        def receipt():
            return json.loads(ssh("[IO.File]::ReadAllText((Join-Path $root 'state.json'));exit 0"))
        deadline = time.monotonic() + 20
        while True:
            try:
                initial = receipt()
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.5)
        check('fixture is in an interactive Windows session', initial['session'] > 0, fatal=True)
        client = Client(Path(args.binary).resolve(), env={'SKFIY_CURSOR': '0', 'SKFIY_ACTION_LOG': 'off'})
        frame = None
        size = None
        def call(action, **params):
            nonlocal frame, size
            started = time.monotonic()
            result = client.call('remote_desktop', host=args.host, action=action,
                                 **({} if action == 'state' else {'frame_id': frame}), **params, rpc_timeout=45)
            latencies.append({'action': action, 'seconds': round(time.monotonic() - started, 3)})
            frame = re.search(r'frame_id: ([a-f0-9]{32})', result['text']).group(1)
            size = tuple(map(int, re.search(r'Screenshot: (\d+)×(\d+)', result['text']).groups()))
            return result
        def point(control, dx=15, dy=15):
            rect = initial[control]
            desktop = initial['desktop']
            return {'x': round((rect['x'] + dx - desktop['x']) * size[0] / desktop['width']),
                    'y': round((rect['y'] + dy - desktop['y']) * size[1] / desktop['height'])}
        state = call('state')
        check('remote screenshot is returned', bool(state['images']) and 'Skfiy remote input test' in state['text'], fatal=True)
        call('click', **point('field'))
        marker = 'Skfiy 中文 A!9 😀'
        typed = call('type', text=marker)
        check('Unicode, spaces and punctuation arrive unchanged', receipt()['text'] == marker)
        with tempfile.TemporaryDirectory(prefix='skfiy-remote-ocr-') as temp:
            image = Path(temp) / 'state.jpg'
            image.write_bytes(typed['images'][0])
            recognized = probe('ocr', str(image))
            check('independent OCR sees the test marker in the remote screenshot', 'Skfiy' in json.dumps(recognized, ensure_ascii=False))
        call('key', key='ctrl+a')
        selected = receipt()
        check('Ctrl+A selects the entire Unicode text', selected['selectionStart'] == 0 and selected['selectionLength'] == len(marker.encode('utf-16le')) // 2)
        call('type', text='replaced')
        call('key', key='backspace')
        edited = receipt()
        check('Windows shortcut, replacement and Backspace reach the field', edited['text'] == 'replace')
        call('key', key='shift+left')
        call('type', text='X')
        check('extended arrow key with Shift selects text for replacement', receipt()['text'] == 'replacX')
        call('click', **point('button'))
        check('button receives exactly one click', receipt()['clicks'] == 1)
        call('click', button='right', **point('canvas'))
        check('right click reaches the remote canvas', receipt()['right'] == 1)
        call('click', count=2, **point('canvas'))
        check('double click reaches the remote canvas', receipt()['double'] >= 1)
        start, end = point('canvas', 40, 80), point('canvas', 180, 120)
        call('drag', **start, to_x=end['x'], to_y=end['y'])
        check('remote canvas receives the drag', receipt()['drag'])
        call('click', **point('scrollArea', 50, 70))
        call('scroll', direction='down', amount=3, **point('scrollArea', 50, 70))
        scrolled = receipt()
        check('wheel input actually scrolls remote content', scrolled['scroll'] > 0)
        old = frame
        call('click', **point('button'))
        rejected = client.call('remote_desktop', host=args.host, action='click', frame_id=old, **point('button'), allow_error=True, rpc_timeout=45)
        check('consumed frame cannot duplicate a click', rejected['is_error'] and receipt()['clicks'] == 2)
        call('state')
        invalid = client.call('remote_desktop', host=args.host, action='click', frame_id=frame, x=size[0], y=0, allow_error=True, rpc_timeout=45)
        check('out-of-image coordinates are refused', invalid['is_error'] and receipt()['clicks'] == 2)
        call('state')
        print('Waiting for the frame to expire (31 seconds)...', flush=True)
        time.sleep(31)
        expired = client.call('remote_desktop', host=args.host, action='click', frame_id=frame, **point('button'), allow_error=True, rpc_timeout=45)
        check('expired screenshot cannot send input', expired['is_error'] and receipt()['clicks'] == 2)
    except Exception as failure:
        error = str(failure)
        print('ERROR ' + error, flush=True)
    finally:
        if client:
            client.close()
        try:
            ssh("if(Test-Path $root){[IO.File]::WriteAllText((Join-Path $root 'stop'),'');Start-Sleep -Milliseconds 400};Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue;Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue;exit 0")
        except Exception as cleanup_error:
            error = error or str(cleanup_error)
        stop.set()
        sampler.join(timeout=3)
        rustdesk = sum('RustDesk' in str(row.get('front')) or 'RustDesk' in str(row.get('topOwner')) for row in samples)
        unknown = sum(not row for row in samples)
        # User switching between their own apps is reported, never corrected.
        transitions = sum(a.get('frontPID') != b.get('frontPID') or a.get('topWindow') != b.get('topWindow') for a, b in zip(samples, samples[1:]))
        checks.append({'check': 'RustDesk never gained Mac focus or became the top window', 'ok': bool(samples) and rustdesk == 0 and unknown == 0})
        report = {'ok': error is None and all(row['ok'] for row in checks), 'checks': checks, 'error': error,
                  'macSamples': len(samples), 'rustdeskInFrontOrOnTop': rustdesk, 'unknownSamples': unknown, 'macFrontOrTopTransitions': transitions,
                  'macFrontApps': sorted(set(row.get('front', '?') for row in samples)), 'latencies': latencies}
        (directory / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(report, ensure_ascii=False), flush=True)
        print(directory, flush=True)
    if not report['ok']:
        sys.exit(1)


if __name__ == '__main__':
    main()
