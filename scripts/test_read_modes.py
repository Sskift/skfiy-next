#!/usr/bin/env python3
"""Read-mode and bounded incremental-cache regression against our own app.
Never locks/unlocks the desktop or opens the user's documents.
"""
import json
import math
import re
import statistics
import sys
import time
from scenario import Session, main_binary


def main():
    main_binary(sys.argv[1] if len(sys.argv) > 1 else None)
    with Session('read-modes', environment={'SKFIY_CURSOR': '0'}) as s:
        if s.locked:
            result = s.call('get_app_state', app=s.app, screenshot=False, incremental=True)
            s.check('locked mode still observes pixels instead of claiming an AX-only read', not result['is_error'] and bool(result['images']), result['text'][:160])
            print('SKIP unlocked AX cache benchmark: desktop is locked', flush=True)
            return
        rows = []
        version = None
        last = None
        for mode in ('full', 'tree', 'incremental'):
            for _ in range(5):
                args = {'app': s.app, 'ocr': False, 'screenshot': mode == 'full'}
                if mode == 'incremental':
                    args['incremental'] = True
                    if version: args['since'] = version
                started = time.monotonic()
                last = s.call('get_app_state', **args)
                elapsed = time.monotonic() - started
                s.check(f'{mode} read succeeds', not last['is_error'], last['text'][:80])
                version = re.search(r'State: (v\d+)', last['text'])[1]
                metrics = last['structured'] or {}
                if mode != 'full':
                    s.check(f'{mode} skips capture and image attachment', not last['images'] and metrics.get('capture') is False)
                rows.append({'mode': mode, 'seconds': elapsed, **metrics})
        s.check('incremental reads reuse nodes', any(row.get('tree', {}).get('cached_nodes', 0) > 0 for row in rows))
        refused = s.call('click', app=s.app, x=10, y=10)
        s.check('tree-only read invalidates old screenshot coordinates', refused['is_error'], refused['text'][:160])
        s.fixture.command('text', value='CACHE-CHANGED')
        started = time.monotonic()
        while time.monotonic() - started < 3.5:
            changed = s.call('get_app_state', app=s.app, screenshot=False, ocr=False, incremental=True, since=version)
            if 'CACHE-CHANGED' in changed['text']: break
            time.sleep(.05)
        s.check('announced or periodic refresh catches changed text', 'CACHE-CHANGED' in changed['text'], changed['text'][-240:])
        time.sleep(2.05)
        refreshed = s.call('get_app_state', app=s.app, screenshot=False, ocr=False, incremental=True, since=version)
        counts = refreshed['structured']['tree']
        s.check('periodic full read bounds unannounced changes', counts['cached_nodes'] == 0 and counts['fresh_nodes'] > 0, counts)
        summary = {}
        for mode in ('full', 'tree', 'incremental'):
            samples = sorted(row['seconds'] * 1000 for row in rows if row['mode'] == mode)
            summary[mode] = {'p50_ms': round(statistics.median(samples), 2), 'p95_ms': round(samples[math.ceil(.95 * len(samples))-1], 2)}
        (s.directory/'read-performance.json').write_text(json.dumps({'rows': rows, 'timings': summary}, indent=2))
        print('READ_BENCH ' + json.dumps(summary), flush=True)
        if not all(check['ok'] for check in s.checks): raise AssertionError('read-mode regression failed')


if __name__ == '__main__':
    main()
