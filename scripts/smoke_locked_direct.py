#!/usr/bin/env python3
"""MCP end-to-end direct locked-use test, confined to a dedicated fixture.

  python3 scripts/smoke_locked_direct.py .build/release/skfiy --prepare
  python3 scripts/smoke_locked_direct.py .build/release/skfiy --run

--run requires the Mac already locked and never unlocks it. Coordinates come
from get_app_state screenshot OCR, never the fixture's private geometry journal.
The journal independently verifies real input and actions; a separate probe
samples the actual OS lock. No authorization plugin is installed or invoked.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid

from diagnose_locked_direct import no_custom_authorization
from harness import Client, Evidence, ROOT, require
from scenario import OCR_LINE
from smoke_locked import build_helpers, probe_sample, run, wait_for


class DirectClient(Client):
    """Run the real MCP with direct locked mode explicitly enabled."""
    def __init__(self, binary, evidence):
        super().__init__(binary, evidence, env={'SKFIY_LOCKED_USE': 'direct'},
                         name='skfiy-direct-locked-smoke')


def ocr_coordinates(result, needle, exact=False):
    require(result['images'], 'Coordinate selection requires an actual current screenshot')
    choices = []
    for line in result['text'].splitlines():
        match = OCR_LINE.fullmatch(line.rstrip())
        if match:
            text = json.loads(match[1])
            matches = text.casefold() == needle.casefold() if exact else needle.casefold() in text.casefold()
            if matches:
                choices.append({'label': text, 'x': float(match[2]), 'y': float(match[3]), 'sourceLine': line})
    require(choices, f'Current screenshot OCR did not locate {needle!r}: {result["text"]}')
    # The text field is above the custom canvas if both show the committed value.
    return min(choices, key=lambda choice: (choice['y'], choice['x']))


def compact_state(state):
    return {key: value for key, value in state.items() if key != 'frames'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--run', action='store_true', help='Run isolated real MCP input while Mac is already locked')
    args = parser.parse_args()
    binary = args.binary.resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), 'Provide an executable built skfiy binary')
    nonce = uuid.uuid4().hex[:12]
    directory = ROOT / 'eval/results' / ('locked-direct-mcp-' + time.strftime('%Y%m%d-%H%M%S-') + nonce)
    directory.mkdir(parents=True, mode=0o700)
    evidence = Evidence(directory)
    summary = {'ok': False, 'nonce': nonce, 'binary': str(binary), 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
               'evidence': str(directory), 'mode': 'direct', 'actualMCPTestRun': False,
               'started': time.time(), 'baselineTested': False,
               'checks': [], 'coordinateSource': 'current MCP get_app_state screenshot OCR x/y'}
    (directory / 'harness-source.py').write_text(Path(__file__).read_text())
    client = fixture = watcher = reader = None
    samples = []
    watch_output = fixture_error = watch_error = None
    lock_start = None
    state_path = directory / 'fixture.json'
    print(f'Evidence: {directory}', flush=True)
    try:
        probe, app, fixture_binary = build_helpers(directory, nonce)
        summary['prepared'] = True
        if not args.run:
            return
        summary['authorization'] = no_custom_authorization()
        initial = probe_sample(probe)
        summary['initial'] = initial
        require(initial['known'] and initial['osLocked'], '--run requires the Mac already locked; it never locks or unlocks it')
        require(initial['accessibility'] and initial['screenCapture'], 'Test host needs Accessibility and Screen Recording')
        lock_start = initial['timestamp']
        watch_output = (directory / 'lock-samples.jsonl').open('x', buffering=1)
        watch_error = (directory / 'watch.stderr').open('x')
        watcher = subprocess.Popen([str(probe), '--watch'], stdout=subprocess.PIPE, stderr=watch_error, text=True, bufsize=1)
        def collect():
            for line in watcher.stdout:
                watch_output.write(line)
                try:
                    samples.append(json.loads(line))
                except ValueError:
                    pass
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        wait_for(lambda: samples, 'Independent monitor did not start')

        def lock_check():
            require(watcher.poll() is None and samples and time.time() - samples[-1]['timestamp'] < .4,
                    'Independent monitor stopped or its evidence is stale')
            bad = [row for row in samples if not row.get('known') or not row.get('osLocked') or not row.get('osLockedAtStart')]
            require(not bad, 'OS unlocked or became unknown during this test; results are contaminated')

        lock_check()
        fixture_error = (directory / 'fixture.stderr').open('x')
        fixture = subprocess.Popen([str(fixture_binary), '--journal', str(state_path), '--nonce', nonce, '--lifetime', '300'],
                                   stdout=subprocess.DEVNULL, stderr=fixture_error)
        def state():
            try:
                row = json.loads(state_path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return None
            require(row['run_nonce'] == nonce and row['pid'] == fixture.pid, 'Fixture identity changed')
            return row
        wait_for(state, 'Fixture did not start')
        require(state()['screen_locked'], 'Fixture does not observe the true lock')
        client = DirectClient(binary, evidence)
        summary['mcpPID'] = client.proc.pid
        summary['fixturePID'] = fixture.pid
        app_query = str(app)
        summary['actualMCPTestRun'] = True
        schema = client.request('tools/list', {})
        require({'get_app_state', 'click', 'type_text', 'press_key', 'scroll', 'drag'}.issubset({t['name'] for t in schema['tools']}),
                'MCP lacks required computer-use tools')

        def call(tool, **arguments):
            lock_check()
            result = client.call(tool, app=app_query, **arguments)
            lock_check()
            return result

        def fresh():
            result = call('get_app_state', ocr=True)
            require(result['images'], 'get_app_state returned no screenshot')
            require('Screenshot:' in result['text'], 'get_app_state omitted screenshot geometry')
            return result

        def locate(result, text, exact=False):
            location = ocr_coordinates(result, text, exact=exact)
            evidence.record('visual_target', query=text, image=result['images'][0], **location)
            return {'x': location['x'], 'y': location['y']}

        first = fresh()
        input_point = locate(first, 'Fixture nonce')
        call('click', **input_point)
        value = 'TEST' + nonce.upper()
        key_count = state()['key_down_count']
        call('type_text', text=value)
        typed = wait_for(lambda: (s := state()) and s['input_value'] == value and s,
                         'MCP type_text did not reach the fixture text field')
        require(typed['key_down_count'] > key_count, 'MCP type_text did not deliver real keyboard events')
        summary['checks'].extend(['get_app_state_screenshot', 'screenshot_coordinate_click_input', 'type_text_real_key_events'])
        evidence.record('type_text_verified', fixture=compact_state(typed))
        commit_view = fresh()
        commit_point = locate(commit_view, 'Commit nonce')
        commits = state()['commit_count']
        call('click', **commit_point)
        committed = wait_for(lambda: (s := state()) and s['commit_count'] == commits + 1 and s['committed_value'] == value and s,
                             'MCP coordinate click did not commit the typed nonce')
        summary['checks'].append('screenshot_coordinate_commit')
        evidence.record('commit_verified', fixture=compact_state(committed))
        committed_view = fresh()
        ocr = json.loads(run(probe, '--ocr', committed_view['images'][0], timeout=20))
        normalized = re.sub(r'[^A-Z0-9]', '', ' '.join(ocr['lines']).upper())
        require(value in normalized, f'Independent screenshot OCR missed the newly committed value: {ocr["lines"]}')
        require(hashlib.sha256(Path(committed_view['images'][0]).read_bytes()).digest() !=
                hashlib.sha256(Path(first['images'][0]).read_bytes()).digest(), 'Screenshot did not change after actions')
        summary['checks'].append('fresh_screenshot_independent_ocr')
        evidence.record('independent_screenshot_ocr', result=ocr)
        # The same visible value occurs in field and canvas; choose its uppermost exact OCR line.
        call('click', **locate(committed_view, value, exact=True))
        call('press_key', key='Right', repeat=len(value) + 1)
        keys = state()['key_down_count']
        call('press_key', key='BackSpace')
        edited = wait_for(lambda: (s := state()) and s['input_value'] == value[:-1] and s['key_down_count'] > keys and s['last_key_code'] == 51 and s,
                          'MCP press_key did not deliver BackSpace to the fixture')
        summary['checks'].append('press_key_real_event')
        evidence.record('press_key_verified', fixture=compact_state(edited))
        canvas_view = fresh()
        green = locate(canvas_view, 'GREEN TARGET')
        before = state()['pointer_count']
        call('click', **green)
        clicked = wait_for(lambda: (s := state()) and s['pointer_count'] > before and s['pointer_side'] == 'green' and s,
                           'MCP coordinate click did not reach the custom canvas')
        summary['checks'].append('canvas_real_pointer')
        evidence.record('canvas_click_verified', fixture=compact_state(clicked))
        scroll_view = fresh()
        before = state()['scroll_count']
        call('scroll', **locate(scroll_view, 'GREEN TARGET'), direction='down', pages=.3)
        scrolled = wait_for(lambda: (s := state()) and s['scroll_count'] > before and s['scroll_delta_y'] != 0 and s,
                            'MCP scroll did not deliver a scrollWheel event to the canvas')
        summary['checks'].append('scroll_real_event')
        evidence.record('scroll_verified', fixture=compact_state(scrolled))
        drag_view = fresh()
        start, end = locate(drag_view, 'GREEN TARGET'), locate(drag_view, 'ORANGE TARGET')
        before = state()['drag_complete_count']
        call('drag', from_x=start['x'], from_y=start['y'], to_x=end['x'], to_y=end['y'])
        dragged = wait_for(lambda: (s := state()) and s['drag_complete_count'] > before and s['drag_count'] > 0 and s['drag_side'] == 'orange' and s,
                           'MCP drag did not deliver a completed drag from green to orange')
        summary['checks'].append('drag_real_events')
        evidence.record('drag_verified', fixture=compact_state(dragged))
        final_view = fresh()
        final_ocr = json.loads(run(probe, '--ocr', final_view['images'][0], timeout=20))
        require(any('drag orange' in line.lower() for line in final_ocr['lines']), 'Final screenshot does not show drag result')
        summary['checks'].append('final_visual_feedback')
        summary['fixtureFinal'] = compact_state(state())
        summary['finalOCR'] = final_ocr
        summary['coreFunctionalChecksPassed'] = True
        lock_check()

        # Refusals must produce no fixture events or semantic value changes.
        def mutation_snapshot():
            row = state()
            keys = ('key_down_count', 'pointer_count', 'scroll_count', 'drag_count',
                    'drag_complete_count', 'commit_count', 'input_value', 'committed_value',
                    'scroll_delta_x', 'scroll_delta_y')
            return {key: row[key] for key in keys}

        def expect_refusal(label, tool, arguments):
            lock_check()
            if label != 'new_state_after_end':
                # Keep every negative case armed with a fresh valid screenshot;
                # expired/missing state must not masquerade as the intended gate.
                current = client.call('get_app_state', app=app_query, ocr=False)
                require(current['images'], 'Refusal case lacks a fresh valid screenshot')
                lock_check()
            before = mutation_snapshot()
            began = time.time()
            result = client.request('tools/call', {'name': tool, 'arguments': arguments})
            text = '\n'.join(block['text'] for block in result.get('content', []) if block.get('type') == 'text')
            evidence.record('expected_refusal', label=label, tool=tool, arguments=arguments,
                            started=began, is_error=bool(result.get('isError')), text=text)
            require(result.get('isError') is True, f'{label} was unexpectedly accepted: {text}')
            # A heartbeat crosses the event loop, revealing any deferred delivered input.
            time.sleep(.35)
            lock_check()
            after = mutation_snapshot()
            require(after == before, f'{label} changed fixture state despite refusal: {before} -> {after}')
            evidence.record('refusal_has_no_fixture_effect', label=label, before=before, after=after)
            summary.setdefault('refusals', []).append({'label': label, 'tool': tool, 'error': text})

        base = {'app': app_query}
        expect_refusal('semantic_element_click', 'click', {**base, 'element_index': '0'})
        expect_refusal('temporary_focus_drag', 'drag', {**base, 'from_x': start['x'], 'from_y': start['y'],
                       'to_x': end['x'], 'to_y': end['y'], 'focus': True})
        expect_refusal('semantic_set_value', 'set_value', {**base, 'element_index': '0', 'value': 'REFUSED'})
        expect_refusal('foreground_action', 'run_in_front', {**base, 'key': 'a', 'reason': 'Fixture refusal diagnostic'})
        expect_refusal('clipboard_read', 'read_clipboard', {'reason': 'Fixture refusal diagnostic'})
        for chord in ('cmd+c', 'super+x', 'meta+v', 'command+shift+c', 'cmd+alt+x', 'super+shift+v',
                      'CMD+C', 'meta_l+x', 'win+v'):
            expect_refusal('clipboard_chord_' + chord, 'press_key', {**base, 'key': chord})
        expect_refusal('negative_click_x', 'click', {**base, 'x': -1, 'y': green['y']})
        expect_refusal('huge_click_x', 'click', {**base, 'x': 1000000000, 'y': green['y']})
        expect_refusal('nan_click_x', 'click', {**base, 'x': 'nan', 'y': green['y']})
        expect_refusal('nan_scroll_y', 'scroll', {**base, 'x': green['x'], 'y': 'nan', 'direction': 'down'})
        expect_refusal('huge_drag_endpoint', 'drag', {**base, 'from_x': start['x'], 'from_y': start['y'],
                       'to_x': 1000000000, 'to_y': end['y']})
        expect_refusal('nan_drag_endpoint', 'drag', {**base, 'from_x': start['x'], 'from_y': start['y'],
                       'to_x': end['x'], 'to_y': 'nan'})
        summary['checks'].append('unsafe_or_invalid_requests_refused_without_fixture_mutations')

        # Direct locked mode cannot reliably classify a focused password field,
        # so even this ordinary fixture's type_text must be conservatively redacted.
        log_path = directory / 'actions.jsonl'
        require(log_path.exists(), 'MCP did not create its requested action log')
        log_rows = [json.loads(line) for line in log_path.read_text().splitlines()]
        typed_rows = [row for row in log_rows if row.get('tool') == 'type_text']
        require(typed_rows, 'Action log does not record the real type_text call')
        for row in typed_rows:
            typed_argument = str(row.get('arguments', {}).get('text', ''))
            require(typed_argument and nonce.upper() not in typed_argument.upper() and value not in typed_argument,
                    'Action log leaked the literal typed nonce in type_text arguments')
            require(value not in str(row.get('result', '')), 'Action log leaked literal typed text in the result')
        summary['typeTextLogRedaction'] = {'passed': True, 'entryCount': len(typed_rows),
                                          'recordedTextFields': [r['arguments']['text'] for r in typed_rows]}
        summary['checks'].append('type_text_action_log_redaction')

        before_end = mutation_snapshot()
        ended = client.call('locked_use_end')
        lock_check()
        require(mutation_snapshot() == before_end, 'locked_use_end changed fixture input state')
        evidence.record('locked_use_ended', text=ended['text'])
        expect_refusal('new_state_after_end', 'get_app_state', {**base, 'ocr': True})
        final_lock = probe_sample(probe)
        require(final_lock['known'] and final_lock['osLocked'], 'Direct session end did not preserve the actual OS lock')
        summary['endState'] = {'tool': ended['text'], 'independentLock': final_lock}
        summary['checks'].append('end_revokes_new_state_and_preserves_os_lock')
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
            interval = [s for s in samples if s.get('timestamp', 0) >= lock_start]
            gaps = [b['uptime'] - a['uptime'] for a, b in zip(interval, interval[1:])]
            invalid = [s for s in interval if not s.get('known') or not s.get('osLocked') or not s.get('osLockedAtStart')]
            journal = Path(str(state_path) + '.jsonl')
            rows = [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
            fixture_invalid = [r for r in rows if not r.get('screen_lock_known') or not r.get('screen_locked')]
            monitor_live = watcher.poll() is None and interval and time.time() - interval[-1]['timestamp'] < .4
            continuous = bool(monitor_live and interval and not invalid and rows and not fixture_invalid and gaps and max(gaps) < .5)
            summary['lockEvidence'] = {'sampleCount': len(interval), 'maxGapSeconds': max(gaps) if gaps else None,
                'invalidSamples': invalid, 'fixtureInvalid': fixture_invalid, 'continuouslyObservedLocked': continuous,
                'qualification': '50 ms samples plus actual fixture event observations; finite sampling cannot cover every instant'}
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
        summary['finished'] = time.time()
        (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(summary, indent=2, ensure_ascii=False))

    if 'error' in summary or (args.run and not summary['ok']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
