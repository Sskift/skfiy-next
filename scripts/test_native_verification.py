#!/usr/bin/env python3
"""Native verification/logging regressions in an owned background fixture.

No run_in_front, remote session, clipboard or user document is operated.
Optional --baseline reproduces false no_effect and window switching in an old build.
"""
import argparse
import json
from pathlib import Path
import re
import tempfile
import uuid

from harness import Client, index
from scenario import Fixture, probe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--baseline')
    args = parser.parse_args()
    assert not probe('session')['locked'], 'this test requires an already unlocked desktop'
    checks = []
    def check(name, ok):
        checks.append(bool(ok))
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)

    with tempfile.TemporaryDirectory(prefix='skfiy-verification-') as temp:
        directory = Path(temp)
        fixture = Fixture(directory, uuid.uuid4().hex[:10]).launch()
        app = f'pid:{fixture.pid}'
        main_title = 'Scenario ' + fixture.nonce
        main_window = next(w['number'] for w in fixture.state()['windows'] if w['title'] == main_title)
        log = directory / 'actions.jsonl'
        client = None
        def state(c):
            return c.call('get_app_state', app=app, window=str(main_window), ocr=False)
        def paint(c):
            before = state(c)
            result = c.call('click', app=app, element_index=index(before['text'], r'Button "Paint pixels"'),
                            window_id=str(main_window), expect={'changed': True, 'timeout': 1.5}, allow_error=True)
            return result
        def window_scope(c):
            default = c.call('get_app_state', app=app, ocr=False)
            default_id = int(re.search(r'Window:.*?\(id (\d+)\)', default['text'])[1])
            chosen = next(w for w in fixture.state()['windows'] if w['number'] != default_id)
            c.call('get_app_state', app=app, window=str(chosen['number']), ocr=False)
            result = c.call('scroll', app=app, window_id=str(chosen['number']), x=100, y=100,
                            direction='down', pages=0.1, expect={'text': 'NEVER PRESENT', 'timeout': 0.5}, allow_error=True)
            current = result['text'].split('Current state:')[-1]
            stayed = bool(re.search(r'Window:.*?\(id ' + str(chosen['number']) + r'\)', current))
            following = c.call('scroll', app=app, window_id=str(chosen['number']), direction='down', y=10, allow_error=True)
            return result, stayed, following
        try:
            if args.baseline:
                baseline = Client(Path(args.baseline).resolve(), env={'SKFIY_CURSOR': '0'})
                try:
                    result = paint(baseline)
                    check('baseline reproduces false no_effect despite received pixel-only action',
                          result['is_error'] and 'no_effect' in result['text'] and fixture.state()['counters'].get('paint') == 1)
                finally:
                    baseline.close()
            client = Client(Path(args.binary).resolve(), env={'SKFIY_CURSOR': '0', 'SKFIY_ACTION_LOG': str(log)})
            result = paint(client)
            check('pixel-only change is verified with an unchanged AX tree',
                  not result['is_error'] and result['structured']['verification']['status'] == 'verified')

            other = 'Other ' + fixture.nonce
            fixture.command('open_window', title=other, input=True)
            if args.baseline:
                baseline = Client(Path(args.baseline).resolve(), env={'SKFIY_CURSOR': '0'})
                try:
                    result, stayed, following = window_scope(baseline)
                    check('baseline reproduces window switch after failed verification',
                          result['is_error'] and not stayed and following['is_error'] and 'Pass both x and y' not in following['text'])
                finally:
                    baseline.close()
            result, stayed, following = window_scope(client)
            check('failed verification refreshes the same inspected window',
                  result['is_error'] and 'Current state:' in result['text'] and stayed)
            # This used to fail window_id validation after the follow-up silently
            # switched to the other window. It must still address the inspected tree.
            check('next action retains window binding and rejects its actual missing x',
                  following['is_error'] and 'Pass both x and y' in following['text'])

            fixture.command('minimize', title='main')
            result = state(client)
            check('requested but unavailable screenshot has structured diagnostics',
                  not result['images'] and result['structured'].get('capture_error') and not result['structured']['capture'])
            result = client.call('get_app_state', app=app, window='absent-' + fixture.nonce, allow_error=True)
            check('unreadable window is still an explicit error', result['is_error'])
            entries = [json.loads(line) for line in log.read_text().splitlines()]
            check('read failures and partial screenshots are recorded',
                  any(e['tool'] == 'get_app_state' and e['error'] for e in entries) and
                  any(e['tool'] == 'get_app_state' and e.get('capture_error') for e in entries))
            check('expect object, build identity and duration survive logging',
                  any(e['arguments'].get('expect') == {'changed': True, 'timeout': 1.5} and
                      e.get('build') and isinstance(e.get('duration_ms'), int) for e in entries))
            check('fixture remains in the background', not fixture.state()['active'])
        finally:
            if client:
                client.close()
            fixture.stop()
    print(f'{sum(checks)}/{len(checks)} checks passed')
    if not all(checks):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
