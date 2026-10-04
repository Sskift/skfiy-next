#!/usr/bin/env python3
"""wait_for against the scenario app, in whatever state the Mac is in
(direct mode while locked, the accessibility tree while unlocked):

    python3 scripts/test_wait.py .build/debug/skfiy

Delayed text, text going away, an animation settling, a region that ignores
an animation elsewhere, timeout with the current state, cancellation from
the client, the window closing mid-wait; and that waiting sent nothing.
"""
import json
import re
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, main_binary, ocr_find  # noqa: E402


def waited(result):
    match = re.search(r'after ([\d.]+) s|within ([\d.]+) s', result['text'])
    return float(match[1] or match[2]) if match else None


def main():
    main_binary()
    with Session('wait') as s:
        app = s.app
        state = s.call('get_app_state', app=app)
        s.check('baseline state', not state['is_error'] and state['images'], state['text'][:120])
        before = s.fixture.state()
        word = f'READY{s.nonce[:6].upper()}'

        s.fixture.command('text', value=word, after=3)
        result = s.call('wait_for', app=app, text=word, timeout=12)
        seconds = waited(result)
        s.check('delayed text appears', not result['is_error'] and 'appeared' in result['text'], result['text'][:160])
        s.check('waited about the delay', seconds is not None and 2.4 <= seconds <= 7, seconds)
        s.check('fresh state returned', bool(result['images']) and (word.lower() in result['text'].lower() or ocr_find(result['text'], word[:5])),
                result['text'][:300])

        s.fixture.command('clear', after=2)
        result = s.call('wait_for', app=app, text=word, gone=True, timeout=12)
        seconds = waited(result)
        s.check('text gone', not result['is_error'] and 'was gone' in result['text'], result['text'][:160])
        s.check('waited about the delay (gone)', seconds is not None and 1.4 <= seconds <= 6, seconds)

        s.fixture.command('animate', seconds=3)
        started = time.monotonic()
        result = s.call('wait_for', app=app, timeout=15)
        elapsed = time.monotonic() - started
        settled = s.fixture.state()
        s.check('animation settles', not result['is_error'] and 'stopped changing' in result['text'], result['text'][:160])
        s.check('not before the animation ended', not settled['animating'] and elapsed >= 2.8, f'{elapsed:.1f} s, animating={settled["animating"]}')

        if s.locked:
            fresh = s.call('get_app_state', app=app, ocr=True)
            message = ocr_find(fresh['text'], 'message')
            if s.check('message label located for a region', message, fresh['text'][:200]):
                s.fixture.command('animate', seconds=6)
                started = time.monotonic()
                region = [max(0, message[1] - 60), max(0, message[2] - 12), 300, 24]
                result = s.call('wait_for', app=app, region=region, timeout=10)
                elapsed = time.monotonic() - started
                s.check('region ignores the animation elsewhere', not result['is_error'] and elapsed < 4 and s.fixture.state()['animating'],
                        f'{elapsed:.1f} s; {result["text"][:120]}')
                time.sleep(max(0, 6.5 - elapsed))
        else:
            result = s.call('wait_for', app=app, region=[0, 0, 10, 10])
            s.check('region refused while unlocked, with the reason', result['is_error'] and 'locked' in result['text'], result['text'][:160])

        started = time.monotonic()
        result = s.call('wait_for', app=app, text=f'NEVER{s.nonce}', timeout=2)
        s.check('timeout is an error with the current state', result['is_error'] and 'did not appear within' in result['text'] and result['images'],
                result['text'][:160])
        s.check('timeout honoured', time.monotonic() - started < 9, f'{time.monotonic() - started:.1f} s')

        # Cancellation: the client gives up on a long wait; the server stops it at once.
        s.client.next_id += 1
        cancelled_id = s.client.next_id
        s.client.send({'jsonrpc': '2.0', 'id': cancelled_id, 'method': 'tools/call',
                       'params': {'name': 'wait_for', 'arguments': {'app': app, 'text': f'NEVER{s.nonce}', 'timeout': 30}}})
        time.sleep(1.5)
        s.client.send({'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': cancelled_id, 'reason': 'test'}})
        started = time.monotonic()
        after = s.call('get_app_state', app=app, ocr=False)
        latency = time.monotonic() - started
        s.check('cancelled wait frees the server at once', not after['is_error'] and latency < 6, f'next call answered in {latency:.1f} s (the wait had 28 s left)')
        time.sleep(0.5)
        replies = [json.loads(line) for line in (s.directory / 'harness.jsonl').read_text().splitlines()]
        late = [r for r in replies if r.get('event') == 'mcp_notification' and r.get('message', {}).get('id') == cancelled_id]
        s.check('no response for the cancelled request', not late, late[:1])

        # The watched window closes mid-wait.
        dialog = f'Scenario dialog {s.nonce}'
        s.fixture.command('open_window', title=dialog)
        time.sleep(0.6)
        s.call('get_app_state', app=app, window=dialog, ocr=False)
        closer = threading.Timer(1.5, lambda: s.fixture.command('close_window', title=dialog, wait=False))
        closer.start()
        started = time.monotonic()
        result = s.call('wait_for', app=app, window=dialog, text=f'NEVER{s.nonce}', timeout=15)
        closer.join()
        s.check('window closing stops the wait with the reason', result['is_error'] and 'closed' in result['text'] and time.monotonic() - started < 8,
                result['text'][:200])

        after = s.fixture.state()
        s.check('waiting sent nothing', after['keys'] == before['keys'] and after['counters'] == before['counters'] and after['input'] == before['input'],
                (after['keys'], after['counters']))


def chrome(s):
    """A real app: the compat page in Chrome for Testing's front tab; the page's
    own button starts a 3 s load (through the extension), and wait_for watches
    the browser window like any app."""
    import subprocess
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from compat_baseline import ensure_server, PORT, page_state
    pids = subprocess.run(['pgrep', '-f', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
                          capture_output=True, text=True).stdout.split()
    if not s.check('Chrome for Testing running', pids, 'start it with scripts/compat_baseline.py --case chrome'):
        return
    browser = pids[0]
    ensure_server()
    tabs = s.call('browser_tabs', browser=browser)
    front = re.search(r'tab (\d+) \[(?:front tab of its window|shown)\]', tabs['text'])
    if not s.check('front tab found', front, tabs['text'][:200]):
        return
    run = f'{s.nonce}-wait'
    opened = s.call('browser_open', browser=browser, tab_id=int(front[1]), url=f'http://127.0.0.1:{PORT}/compat.html?run={run}')
    s.check('page loaded in the front tab', not opened['is_error'], opened['text'][:120])
    app = 'Google Chrome for Testing'
    s.call('get_app_state', app=app, ocr=False)
    state = s.call('browser_state', browser=browser, tab_id=int(front[1]), screenshot=False)
    index = re.search(r'\[(\d+)\] button "Load later"', state['text'])
    clicked = s.call('browser_click', browser=browser, tab_id=int(front[1]), index=int(index[1]))
    started = time.monotonic()
    result = s.call('wait_for', app=app, text=f'LOADED {run}', timeout=15)
    seconds = waited(result)
    s.check('Chrome: delayed page text seen by wait_for', not clicked['is_error'] and not result['is_error'] and 'appeared' in result['text'],
            result['text'][:160])
    s.check('Chrome: not before the page loaded it', seconds is not None and seconds >= 1.5 and page_state(run).get('later') == 'done',
            f'{seconds} s; page says later={page_state(run).get("later")}')
    result = s.call('wait_for', app=app, timeout=10)
    s.check('Chrome: page settles', not result['is_error'], result['text'][:120])


if __name__ == '__main__':
    main()
    if '--chrome' in sys.argv:
        with Session('wait-chrome', fixture=False) as session:
            chrome(session)
