#!/usr/bin/env python3
"""Two real MCP sessions sharing a disposable headless Chrome.
Checks independent page receipts; no user tabs, profiles, or windows.
Usage: python3 scripts/test_browser_lifecycle.py .build/debug/skfiy
"""
import json
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
from harness import APPROVE, Client, ROOT, require, wait_until

HTML = b'''<!doctype html><meta charset="utf-8"><title>Lifecycle fixture</title>
<div id="buttons"><button id="approve" onclick="report('approve')">Approve</button><button id="delete" onclick="report('delete')">Delete</button></div>
<button onclick="buttons.prepend(document.getElementById('delete'));report('reverse')">Reverse</button>
<label>Message<input id="message" oninput="report('type')"></label>
<label>Upload<input type="file" onchange="report('upload')"></label>
<iframe src="/frame"></iframe>
<script>function report(name){fetch('/receipt?name='+name)}</script>'''
receipts = {}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        route = urlsplit(self.path)
        if route.path == '/receipt':
            name = parse_qs(route.query)['name'][0]
            receipts[name] = receipts.get(name, 0) + 1
            body = b'ok'
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
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT/'.build/debug/skfiy').resolve()
    chrome_path = chrome_app()
    require(chrome_path, 'Chrome for Testing is required; this test never downloads or uses a personal browser.')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    clients = []
    chrome = None
    checks = []
    def check(name, condition):
        require(condition, name)
        checks.append(name); print('PASS ' + name, flush=True)
    with tempfile.TemporaryDirectory(prefix='skfiy-lifecycle-') as folder:
        root = Path(folder)
        log = (root/'chrome.log').open('w')
        try:
            host = root/'host'; shutil.copy2(binary, host)
            profile = root/'profile'
            subprocess.run([str(host), 'install-browser-bridge', '--user-data-dir', str(profile)], check=True, capture_output=True)
            chrome = subprocess.Popen([str(chrome_path/'Contents/MacOS/Google Chrome for Testing'),
                f'--user-data-dir={profile}', '--headless=new', '--window-size=1000,800', '--no-first-run', '--no-default-browser-check',
                '--disable-features=DisableLoadExtensionCommandLineSwitch', f'--load-extension={ROOT/"browser-extension"}', 'about:blank'],
                stdout=log, stderr=subprocess.STDOUT)
            env = {'SKFIY_CURSOR': '0', 'SKFIY_APPROVE': 'ask'}
            a = Client(binary, env=env, answer=APPROVE); clients.append(a)
            b = Client(binary, env=env); clients.append(b)
            browser = {'browser': str(chrome.pid)}
            require(wait_until(lambda: not a.call('browser_tabs', allow_error=True, **browser)['is_error'], timeout=30), 'extension connected')
            opened = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/', **browser)
            tab = int(re.search(r'tab (\d+)', opened['text'])[1]); target = {**browser, 'tab_id': tab}
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
            a.call('browser_close_tab', **target)
            print(f'PASS {len(checks)}/{len(checks)} browser lifecycle checks', flush=True)
        except BaseException:
            log.flush()
            print((root/'chrome.log').read_text()[-2000:], file=sys.stderr)
            raise
        finally:
            for client in clients: client.close()
            if chrome and chrome.poll() is None:
                chrome.terminate()
                try: chrome.wait(timeout=8)
                except subprocess.TimeoutExpired: chrome.kill(); chrome.wait()
            log.close()
            server.shutdown(); server.server_close()

if __name__ == '__main__':
    main()
