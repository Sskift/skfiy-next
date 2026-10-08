#!/usr/bin/env python3
"""Independent fixture-only test of direct APIs while macOS stays truly locked.

Default/--prepare only compiles and type-checks; --lock launches its isolated
fixture, proves an unlocked baseline, locks once, tests and finishes locked.
--already-locked starts and stays locked, without an unlocked baseline; failures
are inconclusive_without_unlocked_baseline and this is not full E2E acceptance.
It never asks an authorization plugin to unlock, targets loginwindow, submits
Return/password input, changes authdb, or changes the product's safety gates.
Each capability is supported/refused from fixture journal + screenshot evidence.
Any observed unlock/unknown state after the confirmed lock invalidates the run.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
SKFIY_PLUGINS = (
    Path('/Library/Security/SecurityAgentPlugins/SkfiyLockedUse.bundle'),
    Path('/Library/Security/SecurityAgentPlugins/SkfiyLockedUseAuthorization.bundle'),
)
SKFIY_RIGHTS = {'com.skfiy.locked-use.remote', 'io.github.sskift.skfiy.locked-use'}


def execute(*args, timeout=20):
    return subprocess.run([str(x) for x in args], capture_output=True, text=True, timeout=timeout)


def checked(*args, timeout=90):
    result = execute(*args, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result.stdout


def read(path):
    return json.loads(path.read_text())


def wait(check, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(.05)
    return None


def prepare(directory, nonce):
    probe = directory / 'LockedDirectProbe'
    checked('/usr/bin/swiftc', '-O', ROOT / 'scripts/fixtures/LockedDirectProbe.swift', '-o', probe)
    app = directory / f'SkfiyLockedFixture-{nonce}.app'
    macos = app / 'Contents/MacOS'
    macos.mkdir(parents=True)
    with (app / 'Contents/Info.plist').open('wb') as output:
        plistlib.dump({'CFBundleIdentifier': f'com.skfiy.lockedfixture.{nonce}',
                      'CFBundleName': f'SkfiyLockedFixture-{nonce}', 'CFBundleExecutable': 'LockedFixture',
                      'CFBundlePackageType': 'APPL', 'NSPrincipalClass': 'NSApplication', 'LSUIElement': True}, output)
    fixture = macos / 'LockedFixture'
    checked('/usr/bin/swiftc', '-O', ROOT / 'scripts/fixtures/LockedFixture.swift', '-o', fixture)
    checked('/usr/bin/codesign', '--force', '--sign', '-', app)
    checked('/usr/bin/codesign', '--force', '--sign', '-', probe)
    return probe, fixture


def no_custom_authorization():
    result = execute('/usr/bin/security', 'authorizationdb', 'read', 'system.login.screensaver')
    if result.returncode:
        raise RuntimeError('Cannot inspect screen-unlock authorization rule')
    policy = plistlib.loads(result.stdout.encode())
    if not isinstance(policy, dict):
        raise RuntimeError('Screen-unlock authorization policy is not a dictionary')
    rules = policy.get('rule', [])
    if isinstance(rules, str):
        rules = [rules]
    if not isinstance(rules, list) or any(not isinstance(rule, str) for rule in rules):
        raise RuntimeError('Screen-unlock authorization rule has an unknown structure')
    mechanisms = policy.get('mechanisms', [])
    if not isinstance(mechanisms, list) or any(not isinstance(mechanism, str) for mechanism in mechanisms):
        raise RuntimeError('Screen-unlock authorization mechanisms have an unknown structure')
    installed = [str(plugin) for plugin in SKFIY_PLUGINS if plugin.exists() or plugin.is_symlink()]
    active_rules = sorted(SKFIY_RIGHTS.intersection(rules))
    active_mechanisms = [m for m in mechanisms if m.split(':', 1)[0] in
                         {'SkfiyLockedUse', 'SkfiyLockedUseAuthorization'}]
    if installed or active_rules or active_mechanisms:
        raise RuntimeError('Uninstall the custom skfiy authorization plugin before this independent diagnostic: '
                           + str({'plugins': installed, 'rules': active_rules, 'mechanisms': active_mechanisms}))
    return {'ownPluginAbsent': True, 'checkedPlugins': [str(plugin) for plugin in SKFIY_PLUGINS],
            'checkedRights': sorted(SKFIY_RIGHTS), 'screenRules': rules}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--lock', action='store_true', help='Run GUI baseline and real lock test; ends locked')
    mode.add_argument('--already-locked', action='store_true', help='Probe while already locked; no lock/unlock and no unlocked baseline')
    mode.add_argument('--prepare', action='store_true', help='Only compile helpers (default)')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    nonce = uuid.uuid4().hex[:12]
    directory = (args.output or ROOT / 'eval/results' / ('locked-direct-' + time.strftime('%Y%m%d-%H%M%S') + '-' + nonce[:4])).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    summary = {'schema': 1, 'fixtureNonce': nonce, 'directory': str(directory),
               'actualLockTestRun': False, 'complete': False, 'baselineTested': False,
               'fullEndToEndAcceptance': False, 'mode': 'already-locked' if args.already_locked else 'lock-with-baseline' if args.lock else 'prepare',
               'lockRequested': False, 'capabilities': {}}
    (directory / 'diagnostic-source.py').write_text(Path(__file__).read_text())
    (directory / 'probe-source.swift').write_text((ROOT / 'scripts/fixtures/LockedDirectProbe.swift').read_text())
    state_path = directory / 'fixture-state.json'
    fixture_proc = watch = None
    lock_start = None
    samples = []
    events_file = (directory / 'operations.jsonl').open('w', buffering=1)
    watch_file = (directory / 'lock-samples.jsonl').open('w', buffering=1)
    fixture_stderr = (directory / 'fixture.stderr').open('w')
    watch_stderr = (directory / 'watch.stderr').open('w')
    try:
        probe, fixture = prepare(directory, nonce)
        summary['prepared'] = {'probe': str(probe), 'fixture': str(fixture)}
        if not args.lock and not args.already_locked:
            summary['preparationComplete'] = True
            return
        summary['authorization'] = no_custom_authorization()

        def op(mode, value=None):
            if args.already_locked and mode == 'lock':
                raise RuntimeError('--already-locked never invokes an OS lock or unlock action')
            if args.already_locked and mode != 'sample' and samples and any(not s.get('known') or not s.get('locked') for s in samples):
                raise RuntimeError('Already-locked run contaminated by observed unlocked/unknown state; further fixture actions stopped')
            command = [probe, mode]
            if mode not in ('sample', 'lock'):
                command += [state_path, fixture, nonce]
                if value is not None:
                    command += [value]
            started = time.time()
            try:
                result = execute(*command, timeout=15)
                try:
                    data = json.loads(result.stdout)
                except ValueError:
                    data = {'error': 'No JSON result', 'stdout': result.stdout}
                data.update(returncode=result.returncode, stderr=result.stderr)
            except subprocess.TimeoutExpired:
                data = {'error': 'Probe process timed out and was killed', 'returncode': -1}
            data.update(mode=mode, started=started, finished=time.time())
            events_file.write(json.dumps(data, ensure_ascii=False) + '\n')
            return data

        initial = op('sample')
        summary['initial'] = initial
        if not initial.get('known'):
            raise RuntimeError('Initial OS lock state is unknown')
        if args.already_locked:
            if not initial.get('locked'):
                raise RuntimeError('--already-locked requires the desktop to be truly locked at start')
            lock_start = initial['timestamp']
            summary['baselineNote'] = 'No unlocked baseline: success requires actual fixture evidence; failure remains inconclusive'
        elif initial.get('locked'):
            raise RuntimeError('Start --lock with the desktop manually unlocked; use --already-locked for a limited diagnostic')
        if not initial.get('axTrusted') or not initial.get('screenCapture'):
            raise RuntimeError('Test host requires Accessibility and Screen Recording before diagnostic')
        watch = subprocess.Popen([str(probe), 'watch'], stdout=subprocess.PIPE, stderr=watch_stderr, text=True, bufsize=1)
        def collect():
            for line in watch.stdout:
                watch_file.write(line)
                try:
                    samples.append(json.loads(line))
                except ValueError:
                    pass
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        if args.already_locked:
            first_watch = wait(lambda: samples[0] if samples else None, timeout=3)
            if not first_watch or not first_watch.get('known') or not first_watch.get('locked'):
                raise RuntimeError('Independent monitor did not confirm the already-locked starting state')
            summary['actualLockTestRun'] = True
        fixture_proc = subprocess.Popen([str(fixture), '--journal', str(state_path), '--nonce', nonce, '--lifetime', '300'], stderr=fixture_stderr)
        if not wait(lambda: state_path.exists() and read(state_path).get('event') == 'ready'):
            if not state_path.exists():
                raise RuntimeError('Fixture did not become ready')
        fixture_pid = read(state_path).get('pid')
        if fixture_pid != fixture_proc.pid:
            raise RuntimeError('Fixture PID does not belong to this run')

        def phase(label):
            results = {}
            before = read(state_path)
            value = label.upper() + nonce.upper()
            ax_read = op('ax-read')
            results['ax_read'] = {'status': 'supported' if ax_read.get('readCode') == 0 and ax_read.get('value') == before['input_value'] else 'refused', 'api': ax_read}
            response = op('ax-write-press', value)
            observed = wait(lambda: (s := read(state_path)) and s['commit_count'] > before['commit_count'] and s['committed_value'] == value and s, timeout=3)
            results['ax_set_and_press'] = {'status': 'supported' if response.get('setCode') == 0 and response.get('pressCode') == 0 and observed else 'refused', 'api': response, 'fixture': observed or read(state_path)}
            before = read(state_path)
            response = op('key')
            observed = wait(lambda: (s := read(state_path)) and s['key_down_count'] > before['key_down_count'] and s['last_key_code'] == 0 and s, timeout=3)
            results['post_to_pid_keyboard'] = {'status': 'supported' if observed else 'refused', 'api': response, 'fixture': observed or read(state_path)}
            before = read(state_path)
            response = op('mouse')
            observed = wait(lambda: (s := read(state_path)) and s['pointer_count'] > before['pointer_count'] and s['pointer_side'] == 'green' and s, timeout=3)
            results['post_to_pid_mouse'] = {'status': 'supported' if observed else 'refused', 'api': response, 'fixture': observed or read(state_path)}
            captures = []
            for index in range(2):
                path = directory / f'{label}-capture-{index}.png'
                captured = op('capture', path)
                captured['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
                captured['fixtureAfter'] = read(state_path)
                captures.append(captured)
                if not index:
                    time.sleep(.8)
            def screenshot_evidence(capture):
                lines = capture.get('lines', [])
                text = re.sub(r'[^A-Z0-9]', '', '\n'.join(lines).upper())
                ticks = [int(m.group(1)) for line in lines if (m := re.search(r'frame\s+(\d+)', line, re.I))]
                current = capture['fixtureAfter']['tick']
                return capture.get('returncode') == 0 and nonce.upper() in text and ticks and 0 <= current - max(ticks) <= 20
            supported = (all(screenshot_evidence(c) for c in captures)
                         and captures[0]['sha256'] != captures[1]['sha256'])
            results['desktop_independent_window_capture'] = {'status': 'supported' if supported else 'refused', 'captures': captures}
            if args.already_locked:
                for result in results.values():
                    if result['status'] != 'supported':
                        result['status'] = 'inconclusive_without_unlocked_baseline'
            summary['capabilities'][label] = results
            return results

        if not args.already_locked:
            baseline = phase('baseline')
            summary['baselineTested'] = True
            failed = [name for name, result in baseline.items() if result['status'] != 'supported']
            if failed:
                raise RuntimeError('Unlocked baseline failed; no lock performed: ' + ', '.join(failed))
            summary['lockRequested'] = True
            summary['lockRequest'] = op('lock')
            locked = wait(lambda: samples[-1] if samples and samples[-1].get('known') and samples[-1].get('locked') else None, timeout=8)
            if not locked:
                raise RuntimeError('OS lock could not be confirmed')
            lock_start = locked['timestamp']
            summary['actualLockTestRun'] = True
            # Allow lock UI transition to settle without sending any input to it.
            time.sleep(.7)
        phase('locked')
        summary['final'] = op('sample')
        summary['complete'] = True
    except Exception as error:
        summary['error'] = str(error)
    finally:
        if fixture_proc:
            fixture_proc.terminate()
            try:
                fixture_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                fixture_proc.kill(); fixture_proc.wait()
        if lock_start is not None:
            time.sleep(.2)
            interval = [s for s in samples if s.get('timestamp', 0) >= lock_start]
            bad = [s for s in interval if not s.get('known') or not s.get('locked')]
            gaps = [b['uptime'] - a['uptime'] for a, b in zip(interval, interval[1:])]
            journal_path = Path(str(state_path) + '.jsonl')
            fixture_rows = [json.loads(line) for line in journal_path.read_text().splitlines()] if journal_path.exists() else []
            fixture_rows = [row for row in fixture_rows if row['timestamp'] >= lock_start]
            invalid_fixture = [row for row in fixture_rows if not row.get('screen_lock_known') or not row.get('screen_locked')]
            monitor_live = watch is not None and watch.poll() is None and bool(interval) and time.time() - interval[-1]['timestamp'] < .3
            continuous = monitor_live and not bad and bool(fixture_rows) and not invalid_fixture and len(gaps) >= 10 and max(gaps) < .5
            summary['lockEvidence'] = {'startTimestamp': lock_start, 'sampleCount': len(interval),
                'maxSampleGapSeconds': max(gaps) if gaps else None, 'monitorLiveAtEnd': monitor_live, 'invalidSamples': bad,
                'invalidFixtureRows': invalid_fixture, 'fixtureSampleCount': len(fixture_rows),
                'continuouslyObservedLocked': continuous,
                'qualification': '50 ms sampling plus fixture event observations; no finite sampler proves unsampled intervals'}
            summary['fixtureCapabilitiesObservedWhileLocked'] = ([name for name, result in summary['capabilities'].get('locked', {}).items()
                if result['status'] == 'supported'] if continuous else [])
            summary['provesDirectLockedSupport'] = (summary['baselineTested'] and summary['complete'] and continuous and
                all(r['status'] == 'supported' for r in summary['capabilities'].get('locked', {}).values()))
        if watch:
            watch.terminate()
            try:
                watch.wait(timeout=3)
            except subprocess.TimeoutExpired:
                watch.kill(); watch.wait()
        for output in (events_file, watch_file, fixture_stderr, watch_stderr):
            output.close()
        (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
