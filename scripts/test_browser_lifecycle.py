#!/usr/bin/env python3
"""Two real MCP sessions sharing a disposable headless Chrome.
Checks independent page receipts; no user tabs, profiles, or windows.
Usage: python3 scripts/test_browser_lifecycle.py .build/debug/skfiy [all|lifecycle|outcomes]
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from compat_baseline import chrome_app
from harness import APPROVE, Client, Evidence, ROOT, require, wait_until

HTML = b'''<!doctype html><meta charset="utf-8"><title>Lifecycle fixture</title>
<div id="buttons"><button id="approve" onclick="report('approve')">Approve</button><button id="delete" onclick="report('delete')">Delete</button></div>
<button onclick="buttons.prepend(document.getElementById('delete'));report('reverse')">Reverse</button>
<button onclick="report('submit');statusText.textContent='Saved '+(++submitted)">Submit</button>
<button onclick="report('noop')">Noop</button><div id="statusText">Ready</div>
<script>let submitted=0</script><label>Message<input id="message" oninput="report('type')"></label>
<label>Upload<input type="file" onchange="report('upload')"></label>
<iframe src="/frame"></iframe>
<script>function report(name){fetch('/receipt?name='+name)}</script>'''
receipts = {}
scroll_enabled = False
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        route = urlsplit(self.path)
        if route.path == '/receipt':
            name = parse_qs(route.query)['name'][0]
            receipts[name] = receipts.get(name, 0) + 1
            body = b'ok'
        elif route.path == '/scroll-status':
            body = b'yes' if scroll_enabled else b'no'
        elif route.path == '/nested-scroll':
            body = b'''<style>button{display:block;height:50px;width:150px}</style>
<div id="pane" style="position:absolute;top:100px;left:100px;height:50px;width:170px;overflow:auto">
<button onclick="fetch('/receipt?name=inner-approve')">Approve</button>
<button onclick="fetch('/receipt?name=inner-delete')">Delete</button></div>
<script>let moved=false;setInterval(async()=>{if(!moved && await(await fetch('/scroll-status')).text()==='yes'){
pane.scrollTop=50;moved=true;fetch('/receipt?name=inner-scrolled')}},30)</script>'''
        elif route.path == '/upload-unreadable':
            body = b'''<label>Upload<input type="file" onchange="fetch('/receipt?name=upload-destroy');document.documentElement.remove()"></label>'''
        elif route.path == '/probe-unavailable':
            body = b'<div>Processing</div>'
        elif route.path == '/destroy':
            body = b'<button onclick="fetch(\'/receipt?name=destroy\');document.documentElement.remove()">Submit and clear view</button>'
        elif route.path == '/coordinates':
            name = parse_qs(route.query).get('name', ['coordinate'])[0]
            body = f'<button style="position:absolute;left:850px;top:200px;width:100px;height:50px" onclick="fetch(\'/receipt?name={name}\')">Coordinate target</button>'.encode()
        elif route.path == '/frame':
            body = b'<button onclick="fetch(\'/receipt?name=frame\')">Frame action</button>'
        else:
            body = HTML
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global scroll_enabled
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT/'.build/debug/skfiy').resolve()
    suite = sys.argv[2] if len(sys.argv) > 2 else 'all'
    require(suite in ('all', 'lifecycle', 'outcomes'), 'suite must be all, lifecycle, or outcomes')
    chrome_path = chrome_app()
    require(chrome_path, 'Chrome for Testing is required; this test never downloads or uses a personal browser.')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    clients = []
    chrome = None
    chrome2 = None
    checks = []
    def check(name, condition, detail=''):
        require(condition, f'{name}: {detail}' if detail else name)
        checks.append(name); print('PASS ' + name, flush=True)
    with tempfile.TemporaryDirectory(prefix='skfiy-lifecycle-') as folder:
        root = Path(folder)
        evidence_path = Path(os.environ.get('SKFIY_TEST_EVIDENCE', str(root/'evidence')))
        evidence_path.mkdir(parents=True, exist_ok=True)
        log = (evidence_path/'chrome.log').open('w')
        def evidence(name):
            folder = evidence_path/name
            folder.mkdir()
            return Evidence(folder)
        extension = root/'extension'
        shutil.copytree(ROOT/'browser-extension', extension)
        # Test-only transport fault: real Chrome runs the production extension;
        # only pageProbe injection on this dedicated fixture URL is rejected.
        background = extension/'background.js'
        background.write_text(background.read_text() + """
const executeForFixture = chrome.scripting.executeScript.bind(chrome.scripting);
chrome.scripting.executeScript = async options => {
  if (options.func?.name === 'pageProbe' && (await chrome.tabs.get(options.target.tabId)).url.includes('/probe-unavailable'))
    throw new Error('fixture renderer unavailable');
  return executeForFixture(options);
};
""")
        try:
            host = root/'host'; shutil.copy2(binary, host)
            profile = root/'profile'
            subprocess.run([str(host), 'install-browser-bridge', '--user-data-dir', str(profile)], check=True, capture_output=True)
            chrome = subprocess.Popen([str(chrome_path/'Contents/MacOS/Google Chrome for Testing'),
                f'--user-data-dir={profile}', '--headless=new', '--window-size=1000,800', '--no-first-run', '--no-default-browser-check',
                '--disable-features=DisableLoadExtensionCommandLineSwitch', f'--load-extension={extension}', 'about:blank'],
                stdout=log, stderr=subprocess.STDOUT)
            env = {'SKFIY_CURSOR': '0', 'SKFIY_APPROVE': 'ask', 'SKFIY_BROWSER_TRACE': '1'}
            a = Client(binary, evidence=evidence('a'), env=env, answer=APPROVE); clients.append(a)
            b = Client(binary, evidence=evidence('b'), env=env); clients.append(b)
            browser = {'browser': str(chrome.pid)}
            require(wait_until(lambda: not a.call('browser_tabs', allow_error=True, **browser)['is_error'], timeout=30), 'extension connected')
            opened = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/', **browser)
            tab = int(re.search(r'tab (\d+)', opened['text'])[1]); target = {**browser, 'tab_id': tab}
            if suite != 'outcomes':
                state = a.call('browser_state', screenshot=False, **target)
                old = int(re.search(r'\[(\d+)\] button "Approve"', state['text'])[1])
                b.call('browser_click', target='Reverse', **target)
                require(wait_until(lambda: receipts.get('reverse') == 1), 'page reordered')
                result = a.call('browser_click', index=old, allow_error=True, **target)
                check('stale cross-session index is refused without clicking Delete', result['is_error'] and 'snapshot' in result['text'] and receipts.get('delete', 0) == 0 and receipts.get('approve', 0) == 0)
                a.call('browser_click', target='Approve', **target)
                check('semantic target rereads and clicks the intended control', wait_until(lambda: receipts.get('approve') == 1))
                a.call('browser_click', target='Frame action', **target)
                check('same-origin frame indices remain bound and usable', wait_until(lambda: receipts.get('frame') == 1))
                a.call('browser_type', target='Message', text='hello', **target)
                check('typing still reaches the observed field', wait_until(lambda: receipts.get('type', 0) > 0))

                # Request IDs are distinct from the client's own synchronous calls.
                def send_call(client, request_id, tool, args):
                    client.send({'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}})
                def cancel(client, request_id):
                    client.send({'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': request_id}})
                def until(client, predicate, timeout=5):
                    end = time.monotonic() + timeout
                    while time.monotonic() < end:
                        message = client.inbox.get(timeout=max(.01, end-time.monotonic()))
                        if isinstance(message, Exception): raise message
                        if predicate(message): return message
                        if 'result' in message and message.get('result', {}).get('isError'):
                            raise AssertionError(f'Unexpected MCP error while waiting: {message}')
                    raise AssertionError('reply timeout')
                before = receipts.copy()
                send_call(b, 101, 'browser_wait', {**target, 'text': 'never appears', 'timeout': 30})
                send_call(b, 102, 'browser_click', {**target, 'target': 'Delete'})
                cancel(b, 102); time.sleep(.2); cancel(b, 101)
                started = time.monotonic()
                b.send({'jsonrpc': '2.0', 'id': 103, 'method': 'ping'})
                until(b, lambda m: m.get('id') == 103)
                check('queued cancellation drops the click and releases the MCP queue promptly', receipts == before and time.monotonic()-started < 3)

                upload = root/'fixture.txt'; upload.write_text('test upload')
                send_call(a, 201, 'browser_upload', {**target, 'target': 'Upload', 'path': str(upload)})
                prompt = until(a, lambda m: m.get('method') == 'elicitation/create')
                started = time.monotonic(); cancel(a, 201)
                a.send({'jsonrpc': '2.0', 'id': prompt['id'], 'result': APPROVE})
                a.send({'jsonrpc': '2.0', 'id': 202, 'method': 'ping'})
                until(a, lambda m: m.get('id') == 202)
                time.sleep(.25)
                check('cancelled upload ignores late approval and sends no file', receipts.get('upload', 0) == 0 and time.monotonic()-started < 3)

                # The same upload is still supported when it is intentionally approved.
                a.call('browser_upload', target='Upload', path=str(upload), **target)
                check('approved upload still commits exactly once', wait_until(lambda: receipts.get('upload') == 1))
                before = receipts.copy()
                send_call(b, 301, 'browser_wait', {**target, 'text': 'never appears', 'timeout': 30})
                send_call(b, 302, 'browser_click', {**target, 'target': 'Delete'})
                time.sleep(.2); started = time.monotonic(); b.close()
                check('EOF cancels the active wait and discards pending input', receipts == before and time.monotonic()-started < 3)
            if suite == 'lifecycle':
                print(f'PASS {len(checks)}/{len(checks)} browser lifecycle checks', flush=True)
                return
            first = a.call('browser_click', target='Submit', **target)
            check('submit reports sent separately from its unverified effect', first['structured']['action']['status'] == 'sent'
                  and first['structured']['verification']['status'] == 'not_requested' and wait_until(lambda: receipts.get('submit') == 1))
            again = a.call('browser_click', target='Submit', allow_error=True, **target)
            check('automatic post-action read does not authorize duplicate submit', again['is_error'] and 'confirm_repeat' in again['text'] and receipts.get('submit') == 1)
            a.call('browser_state', screenshot=False, **target)
            verified = a.call('browser_click', target='Submit', expect={'text': 'Saved 2'}, **target)
            check('browser expect verifies a new success message', verified['structured']['verification']['status'] == 'verified' and receipts.get('submit') == 2)
            existing = a.call('browser_click', target='Noop', expect={'text': 'Saved 2'}, allow_error=True, **target)
            check('browser preexisting condition stays unverified', existing['is_error'] and existing['structured']['verification']['status'] == 'already_satisfied')
            # A late final observation now times out instead of overrunning the budget.
            no_effect = a.call('browser_click', target='Noop', expect={'changed': True, 'timeout': .3}, allow_error=True, **target)
            check('browser no-op remains unverified and still records sent', no_effect['is_error'] and no_effect['structured']['action']['status'] == 'sent'
                  and no_effect['structured']['verification']['status'] in ('no_effect', 'timeout'), no_effect)
            typed = a.call('browser_type', target='Message', text='verified value', clear=True, expect={'value': 'verified value'}, **target)
            check('browser field value is verified after typing', typed['structured']['verification']['status'] == 'verified')

            destroyed = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/destroy', **browser)
            destroy_target = {**browser, 'tab_id': int(re.search(r'tab (\d+)', destroyed['text'])[1])}
            receipt = a.call('browser_click', target='Submit and clear view', allow_error=True, **destroy_target)
            check('failed post-action snapshot preserves the sent acknowledgement', receipt['is_error'] and receipt['structured']['action']['status'] == 'sent'
                  and 'state_error' in receipt['structured'] and wait_until(lambda: receipts.get('destroy') == 1))
            a.call('browser_close_tab', **destroy_target)

            profile2 = root/'profile2'
            subprocess.run([str(host), 'install-browser-bridge', '--user-data-dir', str(profile2)], check=True, capture_output=True)
            chrome2 = subprocess.Popen([str(chrome_path/'Contents/MacOS/Google Chrome for Testing'),
                f'--user-data-dir={profile2}', '--headless=new', '--window-size=2000,1000', '--no-first-run', '--no-default-browser-check',
                '--disable-features=DisableLoadExtensionCommandLineSwitch', f'--load-extension={extension}', 'about:blank'], stdout=log, stderr=subprocess.STDOUT)
            other_browser = {'browser': str(chrome2.pid)}
            require(wait_until(lambda: not a.call('browser_tabs', allow_error=True, **other_browser)['is_error'], timeout=30), 'second extension connected')
            # IDs are process-local and may be randomized by Chrome. The
            # deterministic duplicate-ID refusal is also covered in Swift.
            own_tabs = a.call('browser_tabs', **browser)['text']
            other_tabs = a.call('browser_tabs', **other_browser)['text']
            own_ids = set(map(int, re.findall(r'\btab (\d+)', own_tabs)))
            other_ids = set(map(int, re.findall(r'\btab (\d+)', other_tabs)))
            shared = own_ids & other_ids
            require(own_ids and other_ids, 'both browsers have a tab')
            left_id = right_id = min(shared) if shared else None
            if shared:
                ambiguous = a.call('browser_state', tab_id=left_id, screenshot=False, allow_error=True)
                check('duplicate tab ids require an explicit browser', ambiguous['is_error'] and 'ambiguous' in ambiguous['text'])
            else:
                left_id, right_id = min(own_ids), min(other_ids)
            left = {**browser, 'tab_id': left_id}; right = {**other_browser, 'tab_id': right_id}
            a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/coordinates?name=coordinateA', **left)
            a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/coordinates?name=coordinateB', **right)
            def screenshot(of):
                for _ in range(3):
                    page = a.call('browser_state', background_screenshot=True, **of)
                    if page['images']: return page
                raise AssertionError('matching browser screenshot was not returned')
            large = screenshot(right)
            small = screenshot(left)
            width = int(re.search(r'Screenshot: (\d+)', large['text'])[1])
            viewport = int(re.search(r'Viewport (\d+)', large['text'])[1])
            a.call('browser_click', x=900*width/viewport, y=225*width/viewport, **right)
            check('each browser retains its own screenshot scale', wait_until(lambda: receipts.get('coordinateB') == 1) and receipts.get('coordinateA', 0) == 0)
            a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/', **left)
            stale = a.call('browser_click', x=20, y=20, allow_error=True, **left)
            check('navigation invalidates old screenshot coordinates', stale['is_error'] and stale['structured']['action']['status'] == 'not_sent')
            a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/nested-scroll', **left)
            page = screenshot(left)
            scale = int(re.search(r'Screenshot: (\d+)', page['text'])[1]) / int(re.search(r'Viewport (\d+)', page['text'])[1])
            scroll_enabled = True
            require(wait_until(lambda: receipts.get('inner-scrolled') == 1), 'nested container scrolled')
            stale = a.call('browser_click', x=125*scale, y=125*scale, allow_error=True, **left)
            check('nested scrolling refuses stale screenshot input', stale['is_error'] and stale['structured']['action']['status'] == 'not_sent'
                  and receipts.get('inner-approve', 0) == 0 and receipts.get('inner-delete', 0) == 0)
            screenshot(left)
            a.call('browser_click', x=125*scale, y=125*scale, **left)
            check('fresh screenshot coordinates work after nested scrolling', wait_until(lambda: receipts.get('inner-delete') == 1))

            a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/probe-unavailable', **left)
            started = time.monotonic()
            unreadable = a.call('browser_wait', text='Processing', gone=True, timeout=.5, allow_error=True, **left)
            check('renderer probe failure cannot prove text disappeared', unreadable['is_error'] and 'was gone' not in unreadable['text'])
            check('wait respects its total budget', time.monotonic()-started < 2)

            a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/upload-unreadable', **left)
            upload = root/'post-upload.txt'; upload.write_text('fixture upload')
            uploaded = a.call('browser_upload', target='Upload', path=str(upload), allow_error=True, **left)
            check('upload receipt survives an unreadable result page', uploaded['is_error'] and uploaded['structured']['action']['status'] == 'sent'
                  and 'state_error' in uploaded['structured'] and wait_until(lambda: receipts.get('upload-destroy') == 1))
            # Both browsers/profiles belong to this fixture and are disposed
            # in finally. Closing the last headless tab can stop its native
            # host before Chrome acknowledges tabs.remove().
            print(f'PASS {len(checks)}/{len(checks)} browser {suite} checks', flush=True)
        except BaseException:
            log.flush()
            print((evidence_path/'chrome.log').read_text()[-1000:], file=sys.stderr)
            raise
        finally:
            for client in clients: client.close()
            for process in [chrome, chrome2]:
                if process and process.poll() is None:
                    process.terminate()
                    try: process.wait(timeout=8)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()
            log.close()
            server.shutdown(); server.server_close()

if __name__ == '__main__':
    main()
