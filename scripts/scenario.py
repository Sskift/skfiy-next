#!/usr/bin/env python3
"""Shared harness for the capability tests: the dedicated scenario app
(scripts/fixtures/ScenarioFixture.swift), an MCP session in the mode the Mac
is in (direct while locked), lock-state sampling, and the window guard that
keeps test windows under the user's.

    from scenario import Session
    with Session('wait') as s:
        s.fixture.command('text', value='READY', after=3)
        result = s.call('wait_for', app=s.app, text='READY')

Nothing here locks or unlocks the Mac, activates an app, or touches the
user's own windows; evidence goes to eval/results/<name>-<time>-<nonce>/.
"""
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import threading
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_locked import Client, Evidence, ROOT, require  # noqa: E402,F401

BIN = Path('/tmp/skfiy-compat/bin')
SOURCES = {'AXProbe': 'scripts/fixtures/AXProbe.swift', 'Launch': 'scripts/fixtures/Launch.swift',
           'WindowGuard': 'scripts/fixtures/WindowGuard.swift', 'ScenarioFixture': 'scripts/fixtures/ScenarioFixture.swift',
           'VirtualDisplay': ('scripts/fixtures/VirtualDisplay.swift', 'scripts/fixtures/VirtualDisplay.h')}


def tool(name):
    """A helper binary, rebuilt when its source (or Objective-C header) is newer."""
    BIN.mkdir(parents=True, exist_ok=True)
    sources = SOURCES[name] if isinstance(SOURCES[name], tuple) else (SOURCES[name],)
    binary, paths = BIN / name, [ROOT / source for source in sources]
    if not binary.exists() or binary.stat().st_mtime < max(path.stat().st_mtime for path in paths):
        headers = [argument for path in paths[1:] for argument in ('-import-objc-header', str(path))]
        subprocess.run(['/usr/bin/swiftc', '-O', *headers, str(paths[0]), '-o', str(binary)], check=True, capture_output=True, timeout=300)
    return binary


def probe(*args):
    return json.loads(subprocess.run([str(tool('AXProbe')), *map(str, args)], capture_output=True, text=True, timeout=20, check=True).stdout)


def wait_until(check, timeout=8, interval=0.1):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        try:
            value = check()
        except (OSError, ValueError, KeyError):
            value = None
        if value:
            return value
        time.sleep(interval)
    return value


OCR_LINE = re.compile(r'^\s*("(?:[^"\\]|\\.)*")\s+x=(-?[\d.]+)\s+y=(-?[\d.]+)')


def ocr_lines(text):
    return [(json.loads(m[1]), float(m[2]), float(m[3])) for line in text.splitlines() if (m := OCR_LINE.match(line))]


def ocr_find(text, needle):
    hits = [hit for hit in ocr_lines(text) if needle.casefold() in hit[0].casefold()]
    return min(hits, key=lambda hit: (hit[2], hit[1])) if hits else None


def capabilities(result):
    """The JSON part of a get_app_capabilities result."""
    line = next(line for line in result['text'].splitlines() if line.startswith('JSON: '))
    return json.loads(line[6:])


class Fixture:
    def __init__(self, directory, nonce):
        self.directory = directory
        self.nonce = nonce
        self.name = f'SkfiyScenario-{nonce}'
        self.next_id = 0
        self.process = None
        app = directory / f'{self.name}.app'
        macos = app / 'Contents/MacOS'
        macos.mkdir(parents=True)
        with (app / 'Contents/Info.plist').open('wb') as handle:
            plistlib.dump({'CFBundleIdentifier': f'com.skfiy.scenario.{nonce}', 'CFBundleName': self.name,
                           'CFBundleExecutable': 'ScenarioFixture', 'CFBundlePackageType': 'APPL',
                           'NSPrincipalClass': 'NSApplication', 'LSUIElement': True, 'NSAppSleepDisabled': True}, handle)
        (macos / 'ScenarioFixture').write_bytes(tool('ScenarioFixture').read_bytes())
        (macos / 'ScenarioFixture').chmod(0o755)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(app)], check=True, capture_output=True)
        self.app = app
        (directory / 'control.jsonl').touch()

    def launch(self):
        # Started directly, as scripts/fixtures/LockedFixture is: launched through
        # LaunchServices, a background app's timers stall under the lock screen.
        self.process = subprocess.Popen([str(self.app / 'Contents/MacOS/ScenarioFixture'), '--dir', str(self.directory),
                                         '--nonce', self.nonce], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=(self.directory / 'stderr.txt').open('w'), start_new_session=True)
        self.pid = self.process.pid
        require(wait_until(lambda: self.state()['pid'] == self.pid, timeout=10), 'the scenario app did not start')
        return self

    def state(self):
        return json.loads((self.directory / 'state.json').read_text())

    def command(self, op, wait=True, **arguments):
        self.next_id += 1
        with (self.directory / 'control.jsonl').open('a') as handle:
            handle.write(json.dumps({'id': self.next_id, 'op': op, **arguments}) + '\n')
        if wait:
            command_id = self.next_id
            require(wait_until(lambda: self.state()['lastCommand'] >= command_id, timeout=5), f'the scenario app did not apply {op}')
        return self.next_id

    def wait(self, predicate, timeout=8):
        return wait_until(lambda: predicate(self.state()), timeout=timeout)

    def stop(self):
        try:
            self.command('quit', wait=False)
            wait_until(lambda: subprocess.run(['kill', '-0', str(self.pid)], capture_output=True).returncode != 0, timeout=3)
        finally:
            subprocess.run(['kill', '-9', str(self.pid)], capture_output=True)


class Session:
    """One test run: evidence, the fixture, an MCP client in the mode matching the lock state."""

    def __init__(self, name, direct=None, fixture=True, environment=None):
        self.nonce = uuid.uuid4().hex[:10]
        self.session_at_start = probe('session')
        self.locked = self.session_at_start['locked']
        self.mode = 'locked' if self.locked else 'unlocked'
        self.directory = ROOT / 'eval/results' / f'{name}-{self.mode}-{time.strftime("%Y%m%d-%H%M%S")}-{self.nonce}'
        self.directory.mkdir(parents=True, mode=0o700)
        self.evidence = Evidence(self.directory)
        self.direct = self.locked if direct is None else direct
        self.environment = {**({'SKFIY_LOCKED_USE': 'direct'} if self.direct else {}), 'SKFIY_SETTLE_SECONDS': '0.4', **(environment or {})}
        self.want_fixture = fixture
        self.checks = []
        self.samples = []
        self.summary = {'name': name, 'nonce': self.nonce, 'mode': self.mode, 'direct': self.direct,
                        'sessionAtStart': self.session_at_start, 'checks': self.checks}

    def __enter__(self):
        self.sampling = True
        self.sampler = threading.Thread(target=self._sample, daemon=True)
        self.sampler.start()
        self.guard = None
        if not self.locked:
            self.guard_log = (self.directory / 'window-guard.jsonl').open('w')
            self.guard = subprocess.Popen([str(tool('WindowGuard')), f'SkfiyScenario-{self.nonce}', 'TextEdit', 'Preview',
                                           'Google Chrome for Testing', 'Electron'], stdout=self.guard_log, stderr=subprocess.DEVNULL)
        self.fixture = None
        if self.want_fixture:
            fixture_dir = self.directory / 'fixture'
            fixture_dir.mkdir()
            self.fixture = Fixture(fixture_dir, self.nonce).launch()
            self.app = self.fixture.name
        self.client = Client(self.binary, self.evidence, environment=self.environment, name='skfiy-scenario')
        return self

    binary = None  # set by main()

    def _sample(self):
        while self.sampling:
            try:
                self.samples.append(probe('session'))
            except Exception as error:  # an unknown sample, kept as such
                self.samples.append({'known': False, 'error': str(error)})
            time.sleep(0.25)

    def call(self, tool_name, rpc_timeout=90, **arguments):
        # Not `timeout`: wait_for and others take a timeout argument of their own.
        return self.client.call(tool_name, allow_error=True, rpc_timeout=rpc_timeout, **arguments)

    def check(self, name, condition, detail=''):
        row = {'check': name, 'ok': bool(condition), 'detail': str(detail)[:800]}
        self.checks.append(row)
        self.evidence.record('check', **row)
        print(f"  {'ok ' if condition else 'FAIL'} {name}: {str(detail)[:160]}", flush=True)
        return bool(condition)

    def __exit__(self, kind, error, trace):
        if error:
            self.summary['error'] = f'{kind.__name__}: {error}'
            print(f'  ERROR {kind.__name__}: {error}', flush=True)
        try:
            self.client.close()
        finally:
            if self.fixture:
                self.summary['fixtureFinal'] = self.fixture.state()
                self.fixture.stop()
            self.sampling = False
            self.sampler.join(timeout=2)
            if self.guard:
                self.guard.terminate()
                self.guard.wait(timeout=3)
                self.guard_log.close()
                self.summary['windowGuardCorrections'] = len((self.directory / 'window-guard.jsonl').read_text().splitlines())
            locked = [s for s in self.samples if s.get('locked')]
            self.summary['lockSamples'] = {'count': len(self.samples), 'locked': len(locked),
                                           'unknown': sum(1 for s in self.samples if not s.get('known')),
                                           'displayAsleep': sum(1 for s in self.samples if s.get('displayAsleep'))}
            self.summary['ok'] = not error and all(c['ok'] for c in self.checks) and (
                len(locked) == len(self.samples) if self.locked else not locked)
            self.summary['finished'] = time.time()
            (self.directory / 'summary.json').write_text(json.dumps(self.summary, indent=2, ensure_ascii=False) + '\n')
            print(f"{'PASS' if self.summary['ok'] else 'FAIL'} {self.directory.relative_to(ROOT)} "
                  f"({sum(c['ok'] for c in self.checks)}/{len(self.checks)} checks; lock samples {self.summary['lockSamples']})", flush=True)
        return True  # the summary records the error


def main_binary():
    require(len(sys.argv) > 1, 'pass the skfiy binary')
    binary = Path(sys.argv[1]).resolve()
    require(binary.exists(), f'{binary} does not exist')
    Session.binary = binary
    return binary
