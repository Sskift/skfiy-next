#!/usr/bin/env python3
"""Narrow MCP regression: an empty-title second visible window blocks keys.

--prepare compiles only (the default). --run requires an already locked Mac,
creates one dedicated two-window fixture, reads both windows through MCP, and
requires type_text/press_key refusal without any real keyboard delivery.
No system lock/unlock or authorization plugin call is made.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

from diagnose_locked_direct import no_custom_authorization
from smoke_locked import Evidence, ROOT, build_helpers, probe_sample, require, run, wait_for
from smoke_locked_direct import DirectClient


def build_two_window_fixture(directory, nonce):
    probe, app, binary = build_helpers(directory, nonce)
    source = (ROOT / 'scripts/fixtures/LockedFixture.swift').read_text()
    old = '    private var window: EvidenceWindow!'
    require(source.count(old) == 1, 'Fixture window declaration changed')
    source = source.replace(old, old + '\n    private var secondWindow: EvidenceWindow?')
    old = '        // Focus only within this inactive window; never activate the app.'
    require(source.count(old) == 1, 'Fixture focus setup changed')
    source = source.replace(old, '''        // The second genuinely visible window deliberately has an empty title.
        // It logs key delivery through the same independent event journal.
        let second = EvidenceWindow(contentRect: NSRect(x: 30, y: 30, width: 300, height: 200),
                                    styleMask: [.titled, .closable], backing: .buffered, defer: false)
        second.title = ""
        second.isReleasedWhenClosed = false
        second.keyReceived = window.keyReceived
        let label = NSTextField(labelWithString: "Untitled fixture " + options.nonce)
        label.frame = NSRect(x: 15, y: 75, width: 270, height: 55)
        label.lineBreakMode = .byWordWrapping
        second.contentView?.addSubview(label)
        second.orderBack(nil)
        secondWindow = second
''' + old)
    old = '        state["last_key_code"] = lastKeyCode.map { $0 as Any } ?? NSNull()'
    require(source.count(old) == 1, 'Fixture journal setup changed')
    source = source.replace(old, '''        state["app_windows"] = [window, secondWindow].compactMap { $0 }.map { w -> [String: Any] in
            ["id": w.windowNumber, "title": w.title, "visible": w.isVisible,
             "level": w.level.rawValue, "alpha": w.alphaValue, "canBecomeKey": w.canBecomeKey]
        }
        state["cg_visible_windows"] = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []).filter { $0[kCGWindowOwnerPID as String] as? Int == Int(getpid()) }
''' + old)
    path = directory / 'LockedTwoWindowFixture.swift'
    path.write_text(source)
    run('/usr/bin/swiftc', '-O', path, '-o', binary, timeout=90)
    run('/usr/bin/codesign', '--force', '--sign', '-', app)
    return probe, app, binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--run', action='store_true')
    args = parser.parse_args()
    binary = args.binary.resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), 'Provide an executable skfiy binary')
    nonce = uuid.uuid4().hex[:12]
    directory = ROOT / 'eval/results' / ('locked-direct-multiwindow-' + time.strftime('%Y%m%d-%H%M%S-') + nonce)
    directory.mkdir(parents=True, mode=0o700)
    evidence = Evidence(directory)
    summary = {'ok': False, 'case': 'two-visible-windows-one-empty-title', 'nonce': nonce,
               'binary': str(binary), 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
               'evidence': str(directory), 'actualMCPTestRun': False, 'checks': []}
    (directory / 'harness-source.py').write_text(Path(__file__).read_text())
    client = fixture = watcher = reader = None
    watch_output = fixture_error = watch_error = None
    samples = []
    state_path = directory / 'fixture.json'
    print(f'Evidence: {directory}', flush=True)
    try:
        probe, app, fixture_binary = build_two_window_fixture(directory, nonce)
        summary['prepared'] = True
        if not args.run:
            return
        summary['authorization'] = no_custom_authorization()
        initial = probe_sample(probe)
        summary['initial'] = initial
        require(initial['known'] and initial['osLocked'], 'The Mac must already be locked')
        require(initial['accessibility'] and initial['screenCapture'], 'The host needs AX and Screen Recording permissions')
        watch_output = (directory / 'lock-samples.jsonl').open('x', buffering=1)
        watch_error = (directory / 'watch.stderr').open('x')
        watcher = subprocess.Popen([str(probe), '--watch'], stdout=subprocess.PIPE,
                                   stderr=watch_error, text=True, bufsize=1)
        def collect():
            for line in watcher.stdout:
                watch_output.write(line)
                try:
                    samples.append(json.loads(line))
                except ValueError:
                    pass
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        wait_for(lambda: samples, 'Independent lock sampler did not start')
        def check_lock():
            require(watcher.poll() is None and samples and time.time() - samples[-1]['timestamp'] < .4,
                    'Independent lock sampling stopped or became stale')
            require(all(s.get('known') and s.get('osLocked') and s.get('osLockedAtStart') for s in samples),
                    'The test observed unlocked or unknown OS state')
        check_lock()
        fixture_error = (directory / 'fixture.stderr').open('x')
        fixture = subprocess.Popen([str(fixture_binary), '--journal', str(state_path), '--nonce', nonce, '--lifetime', '180'],
                                   stdout=subprocess.DEVNULL, stderr=fixture_error)
        def state():
            try:
                row = json.loads(state_path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return None
            require(row['run_nonce'] == nonce and row['pid'] == fixture.pid, 'Fixture identity changed')
            return row
        wait_for(state, 'Two-window fixture did not become ready')
        # orderBack queues its WindowServer transaction. The ready journal is
        # written in that same launch callback, before CG bounds are flushed.
        wait_for(lambda: (s := state()) and s['tick'] >= 2, 'Fixture did not reach its first rendered frames')
        def visible_window_pair():
            row = state()
            windows = row['app_windows']
            visible = [w for w in windows if w['visible'] and w['level'] == 0 and w['alpha'] > 0]
            require(len(visible) == 2, f'Expected two genuinely visible AppKit windows: {windows}')
            cg = {w['kCGWindowNumber']: w for w in row['cg_visible_windows'] if w.get('kCGWindowIsOnscreen') is True}
            for window in visible:
                require(window['id'] in cg and cg[window['id']]['kCGWindowOwnerPID'] == fixture.pid,
                        'WindowServer did not independently report both fixture windows on screen')
            empty = [w for w in visible if w['title'] == '']
            titled = [w for w in visible if w['title'] != '']
            require(len(empty) == len(titled) == 1, 'Need exactly one empty-title and one titled visible window')
            return titled[0], empty[0]
        titled, empty = visible_window_pair()
        summary['visibleWindows'] = {'titled': titled, 'emptyTitle': empty, 'windowServer': state()['cg_visible_windows']}
        summary['checks'].append('two_real_visible_windows_including_empty_title')
        client = DirectClient(binary, evidence)
        summary['actualMCPTestRun'] = True
        app_query = str(app)
        # Read by the actual window IDs, never by filtering empty titles away.
        for window in (titled, empty):
            check_lock()
            shot = client.call('get_app_state', app=app_query, window=str(window['id']), ocr=True)
            require(shot['images'], 'MCP failed to read one of the two real windows')
            require(f'(id {window["id"]})' in shot['text'], 'MCP returned the wrong window')
            summary['checks'].append('read_empty_title_window' if window['title'] == '' else 'read_titled_window')
        def mutation_counters():
            row = state()
            return {key: row[key] for key in ('key_down_count', 'pointer_count', 'scroll_count', 'drag_count',
                                               'drag_complete_count', 'commit_count', 'input_value')}
        for tool, arguments in (('type_text', {'text': 'REFUSE' + nonce}), ('press_key', {'key': 'a'})):
            check_lock()
            visible_window_pair()
            # Give every attempt a valid, current screenshot of a chosen window;
            # rejection must be for keyboard ambiguity, not missing/expired state.
            client.call('get_app_state', app=app_query, window=str(titled['id']), ocr=False)
            before = mutation_counters()
            result = client.request('tools/call', {'name': tool, 'arguments': {'app': app_query, **arguments}})
            text = '\n'.join(b['text'] for b in result.get('content', []) if b.get('type') == 'text')
            evidence.record('multiwindow_keyboard_refusal', tool=tool, is_error=bool(result.get('isError')), text=text)
            require(result.get('isError') is True, f'{tool} incorrectly allowed keyboard delivery with two visible windows')
            require('keyboard destination cannot be verified' in text.lower() or 'ambiguous' in text.lower(),
                    f'{tool} failed for an unrelated reason: {text}')
            time.sleep(.4)
            check_lock()
            visible_window_pair()
            after = mutation_counters()
            require(after == before, f'{tool} changed fixture counters despite refusal: {before} -> {after}')
            summary.setdefault('refusals', []).append({'tool': tool, 'error': text, 'before': before, 'after': after})
        require(state()['key_down_count'] == 0, 'A rejected request nevertheless delivered real key events')
        summary['checks'].extend(['type_text_refused_for_multiple_windows', 'press_key_refused_for_multiple_windows',
                                   'zero_key_events_to_either_fixture_window'])
        summary['functionalChecksPassed'] = True
    except BaseException as error:
        summary['error'] = f'{type(error).__name__}: {error}'
    finally:
        if client:
            client.close()
        if fixture:
            fixture.terminate()
            try:
                fixture.wait(timeout=3)
            except subprocess.TimeoutExpired:
                fixture.kill(); fixture.wait()
        if watcher:
            time.sleep(.15)
            invalid = [s for s in samples if not s.get('known') or not s.get('osLocked') or not s.get('osLockedAtStart')]
            gaps = [b['uptime'] - a['uptime'] for a, b in zip(samples, samples[1:])]
            journal = Path(str(state_path) + '.jsonl')
            rows = [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
            fixture_invalid = [r for r in rows if not r.get('screen_lock_known') or not r.get('screen_locked')]
            monitor_live = watcher.poll() is None and samples and time.time() - samples[-1]['timestamp'] < .4
            continuous = bool(monitor_live and not invalid and rows and not fixture_invalid and gaps and max(gaps) < .5)
            summary['lockEvidence'] = {'sampleCount': len(samples), 'maxGapSeconds': max(gaps) if gaps else None,
                'invalidSamples': invalid, 'fixtureInvalid': fixture_invalid, 'continuouslyObservedLocked': continuous}
            summary['ok'] = bool(summary.get('functionalChecksPassed') and continuous)
            watcher.terminate()
            try:
                watcher.wait(timeout=3)
            except subprocess.TimeoutExpired:
                watcher.kill(); watcher.wait()
            if reader:
                reader.join(timeout=1)
        for handle in (watch_output, fixture_error, watch_error):
            if handle:
                handle.close()
        (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(summary, indent=2, ensure_ascii=False))

    if 'error' in summary or (args.run and not summary['ok']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
