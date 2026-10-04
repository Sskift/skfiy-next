#!/usr/bin/env python3
"""Real-app compatibility baseline: screenshot, click, type, scroll and popup
in TextEdit, Preview, Finder, Chrome (app tools and the browser extension)
and an Electron app, each in three states:

  front       unlocked, the target app frontmost (needs --allow-front and an idle user)
  background  unlocked, the target app in the background; the user's front app must not change
  locked      macOS really locked, SKFIY_LOCKED_USE=direct

Every step works on files and pages this script creates (a temporary text
file, PDF, folder, and a local web page), and every result is checked
independently of skfiy: the AX/window-server probe (scripts/fixtures/AXProbe.swift),
or the page's own reports to the local server (scripts/compat_server.py).

    python3 scripts/compat_baseline.py .build/debug/skfiy --mode background
    python3 scripts/compat_baseline.py .build/debug/skfiy --mode locked        # only while locked
    python3 scripts/compat_baseline.py .build/debug/skfiy --mode front --allow-front
    python3 scripts/compat_baseline.py --report    # docs/compatibility.md from the latest runs

Statuses: pass (verified independently), fail (did not happen, or skfiy
errored), refused (skfiy declined by design, with its reason), untested (the
state or a precondition was not available), skipped (the harness would have
risked the user's own windows or data).
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_locked import Client, Evidence, ROOT, require  # noqa: E402

WORK = Path('/tmp/skfiy-compat')
PORT = 8766
OPS = ['screenshot', 'click', 'type', 'scroll', 'popup']
MODES = ['front', 'background', 'locked']
CASES = ['textedit', 'preview', 'finder', 'chrome', 'chrome-extension', 'electron']
RESULTS = ROOT / 'eval/results'
DOCS = ROOT / 'docs'
GUARDED = ['TextEdit', 'Preview', 'Finder', 'Google Chrome for Testing', 'Electron']
CFT_GLOB = 'chrome/*/chrome-mac-arm64/Google Chrome for Testing.app'
ELECTRON = Path.home() / '.cache/skfiy-test/electron/node_modules/electron/dist/Electron.app'


# ------------------------------------------------------------------ helpers

def sh(*args, timeout=60, check=True):
    return subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=timeout, check=check).stdout


def build_tools():
    """AXProbe, Launch and make_pdf, rebuilt when their source changed."""
    (WORK / 'bin').mkdir(parents=True, exist_ok=True)
    tools = {'AXProbe': ROOT / 'scripts/fixtures/AXProbe.swift', 'Launch': ROOT / 'scripts/fixtures/Launch.swift',
             'make_pdf': ROOT / 'eval/make_pdf.swift', 'Front': ROOT / 'scripts/fixtures/Front.swift',
             'WindowGuard': ROOT / 'scripts/fixtures/WindowGuard.swift'}
    for name, source in tools.items():
        binary = WORK / 'bin' / name
        if not binary.exists() or binary.stat().st_mtime < source.stat().st_mtime:
            sh('/usr/bin/swiftc', '-O', source, '-o', binary, timeout=180)
    return {name: WORK / 'bin' / name for name in tools}


TOOLS = {}


def probe(*args):
    return json.loads(sh(TOOLS['AXProbe'], *args, timeout=20))


def ensure_server():
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{PORT}/state?run=ping', timeout=1).read()
        return
    except OSError:
        pass
    (WORK / 'events').mkdir(parents=True, exist_ok=True)
    subprocess.Popen([sys.executable, str(ROOT / 'scripts/compat_server.py'), '--port', str(PORT),
                      '--root', str(ROOT / 'scripts/fixtures'), '--events', str(WORK / 'events')],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/state?run=ping', timeout=1).read()
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError('compat server did not start')


def page_state(run):
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/state?run={run}', timeout=3).read()).get('state', {})


def wait_until(check, timeout=6, interval=0.2):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        try:
            value = check()
        except Exception:  # a probe that cannot answer yet
            value = None
        if value:
            return value
        time.sleep(interval)
    return value


OCR_LINE = re.compile(r'^\s*("(?:[^"\\]|\\.)*")\s+x=(-?[\d.]+)\s+y=(-?[\d.]+)')


def ocr_lines(text):
    lines = []
    for line in text.splitlines():
        match = OCR_LINE.match(line)
        if match:
            lines.append((json.loads(match[1]), float(match[2]), float(match[3])))
    return lines


def ocr_find(text, needle):
    """Coordinates of the uppermost OCR line containing needle (case-insensitive)."""
    hits = [(label, x, y) for label, x, y in ocr_lines(text) if needle.casefold() in label.casefold()]
    return min(hits, key=lambda hit: (hit[2], hit[1])) if hits else None


def tree_index(text, pattern):
    for line in text.splitlines():
        if re.search(pattern, line):
            match = re.search(r'\[(\d+)\]', line)
            if match:
                return match.group(1)
    return None


def pids_of(name):
    out = sh('pgrep', '-x', name, check=False).split()
    return [int(pid) for pid in out]


# ------------------------------------------------------------------ harness

class Run:
    def __init__(self, binary, mode, evidence_dir, nonce):
        self.binary = binary
        self.mode = mode
        self.directory = evidence_dir
        self.nonce = nonce
        self.evidence = Evidence(evidence_dir)
        self.results = []
        self.client = None
        self.violations = []
        self.lock_samples = []
        self.sampling = True
        self.sampler = threading.Thread(target=self.sample_lock, daemon=True)
        self.sampler.start()
        # Test windows must never stay over the user's windows.
        self.guard_log = (evidence_dir / 'window-guard.jsonl').open('w')
        self.guard = subprocess.Popen([str(TOOLS['WindowGuard']), *GUARDED], stdout=self.guard_log,
                                      stderr=subprocess.DEVNULL) if mode != 'locked' else None

    def sample_lock(self):
        while self.sampling:
            try:
                self.lock_samples.append(probe('session'))
            except Exception as error:  # recorded as an unknown sample
                self.lock_samples.append({'known': False, 'error': str(error), 'timestamp': time.time()})
            time.sleep(0.25)

    def start_client(self):
        environment = {'SKFIY_LOCKED_USE': 'direct'} if self.mode == 'locked' else {}
        environment['SKFIY_SETTLE_SECONDS'] = '0.5'
        self.client = Client(self.binary, self.evidence, environment=environment, name='skfiy-compat-baseline')

    def call(self, tool, **arguments):
        """A tool call; in background mode, also checks that the front app stayed."""
        before = probe('front') if self.mode == 'background' else None
        started = time.monotonic()
        result = self.client.call(tool, allow_error=True, rpc_timeout=60, **arguments)
        result['seconds'] = round(time.monotonic() - started, 2)
        if before:
            after = probe('front')
            idle = probe('session')['idleSeconds']
            # Only count a change the user cannot have made during this call.
            if after['frontPID'] != before['frontPID'] and idle > result['seconds'] + 0.5:
                self.violations.append({'tool': tool, 'before': before, 'after': after})
                result['front_changed'] = True
        return result

    def record(self, case, op, status, detail, path='', seconds=None, extra=None):
        row = {'case': case, 'mode': self.mode, 'op': op, 'status': status, 'path': path,
               'detail': detail[:600], 'seconds': seconds}
        if extra:
            row.update(extra)
        self.results.append(row)
        self.evidence.record('result', **row)
        print(f'  {case:17} {op:10} {status:9} {path:12} {detail[:110]}', flush=True)
        return row

    def finish(self):
        self.sampling = False
        self.sampler.join(timeout=2)
        if self.client:
            self.client.close()
        if self.guard:
            time.sleep(0.5)
            self.guard.terminate()
            self.guard.wait(timeout=3)
        self.guard_log.close()
        lines = (self.directory / 'window-guard.jsonl').read_text().splitlines()
        return [json.loads(line) for line in lines if line.strip()]


def classify(result):
    """refused when skfiy declined by design, fail for other errors."""
    text = result['text']
    designed = ['unavailable while macOS remains locked', 'accepts screenshot coordinates only', 'cannot be verified while locked',
                'multiple or different active windows', 'is a terminal', 'hosting this agent', 'not opened in background',
                'would be drawn over the user', 'would draw', 'disabled while', 'is disabled', 'needs the app in front',
                'Clipboard shortcuts are unavailable']
    return 'refused' if any(phrase in text for phrase in designed) else 'fail'


class Case:
    """One app: prepare, five operations, cleanup. Subclasses fill in the ops."""
    key = ''
    app = ''

    def __init__(self, run):
        self.run = run
        self.nonce = run.nonce
        self.pid = None
        self.window = None
        self.last = None

    # Shared shapes ---------------------------------------------------------
    def precondition(self):
        return None

    def state(self, **extra):
        arguments = {'app': self.app, 'ocr': True, **extra}
        if self.window:
            arguments['window'] = self.window
        self.last = self.run.call('get_app_state', **arguments)
        return self.last

    def act(self, tool, **arguments):
        return self.run.call(tool, app=self.app, **arguments)

    def target(self, needle, pattern=None):
        """element_index (unlocked, when the tree has it) or OCR x/y."""
        state = self.state()
        if self.run.mode != 'locked' and pattern:
            # Web content builds its accessibility tree lazily, as a model would
            # see after asking again: look up to three times.
            for attempt in range(3):
                index = tree_index(state['text'], pattern)
                if index is not None:
                    return {'element_index': index}, 'ax-index'
                if attempt < 2:
                    time.sleep(1)
                    state = self.state()
        hit = ocr_find(state['text'], needle)
        if hit:
            return {'x': hit[1], 'y': hit[2]}, 'coordinates'
        return None, 'none'

    def dump(self):
        return probe('dump', str(self.pid)) if self.pid else {}

    def outcome(self, op, result, verified, detail, path):
        if result.get('front_changed'):
            return self.run.record(self.key, op, 'fail', 'the front app changed during this call: ' + detail, path, result['seconds'])
        if result['is_error']:
            return self.run.record(self.key, op, classify(result), result['text'].splitlines()[0] if result['text'] else 'error', path, result['seconds'])
        if not verified and 'is disabled while the app is in the background' in result['text']:
            # skfiy said it could not do it here; a known limitation, reported truthfully.
            reason = re.search(r'Its menu item ("[^"]*") is disabled while the app is in the background', result['text'])
            return self.run.record(self.key, op, 'refused', f"{detail}; skfiy: menu item {reason[1] if reason else ''} disabled in the background", path, result['seconds'])
        return self.run.record(self.key, op, 'pass' if verified else 'fail', detail, path, result['seconds'])

    def run_all(self):
        problem = self.precondition()
        if problem:
            for op in OPS:
                self.run.record(self.key, op, 'untested', problem)
            return
        try:
            self.prepare()
        except Exception as error:
            for op in OPS:
                self.run.record(self.key, op, 'untested', f'setup failed: {error}')
            self.cleanup()
            return
        for op in OPS:
            try:
                getattr(self, 'op_' + op)()
            except Exception as error:
                self.run.record(self.key, op, 'fail', f'harness error: {type(error).__name__}: {error}')
        self.cleanup()

    def cleanup(self):
        pass


# --------------------------------------------------------------- TextEdit

class TextEdit(Case):
    key = 'textedit'
    app = 'TextEdit'

    def precondition(self):
        for pid in pids_of('TextEdit'):
            titles = [w['title'] for w in probe('dump', str(pid))['windows'] if w['role'] == 'AXWindow']
            if any(self.nonce not in title for title in titles):
                return 'TextEdit has the user\'s documents open; typing could reach them'
        return None

    def prepare(self):
        folder = WORK / self.nonce
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / f'compat-{self.nonce}.txt'
        self.path.write_text(''.join(f'TextEdit line {i:03d} {self.nonce}\n' for i in range(1, 161)))
        self.window = self.path.name
        # -F: no restored windows from an earlier run, only this document.
        sh('open', '-g', '-F', '-a', 'TextEdit', self.path)
        self.pid = wait_until(lambda: pids_of('TextEdit') and pids_of('TextEdit')[0], timeout=10)
        require(self.pid, 'TextEdit did not start')
        wait_until(lambda: any(self.nonce in w['title'] for w in self.dump()['windows']), timeout=10)

    def text_value(self):
        areas = self.dump().get('textAreas', [])
        return areas[0] if areas else {}

    def op_screenshot(self):
        result = self.state()
        seen = 'line 001' in result['text'] or bool(ocr_find(result['text'], 'line 00'))
        self.outcome('screenshot', result, bool(result['images']) and seen,
                     f"{len(result['images'])} image(s); first lines {'visible' if seen else 'missing'}", 'capture')

    def op_click(self):
        state = self.state()
        hit = ocr_find(state['text'], 'line 010') or ocr_find(state['text'], '010')
        if not hit:
            return self.run.record(self.key, 'click', 'fail', 'OCR did not find "line 010" to click', 'coordinates')
        result = self.act('click', x=hit[1], y=hit[2])
        if self.run.mode == 'locked':
            # Accessibility does not describe the app truthfully while locked;
            # the typed marker landing on this row verifies the click instead.
            self.pending_click = (result, hit)
            return
        content = self.path.read_text()
        start = content.index('TextEdit line 010')
        end = start + len(f'TextEdit line 010 {self.nonce}')
        value = wait_until(lambda: (v := self.text_value()) and v.get('selection') and v, timeout=3)
        if value:
            location = value['selection']['location']
            verified = start <= location <= end
            detail = f'caret at {location}, line 10 spans {start}-{end}'
        else:
            verified, detail = False, 'the probe could not read the caret (AX unavailable)'
        self.clicked = verified
        self.outcome('click', result, verified, detail, 'coordinates')

    def op_type(self):
        marker = f'MARK{self.nonce[:6].upper()}'
        self.marker = marker
        result = self.act('type_text', text=marker)
        value = wait_until(lambda: marker in (self.text_value().get('value') or '') and self.text_value(), timeout=4)
        if value:
            line = next((l for l in value['value'].splitlines() if marker in l), '')
            verified, detail = True, f'typed into {line[:60]!r}'
        else:
            fresh = self.state()
            seen = ocr_find(fresh['text'], marker) or ocr_find(fresh['text'], marker[:6])
            verified, detail = bool(seen), ('marker visible in a fresh screenshot (independent OCR; AX unreadable while locked)' if seen else 'marker not visible')
            pending = getattr(self, 'pending_click', None)
            if pending and result['is_error']:
                self.run.record(self.key, 'click', 'untested', 'sent, but not verifiable: the typing that would show where the caret went was refused', 'coordinates')
            elif pending:
                click_result, hit = pending
                same_row = bool(seen) and abs(seen[2] - hit[2]) <= 8
                self.outcome('click', click_result, same_row,
                             f"typed marker {'on' if same_row else 'not on'} the clicked row (y {hit[2]:.0f} vs {seen[2] if seen else '—'})", 'coordinates')
        self.outcome('type', result, verified, detail, 'keyboard')

    def op_scroll(self):
        state = self.state()
        before_lines = [int(m[1]) for label, _, _ in ocr_lines(state['text']) if (m := re.search(r'line (\d{3})', label))]
        before = min(before_lines) if before_lines else None
        hit = ocr_find(state['text'], 'line 0')
        if not hit:
            return self.run.record(self.key, 'scroll', 'fail', 'no text to scroll at', 'coordinates')
        result = self.act('scroll', x=hit[1], y=hit[2], direction='down', pages=2)
        after_state = self.state()
        after_lines = [int(m[1]) for label, _, _ in ocr_lines(after_state['text']) if (m := re.search(r'line (\d{3})', label))]
        after = min(after_lines) if after_lines else None
        verified = before is not None and after is not None and after > before
        self.outcome('scroll', result, verified, f'first visible line {before} -> {after}', 'coordinates')

    def op_popup(self):
        # A new untitled document with text, closed: TextEdit asks in a sheet
        # whether to keep it. Delete answers it and removes the document.
        windows = len(self.dump()['windows'])
        new = self.act('press_key', key='cmd+n')
        if new['is_error'] or not wait_until(lambda: len(self.dump()['windows']) > windows, timeout=4):
            return self.outcome('popup', new, False, 'cmd+n opened no new document', 'keyboard')
        self.act('type_text', text=f'popup {self.nonce}')
        result = self.act('press_key', key='cmd+w')
        sheet = wait_until(lambda: any(w['sheets'] for w in self.dump()['windows']), timeout=4)
        detail = 'keep-document sheet appeared' if sheet else 'no sheet appeared'
        if sheet:
            saved_window, self.window = self.window, None
            state = self.state()
            self.window = saved_window
            delete = tree_index(state['text'], r'Button "Delete"') if self.run.mode != 'locked' else None
            hit = None if delete else ocr_find(state['text'], 'Delete')
            if delete or hit:
                self.act('click', **({'element_index': delete} if delete else {'x': hit[1], 'y': hit[2]}))
            gone = wait_until(lambda: not any(w['sheets'] for w in self.dump()['windows']) and len(self.dump()['windows']) == windows, timeout=4)
            detail += ('; answered Delete, document gone' if gone else '; could not answer it') + (' (by element_index)' if delete else ' (by coordinates)')
            sheet = bool(gone)
        self.outcome('popup', result, bool(sheet), detail, 'keyboard')

    def cleanup(self):
        if self.pid and self.run.mode != 'locked':
            self.run.call('press_key', app='TextEdit', key='cmd+w')
        # TextEdit had none of the user's documents (precondition), so it can go.
        for pid in pids_of('TextEdit'):
            subprocess.run(['kill', '-TERM', str(pid)])


# ---------------------------------------------------------------- Preview

class Preview(Case):
    key = 'preview'
    app = 'Preview'

    def precondition(self):
        for pid in pids_of('Preview'):
            titles = [w['title'] for w in probe('dump', str(pid))['windows'] if w['role'] == 'AXWindow']
            if any(self.nonce not in title for title in titles):
                return 'Preview has the user\'s documents open; typing could reach them'
        return None

    def prepare(self):
        folder = WORK / self.nonce
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / f'preview-{self.nonce}.pdf'
        sh(TOOLS['make_pdf'], self.path, *[f'Preview page {i} {self.nonce}' for i in range(1, 7)])
        self.window = self.path.stem
        sh('open', '-g', '-F', '-a', 'Preview', self.path)
        self.pid = wait_until(lambda: pids_of('Preview') and pids_of('Preview')[0], timeout=10)
        require(self.pid, 'Preview did not start')
        wait_until(lambda: any(self.nonce in w['title'] for w in self.dump()['windows']), timeout=10)

    def op_screenshot(self):
        result = self.state()
        seen = bool(ocr_find(result['text'], 'Preview page 1'))
        self.outcome('screenshot', result, bool(result['images']) and seen,
                     f"{len(result['images'])} image(s); page text {'recognized' if seen else 'not recognized'}", 'capture')

    def op_click(self):
        target, path = self.target('Search', r'\] (SearchField|TextField)')
        if not target:
            return self.run.record(self.key, 'click', 'fail', 'no search field in the tree or OCR', path)
        result = self.act('click', **target)
        if self.run.mode == 'locked':
            self.pending_click = (result, path)  # verified by where the typing lands
            return
        focused = wait_until(lambda: (f := self.dump().get('focused')) and f.get('role') in ('AXSearchField', 'AXTextField') and f, timeout=3)
        self.outcome('click', result, bool(focused), f"focused element: {(self.dump().get('focused') or {}).get('role')}", path)

    def op_type(self):
        result = self.act('type_text', text='page 4')
        if self.run.mode == 'locked':
            focused = not result['is_error'] and bool(ocr_find(self.state()['text'], 'page 4'))
            pending = getattr(self, 'pending_click', None)
            if pending and result['is_error']:
                self.run.record(self.key, 'click', 'untested', 'sent, but not verifiable: the typing that would show the focus was refused', pending[1])
            elif pending:
                self.outcome('click', pending[0], focused, 'the search field took the typing' if focused else 'typing did not reach the search field', pending[1])
        else:
            focused = wait_until(lambda: (f := self.dump().get('focused')) and 'page 4' in (f.get('value') or '') and f, timeout=3)
        self.outcome('type', result, bool(focused), 'search field reads "page 4"' if focused else 'search field unchanged', 'keyboard')
        self.act('press_key', key='Escape')

    def pages_visible(self, text):
        return sorted({int(m[1]) for label, _, _ in ocr_lines(text) if (m := re.search(r'Preview page (\d)', label))})

    def op_scroll(self):
        state = self.state()
        before = self.pages_visible(state['text'])
        hit = ocr_find(state['text'], 'Preview page')
        if not hit:
            return self.run.record(self.key, 'scroll', 'fail', 'no page text to scroll at', 'coordinates')
        bars = lambda: [b['value'] for b in self.dump().get('scrollBars', []) if b['orientation'] == 'AXVerticalOrientation']
        bars_before = bars()
        result = self.act('scroll', x=hit[1], y=hit[2] + 80, direction='down', pages=3)
        after = self.pages_visible(self.state()['text'])
        bars_after = bars()
        moved = len(bars_after) == len(bars_before) and any(a - b > 0.01 for a, b in zip(bars_after, bars_before))
        verified = moved or bool(before and after and min(after) > min(before))
        self.outcome('scroll', result, verified, f'pages visible {before} -> {after}; vertical bars {[round(v, 2) for v in bars_before]} -> {[round(v, 2) for v in bars_after]}', 'coordinates')

    def op_popup(self):
        result = self.act('press_key', key='cmd+alt+g')
        sheet = wait_until(lambda: any(w['sheets'] for w in self.dump()['windows']), timeout=4)
        if not sheet and self.run.mode == 'locked':
            sheet = bool(ocr_find(self.state()['text'], 'Go to Page'))
        detail = 'Go to Page sheet appeared' if sheet else 'no sheet appeared'
        if sheet:
            self.act('press_key', key='Escape')
            gone = wait_until(lambda: not any(w['sheets'] for w in self.dump()['windows']), timeout=4)
            detail += '; dismissed' if gone else '; could not dismiss it'
            sheet = bool(gone)
        self.outcome('popup', result, bool(sheet), detail, 'keyboard')

    def cleanup(self):
        if self.pid and self.run.mode != 'locked':
            self.run.call('press_key', app='Preview', key='cmd+w')
        for pid in pids_of('Preview'):
            titles = [w['title'] for w in probe('dump', str(pid))['windows'] if w['role'] == 'AXWindow']
            if all(self.nonce in title for title in titles):
                subprocess.run(['kill', '-TERM', str(pid)])


# ----------------------------------------------------------------- Finder

class Finder(Case):
    key = 'finder'
    app = 'Finder'

    def prepare(self):
        self.folder = WORK / self.nonce / f'finder-{self.nonce}'
        self.folder.mkdir(parents=True, exist_ok=True)
        for i in range(1, 81):
            (self.folder / f'item-{i:02d}-{self.nonce[:4]}.txt').write_text(f'{i}\n')
        self.window = self.folder.name
        self.pid = pids_of('Finder')[0]
        if self.run.mode == 'locked':
            sh('open', '-g', self.folder)
        else:
            result = self.run.call('open_file', path=str(self.folder))
            require(not result['is_error'], result['text'])
        require(wait_until(lambda: any(self.folder.name in w['title'] for w in self.dump()['cgWindows']), timeout=10),
                'the Finder window did not open')

    def ours_focused(self):
        return any(w['focused'] and self.folder.name in w['title'] for w in self.dump()['windows'])

    def selected(self):
        # Finder's own answer through Apple Events (allowed for Finder, and
        # truthful while locked, unlike accessibility).
        script = 'tell application "Finder" to get name of every item of (get selection)'
        out = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=10).stdout.strip()
        return out or ' '.join(self.dump().get('selectedRows', []))

    def op_screenshot(self):
        result = self.state()
        seen = 'item-01' in result['text'] or bool(ocr_find(result['text'], 'item-0'))
        self.outcome('screenshot', result, bool(result['images']) and seen,
                     f"{len(result['images'])} image(s); files {'listed' if seen else 'missing'}", 'capture')

    def op_click(self):
        target, path = self.target('item-05', r'\] (Row|Cell|TextField|StaticText|Image)[^\n]*item-05')
        if not target:
            return self.run.record(self.key, 'click', 'fail', 'item-05 not found in tree or OCR', path)
        result = self.act('click', **target)
        verified = wait_until(lambda: 'item-05' in self.selected(), timeout=3)
        self.outcome('click', result, bool(verified), f'selected: {self.selected()[:80] or "nothing readable"}', path)

    def op_type(self):
        if self.run.mode != 'locked' and not self.ours_focused():
            return self.run.record(self.key, 'type', 'skipped', 'Finder\'s focused window is not the test window; typing could reach the user\'s window', 'keyboard')
        result = self.act('type_text', text='item-42')
        verified = wait_until(lambda: 'item-42' in self.selected(), timeout=3)
        self.outcome('type', result, bool(verified), f'selected after type-select: {self.selected()[:80] or "nothing readable"}', 'keyboard')

    def op_scroll(self):
        state = self.state()
        before = [b['value'] for b in self.dump().get('scrollBars', []) if b['orientation'] == 'AXVerticalOrientation']
        hit = ocr_find(state['text'], 'item-')
        if not hit:
            return self.run.record(self.key, 'scroll', 'fail', 'no file names to scroll at', 'coordinates')
        target = {'x': hit[1], 'y': hit[2]}
        result = self.act('scroll', direction='up' if before and max(before) > 0.5 else 'down', pages=2, **target)
        after = [b['value'] for b in self.dump().get('scrollBars', []) if b['orientation'] == 'AXVerticalOrientation']
        # The sidebar has a scroll bar too; any vertical bar that moved counts.
        verified = bool(before and len(after) == len(before) and any(abs(a - b) > 0.01 for a, b in zip(after, before)))
        numbers = lambda text: sorted({int(m[1]) for label, _, _ in ocr_lines(text) if (m := re.search(r'item-(\d\d)', label))})
        shown_before, shown_after = numbers(state['text']), numbers(self.state()['text'])
        if not before:
            # Accessibility is not truthful while locked: compare the file names shown.
            verified = bool(shown_before and shown_after and shown_after != shown_before)
        self.outcome('scroll', result, verified, f'vertical scroll bars {[round(v, 2) for v in before]} -> {[round(v, 2) for v in after]}; '
                     f'items shown {shown_before[:1]}…{shown_before[-1:]} -> {shown_after[:1]}…{shown_after[-1:]}', 'coordinates')

    def op_popup(self):
        if self.run.mode != 'locked' and not self.ours_focused():
            return self.run.record(self.key, 'popup', 'skipped', 'Finder\'s focused window is not the test window', 'keyboard')
        result = self.act('press_key', key='cmd+i')
        info = wait_until(lambda: any(w['title'].endswith('Info') and self.nonce[:4] in w['title'] for w in self.dump()['windows']), timeout=4)
        self.outcome('popup', result, bool(info), 'Get Info window opened' if info else 'no Get Info window', 'keyboard')

    def cleanup(self):
        # Only the windows this run opened: its folder and Get Info windows.
        for script in (f'tell application "Finder" to close Finder window "{self.folder.name}"',
                       f'tell application "Finder" to close (every information window whose name contains "-{self.nonce[:4]}.txt")'):
            subprocess.run(['osascript', '-e', script], capture_output=True, timeout=10)
        names = subprocess.run(['osascript', '-e', 'tell application "Finder" to get name of every window'],
                               capture_output=True, text=True, timeout=10).stdout
        if self.folder.name in names:
            self.run.record(self.key, 'cleanup', 'fail', 'the test Finder window is still open')


# ------------------------------------------------------------ web (Chrome, Electron)

DOWNLOADS = WORK / 'downloads'


def chrome_pid():
    out = sh('pgrep', '-f', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', check=False).split()
    return int(out[0]) if out else None


def launch_chrome(binary, url='about:blank', restart=False):
    """Chrome for Testing with its own profile, the current extension files,
    and downloads going to /tmp/skfiy-compat/downloads (never the user's
    Downloads folder). restart=True quits it first so new extension files load."""
    if restart and chrome_pid():
        subprocess.run(['pkill', '-f', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'])
        wait_until(lambda: not chrome_pid(), timeout=10)
    if chrome_pid():
        return chrome_pid()
    profile = WORK / 'chrome-profile'
    extension = WORK / 'extension'
    # Chrome keeps running a cached service worker for an unpacked extension;
    # clearing the test profile's cache makes it load the current files.
    shutil.rmtree(profile / 'Default/Service Worker', ignore_errors=True)
    shutil.rmtree(extension, ignore_errors=True)
    shutil.copytree(ROOT / 'browser-extension', extension)
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    preferences = profile / 'Default/Preferences'
    preferences.parent.mkdir(parents=True, exist_ok=True)
    prefs = json.loads(preferences.read_text()) if preferences.exists() else {}
    prefs.setdefault('download', {}).update({'default_directory': str(DOWNLOADS), 'prompt_for_download': False, 'directory_upgrade': True})
    prefs.setdefault('savefile', {})['default_directory'] = str(DOWNLOADS)
    preferences.write_text(json.dumps(prefs))
    host = WORK / 'bin/skfiy-host'
    host.unlink(missing_ok=True)
    shutil.copy2(binary, host)
    sh(host, 'install-browser-bridge', '--user-data-dir', profile)
    sh(TOOLS['Launch'] if TOOLS else BIN_LAUNCH, chrome_app(), f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check',
       '--disable-search-engine-choice-screen', '--disable-features=DisableLoadExtensionCommandLineSwitch',
       f'--load-extension={extension}', url, timeout=30)
    return wait_until(chrome_pid, timeout=10)


BIN_LAUNCH = WORK / 'bin/Launch'


def chrome_app():
    found = sorted((Path.home() / '.cache/skfiy-test').glob(CFT_GLOB))
    return found[-1] if found else None


class WebApp(Case):
    """The compat page in an app, driven with the app tools (AX / pixels)."""
    channel = 'app'

    def page(self):
        return page_state(self.run_id)

    def wait_page(self, check, timeout=5):
        return wait_until(lambda: check(self.page()), timeout=timeout)

    def op_screenshot(self):
        result = self.state()
        seen = 'COMPAT PAGE' in result['text'] or bool(ocr_find(result['text'], 'COMPAT PAGE'))
        self.outcome('screenshot', result, bool(result['images']) and seen,
                     f"{len(result['images'])} image(s); heading {'found' if seen else 'missing'}", 'capture')

    def op_click(self):
        target, path = self.target('Increment', r'\] Button "Increment"')
        if not target:
            return self.run.record(self.key, 'click', 'fail', 'Increment button not found', path)
        before = self.page().get('clicks', 0)
        result = self.act('click', **target)
        verified = self.wait_page(lambda s: s.get('clicks', 0) > before)
        self.outcome('click', result, bool(verified), f"page clicks {before} -> {self.page().get('clicks')}", path)

    def op_type(self):
        target, path = self.target('Compat input', r'\] TextField[^\n]*Compat input')
        if not target:
            return self.run.record(self.key, 'type', 'fail', 'input not found', path)
        focus = self.act('click', **target)
        text = f'typed{self.nonce[:6]}'
        result = self.act('type_text', text=text)
        verified = self.wait_page(lambda s: text in s.get('value', ''))
        if focus['is_error']:
            result = focus
        self.outcome('type', result, bool(verified), f"page input value {self.page().get('value')!r}", path + '+keyboard')

    def op_scroll(self):
        state = self.state()
        hit = ocr_find(state['text'], 'Row 0')
        if not hit:
            return self.run.record(self.key, 'scroll', 'fail', 'no rows to scroll at', 'coordinates')
        before = self.page().get('scrollY', 0)
        result = self.act('scroll', x=hit[1], y=hit[2], direction='down', pages=2)
        verified = self.wait_page(lambda s: s.get('scrollY', 0) > before)
        self.outcome('scroll', result, bool(verified), f"page scrollY {before} -> {self.page().get('scrollY')}", 'coordinates')

    def op_popup(self):
        target, path = self.target('Show alert', r'\] Button "Show alert"')
        if not target:
            return self.run.record(self.key, 'popup', 'fail', 'alert button not found', path)
        result = self.act('click', **target)
        opened = self.wait_page(lambda s: s.get('popup') == 'open', timeout=4)
        if not opened:
            return self.outcome('popup', result, False, 'the page did not open its alert', path)
        state = self.state()
        ok = tree_index(state['text'], r'\] Button "OK"') if self.run.mode != 'locked' else None
        if ok is not None:
            close = self.act('click', element_index=ok)
            how = 'OK by element_index'
        else:
            hit = ocr_find(state['text'], 'OK')
            close = self.act('click', x=hit[1], y=hit[2]) if hit else self.act('press_key', key='Return')
            how = 'OK by coordinates' if hit else 'Return'
        closed = self.wait_page(lambda s: s.get('popup') == 'closed', timeout=4)
        if not closed and not close['is_error']:
            self.act('press_key', key='Return')
            closed = self.wait_page(lambda s: s.get('popup') == 'closed', timeout=3)
            how += ', then Return'
        visible = 'Compat alert' in state['text'] or bool(ocr_find(state['text'], 'Compat alert'))
        detail = f"alert {'shown in state' if visible else 'not shown in state'}; closed with {how}: {'yes' if closed else 'no'}"
        self.outcome('popup', close if close['is_error'] else result, bool(closed), detail, path)


class Chrome(WebApp):
    key = 'chrome'
    app = 'Google Chrome for Testing'

    def precondition(self):
        if not chrome_app():
            return 'Chrome for Testing is not installed (scripts/test_browser.sh downloads it)'
        return None

    def prepare(self):
        ensure_server()
        self.run_id = f'{self.nonce}-{self.key}'
        profile = WORK / 'chrome-profile'
        extension = WORK / 'extension'
        if not self.running():
            shutil.rmtree(profile, ignore_errors=True)
            launch_chrome(self.run.binary, f'http://127.0.0.1:{PORT}/compat.html?run={self.run_id}')
        else:
            sh('open', '-g', '-a', chrome_app(), f'http://127.0.0.1:{PORT}/compat.html?run={self.run_id}')
        require(self.wait_page(lambda s: s.get('run') == self.run_id, timeout=20), 'the compat page did not load in Chrome')
        self.pid = wait_until(lambda: self.running(), timeout=5)
        self.window = 'skfiy compat ' + self.run_id

    def running(self):
        out = sh('pgrep', '-f', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', check=False).split()
        return int(out[0]) if out else None


class ChromeExtension(Chrome):
    """The same page through the browser bridge extension (DOM), in a tab skfiy opened."""
    key = 'chrome-extension'

    def prepare(self):
        Chrome.prepare(self)
        self.run_id = f'{self.nonce}-ext'
        # Only ever the test browser, by pid: the user's own Chrome may be connected too.
        connected = wait_until(lambda: not self.call('browser_tabs')['is_error'], timeout=45, interval=1)
        require(connected, 'the extension did not connect')
        opened = self.call('browser_open', url=f'http://127.0.0.1:{PORT}/compat.html?run={self.run_id}')
        require(not opened['is_error'], opened['text'])
        self.tab = int(re.search(r'tab (\d+)', opened['text'])[1])

    def call(self, tool, **arguments):
        return self.run.call(tool, browser=str(self.pid), **arguments)

    def index(self, label):
        state = self.call('browser_state', tab_id=self.tab, screenshot=False)
        for line in state['text'].splitlines():
            if label in line:
                match = re.search(r'\[(\d+)\]', line)
                if match:
                    return int(match[1])
        return None

    def op_screenshot(self):
        result = self.call('browser_state', tab_id=self.tab, background_screenshot=True)
        seen = 'COMPAT PAGE' in result['text']
        self.outcome('screenshot', result, seen and bool(result['images']),
                     f"{len(result['images'])} image(s) (debugger capture of a background tab); heading {'found' if seen else 'missing'}", 'extension')

    def op_click(self):
        before = self.page().get('clicks', 0)
        result = self.call('browser_click', tab_id=self.tab, index=self.index('Increment'))
        verified = self.wait_page(lambda s: s.get('clicks', 0) > before)
        self.outcome('click', result, bool(verified), f"page clicks {before} -> {self.page().get('clicks')}", 'extension')

    def op_type(self):
        text = f'typed{self.nonce[:6]}'
        result = self.call('browser_type', tab_id=self.tab, index=self.index('Compat input'), text=text)
        verified = self.wait_page(lambda s: text in s.get('value', ''))
        self.outcome('type', result, bool(verified), f"page input value {self.page().get('value')!r}", 'extension')

    def op_scroll(self):
        before = self.page().get('scrollY', 0)
        result = self.call('browser_scroll', tab_id=self.tab, direction='down', pages=2)
        verified = self.wait_page(lambda s: s.get('scrollY', 0) > before)
        self.outcome('scroll', result, bool(verified), f"page scrollY {before} -> {self.page().get('scrollY')}", 'extension')

    def op_popup(self):
        result = self.call('browser_click', tab_id=self.tab, index=self.index('Show alert'))
        closed = self.wait_page(lambda s: s.get('popup') == 'closed', timeout=4)
        noted = '(page dialog) alert' in result['text']
        self.outcome('popup', result, bool(closed) and noted,
                     f"alert {'answered and reported in the state' if noted else 'not reported'}; page popup={self.page().get('popup')}", 'extension')

    def cleanup(self):
        if getattr(self, 'tab', None):
            self.call('browser_close_tab', tab_id=self.tab)


class Electron(WebApp):
    key = 'electron'
    app = 'Electron'

    def precondition(self):
        if not ELECTRON.exists():
            return 'Electron is not installed in ~/.cache/skfiy-test/electron (npm install electron there)'
        if pids_of('Electron'):
            return 'another app named Electron is running'
        return None

    def prepare(self):
        ensure_server()
        self.run_id = f'{self.nonce}-electron'
        out = sh(TOOLS['Launch'], ELECTRON, str(ROOT / 'scripts/fixtures/electron'),
                 f'http://127.0.0.1:{PORT}/compat.html?run={self.run_id}', timeout=30)
        self.pid = int(out.split()[0])
        require(self.wait_page(lambda s: s.get('run') == self.run_id, timeout=20), 'the compat page did not load in Electron')
        self.window = 'skfiy compat ' + self.run_id
        time.sleep(1)

    def cleanup(self):
        if self.pid:
            subprocess.run(['kill', '-TERM', str(self.pid)])


CASE_TYPES = {'textedit': TextEdit, 'preview': Preview, 'finder': Finder, 'chrome': Chrome,
              'chrome-extension': ChromeExtension, 'electron': Electron}


# ------------------------------------------------------------------ main

def mode_problem(mode, allow_front):
    session = probe('session')
    if not session['known']:
        return 'the console session state is unknown'
    if mode == 'locked' and not session['locked']:
        return 'the Mac is not locked'
    if mode != 'locked' and session['locked']:
        return 'the Mac is locked'
    if mode == 'front':
        if not allow_front:
            return 'front mode brings apps forward; pass --allow-front (only while the user is away)'
        if session['idleSeconds'] < 60:
            return f"the user was active {session['idleSeconds']:.0f} s ago; front mode needs 60 s of idle"
    if not (session['accessibility'] and session['screenCapture']):
        return 'the host lacks Accessibility or Screen Recording permission'
    return None


def run_mode(binary, mode, cases, allow_front):
    nonce = uuid.uuid4().hex[:10]
    directory = RESULTS / f'compat-{mode}-{time.strftime("%Y%m%d-%H%M%S")}-{nonce}'
    directory.mkdir(parents=True, mode=0o700)
    run = Run(binary, mode, directory, nonce)
    summary = {'mode': mode, 'nonce': nonce, 'binary': str(binary), 'started': time.time(),
               'session': probe('session'), 'front': probe('front'), 'macOS': sh('sw_vers', '-productVersion').strip()}
    print(f'{mode}: evidence {directory}', flush=True)
    problem = mode_problem(mode, allow_front)
    try:
        if problem:
            for key in cases:
                for op in OPS:
                    run.record(key, op, 'untested', problem)
        else:
            run.start_client()
            front_user = probe('front')
            for key in cases:
                case = CASE_TYPES[key](run)
                if mode == 'front':
                    # Bring the target forward for the duration of the case only.
                    case_front(case, front_user)
                else:
                    case.run_all()
                if mode == 'background' and run.violations:
                    summary['frontViolations'] = run.violations
    finally:
        corrections = run.finish()
        summary['windowGuardCorrections'] = len(corrections)
        summary['windowGuardIntruders'] = sorted({c['intruder'] for c in corrections})
        samples = run.lock_samples
        summary['lockSamples'] = {'count': len(samples), 'locked': sum(1 for s in samples if s.get('locked')),
                                  'unknown': sum(1 for s in samples if not s.get('known'))}
        summary['results'] = run.results
        summary['finished'] = time.time()
        (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    return summary


def case_front(case, user):
    """Front mode: the harness activates the target app (never the user's own app) and
    restores the user's front app afterwards, aborting if the user becomes active."""
    original_prepare = case.prepare

    def prepare():
        original_prepare()
        if case.pid:
            sh(TOOLS['Front'], 'activate', case.pid)
    case.prepare = prepare
    try:
        case.run_all()
    finally:
        sh(TOOLS['Front'], 'activate', user['frontPID'], check=False)


def report():
    """docs/compatibility.md and docs/compat/baseline.json from the latest run of each mode."""
    # Per app and state, the latest run that actually tested it; an untested
    # row (say, locked mode while unlocked) never hides an earlier real result.
    rows = {}
    contributing = {}
    for path in sorted(RESULTS.glob('compat-*/summary.json'), key=lambda p: json.loads(p.read_text())['started']):
        summary = json.loads(path.read_text())
        for row in summary['results']:
            key = (row['case'], row['op'], summary['mode'])
            if row['status'] == 'untested' and key in rows and rows[key]['status'] != 'untested':
                continue
            rows[key] = {**row, 'run': path.parent.name}
            contributing[path.parent.name] = (path, summary)
    runs = []
    used = {row['run'] for row in rows.values()}
    for name, (path, summary) in sorted(contributing.items(), key=lambda item: item[1][1]['started']):
        if name not in used:
            continue
        runs.append({'mode': summary['mode'], 'evidence': str(path.parent.relative_to(ROOT)), 'started': summary['started'],
                     'macOS': summary.get('macOS'), 'lockSamples': summary.get('lockSamples'),
                     'session': {k: summary['session'].get(k) for k in ('known', 'locked')},
                     'cases': sorted({row['case'] for row in rows.values() if row['run'] == name}),
                     'frontViolations': len(summary.get('frontViolations', [])),
                     'windowGuardCorrections': summary.get('windowGuardCorrections')})
    (DOCS / 'compat').mkdir(parents=True, exist_ok=True)
    (DOCS / 'compat/baseline.json').write_text(json.dumps({'runs': runs, 'results': list(rows.values())}, indent=1, ensure_ascii=False) + '\n')
    names = {'textedit': 'TextEdit', 'preview': 'Preview', 'finder': 'Finder', 'chrome': 'Chrome（应用工具）',
             'chrome-extension': 'Chrome（扩展）', 'electron': 'Electron'}
    marks = {'pass': '✅ 通过', 'fail': '❌ 失败', 'refused': '⛔ 拒绝', 'untested': '— 未测', 'skipped': '⏭ 跳过'}
    lines = ['| 应用 | 操作 | ' + ' | '.join({'front': '解锁·前台', 'background': '解锁·后台', 'locked': '锁屏 direct'}[m] for m in MODES) + ' |',
             '| --- | --- | ' + ' | '.join('---' for _ in MODES) + ' |']
    for case in CASES:
        for op in OPS:
            cells = []
            for mode in MODES:
                row = rows.get((case, op, mode))
                cells.append(marks.get(row['status'], row['status']) if row else '— 未测')
            lines.append(f'| {names[case]} | {op} | ' + ' | '.join(cells) + ' |')
    notes = []
    for case in CASES:
        for op in OPS:
            for mode in MODES:
                row = rows.get((case, op, mode))
                if row and row['status'] in ('fail', 'refused', 'skipped'):
                    notes.append(f"- {names[case]} · {op} · {mode}：{row['detail']}")
    untested = {}
    for (case, op, mode), row in rows.items():
        if row['status'] == 'untested':
            untested.setdefault(mode, set()).add(row['detail'])
    notes += [f"- {mode} 未测：{'；'.join(sorted(reasons))}" for mode, reasons in sorted(untested.items())]
    table = '\n'.join(lines)
    detail = '\n'.join(notes) if notes else '- （无）'
    run_lines = '\n'.join(
        f"- {r['mode']}（{', '.join(names[c] for c in r['cases'])}）：{time.strftime('%Y-%m-%d %H:%M', time.localtime(r['started']))}，macOS {r['macOS']}，"
        f"会话锁定={r['session']['locked']}，锁态采样 {r['lockSamples']['count']} 次（锁定 {r['lockSamples']['locked']}，未知 {r['lockSamples']['unknown']}），"
        f"前台被改变 {r['frontViolations']} 次，测试窗口被压回下层 {r['windowGuardCorrections'] or 0} 次；证据 `{r['evidence']}`（本机，不入库）" for r in runs)
    template = (DOCS / 'compatibility.md').read_text() if (DOCS / 'compatibility.md').exists() else ''
    start, end = '<!-- compat-table:start -->', '<!-- compat-table:end -->'
    block = f'{start}\n{table}\n\n**运行记录**\n\n{run_lines}\n\n**失败、拒绝、跳过与未测的原因**\n\n{detail}\n{end}'
    if start in template:
        template = template.split(start)[0] + block + template.split(end)[1]
    else:
        template += '\n' + block + '\n'
    (DOCS / 'compatibility.md').write_text(template)
    print(table)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('binary', nargs='?', type=Path)
    parser.add_argument('--mode', choices=MODES, action='append')
    parser.add_argument('--case', choices=CASES, action='append')
    parser.add_argument('--allow-front', action='store_true')
    parser.add_argument('--report', action='store_true')
    args = parser.parse_args()
    TOOLS.update(build_tools())
    if args.report:
        return report()
    require(args.binary and args.binary.exists(), 'pass the skfiy binary')
    failed = False
    for mode in args.mode or ['background']:
        summary = run_mode(args.binary.resolve(), mode, args.case or CASES, args.allow_front)
        failed = failed or any(r['status'] == 'fail' for r in summary['results'])
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    main()
