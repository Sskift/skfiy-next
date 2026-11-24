#!/usr/bin/env python3
"""Two real MCP sessions sharing a disposable headless Chrome.
Checks independent page receipts; no user tabs, profiles, or windows.
Usage: python3 scripts/test_browser_lifecycle.py .build/debug/skfiy [all|lifecycle|outcomes]
"""
from contextlib import contextmanager
import errno
import json
import os
import re
import shutil
import signal
import socket
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
<label>Amount<input type="number" role="spinbutton" oninput="report('amount')"></label>
<label>Upload<input type="file" onchange="report('upload')"></label>
<iframe src="/frame"></iframe>
<script>function report(name){fetch('/receipt?name='+name)}</script>'''
receipts = {}
navigation_hits = {}
scroll_enabled = False
reload_child = threading.Event()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        route = urlsplit(self.path)
        navigation_hits[route.path] = navigation_hits.get(route.path, 0) + 1
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
        elif route.path == '/empty-response':
            # Deliver a real, immediate network error even on runners that
            # silently drop connections to ports without a listener.
            self.close_connection = True
            return
        elif route.path == '/popup':
            body = (ROOT/'scripts/fixtures/popup.html').read_bytes()
        elif route.path == '/destroy':
            body = b'<button onclick="fetch(\'/receipt?name=destroy\');document.documentElement.remove()">Submit and clear view</button>'
        elif route.path == '/coordinates':
            name = parse_qs(route.query).get('name', ['coordinate'])[0]
            body = f'<button style="position:absolute;left:850px;top:200px;width:100px;height:50px" onclick="fetch(\'/receipt?name={name}\')">Coordinate target</button>'.encode()
        elif route.path == '/frame':
            body = b'<button onclick="fetch(\'/receipt?name=frame\')">Frame action</button>'
        elif route.path == '/framed-controls':
            body = f'''<fieldset><legend>Main controls</legend>
<button onclick="fetch('/receipt?name=main-shared')">Shared command</button></fieldset>
<table><tr><th>Identifier</th></tr></table><label>Identifier<input></label>
<label>Alias<input></label><label>Alias<input></label>
<iframe tabindex="0" src="/frame"></iframe>
<iframe style="position:absolute;left:520px;top:220px" src="http://localhost:{self.server.server_port}/embedded-controls"></iframe>'''.encode()
        elif route.path == '/embedded-controls':
            body = b'''<section aria-label="Help panel"><button onclick="fetch('/receipt?name=panel-close')">Close</button>
<a href="#contact" onclick="fetch('/receipt?name=panel-contact')">Contact us Tell us more</a>
<button onclick="fetch('/receipt?name=panel-shared')">Shared command</button></section>
<form><div><div><div><div><div><div><button type=button>Attach evidence</button></div></div></div></div></div></div>
<input type=file hidden onchange="this.files[0].text().then(text=>fetch('/receipt?name=received-'+this.files[0].size+'-'+text))"></form>
<form><button type=button>Ambiguous upload</button><input type=file hidden><input type=file hidden></form>
<table role=presentation><tr><td><table role=presentation><tr><td><a href="#invite" onclick="fetch('/receipt?name=mail-link')">Accept invite</a></td></tr></table></td></tr></table>
<table><tr><td><a href="#a">Open details</a><a href="#b">Open details</a></td></tr>
<tr onclick="fetch('/receipt?name=action-row')"><td><a href="#detail">Review update</a></td></tr></table>'''
        elif route.path == '/label-controls':
            body = b'''<div role=log aria-label="Support chat">Fixture messages</div><div style="height:1500px"></div>
<label><span><input type=checkbox style="display:none" onchange="fetch('/receipt?name=check-'+this.checked)">Use a travel network</span></label>
<label for=region>Choose a region</label><input id=region type=radio style="opacity:0" onchange="fetch('/receipt?name=radio-'+this.checked)">
<div aria-hidden=true><label>Private control<input type=checkbox hidden></label></div>'''
        elif route.path == '/late-frame':
            body = b'''<button onclick="fetch('/receipt?name=stable')">Stable main button</button><iframe id="child" src="/frame"></iframe>
<script>addEventListener('load', async () => { if (await (await fetch('/reload-child')).text() === 'go') child.src='/new-child' })</script>'''
        elif route.path == '/reload-child':
            body = b'go' if reload_child.wait(20) else b'stop'
        elif route.path == '/new-child':
            body = b'''<button onclick="fetch('/receipt?name=replacement')">Replacement button</button>
<script>fetch('/receipt?name=child-loaded')</script>'''
        else:
            body = HTML
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def fixture_directory():
    folder = tempfile.mkdtemp(prefix='skfiy-lifecycle-')
    try:
        yield folder
    finally:
        # Chrome helpers can finish a filesystem write just as their process
        # group exits. Retry only that race, with a bounded cleanup deadline.
        deadline = time.monotonic() + 3
        while True:
            try:
                shutil.rmtree(folder)
                break
            except OSError as error:
                if error.errno != errno.ENOTEMPTY or time.monotonic() >= deadline:
                    raise
                time.sleep(.05)


def stop_browser(process):
    if process is None:
        return
    # Each fixture browser has its own session. Its renderer/utility children
    # can outlive the main process; never target the user's browser processes.
    def signal_group(value):
        try:
            os.killpg(process.pid, value)
        except ProcessLookupError:
            pass
    signal_group(signal.SIGTERM)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        signal_group(signal.SIGKILL)
        process.wait(timeout=5)
    finally:
        signal_group(signal.SIGKILL)


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
    with fixture_directory() as folder:
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
const snapshotAttempts = new Map();
chrome.scripting.executeScript = async options => {
  const tab = await chrome.tabs.get(options.target.tabId);
  if (options.func?.name === 'pageProbe' && tab.url.includes('/probe-unavailable'))
    throw new Error('fixture renderer unavailable');
  if (options.func?.name === 'pageSnapshot') {
    if (tab.url.includes('/snapshot-error')) throw new Error('Frame with ID 0 is showing error page');
    if (tab.url.includes('/snapshot-transient')) {
      const attempts = (snapshotAttempts.get(tab.id) || 0) + 1;
      snapshotAttempts.set(tab.id, attempts);
      if (attempts < 3) throw new Error('Frame with ID 0 is not ready');
    }
  }
  return executeForFixture(options);
};
""")
        try:
            host = root/'host'; shutil.copy2(binary, host)
            profile = root/'profile'
            subprocess.run([str(host), 'install-browser-bridge', '--user-data-dir', str(profile)], check=True, capture_output=True)
            # Both fixture browsers talk directly to the loopback server even
            # when this Mac has a proxy configured for normal browsing.
            chrome = subprocess.Popen([str(chrome_path/'Contents/MacOS/Google Chrome for Testing'),
                f'--user-data-dir={profile}', '--headless=new', '--no-proxy-server', '--window-size=1000,800', '--no-first-run', '--no-default-browser-check',
                '--disable-features=DisableLoadExtensionCommandLineSwitch', f'--load-extension={extension}', 'about:blank'],
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            # A clean runner has no normal-profile registration. MCP decides
            # which tools to advertise at startup, so wait for this profile's
            # actual native host before starting the two MCP sessions.
            bridge = Path.home()/'Library/Application Support/skfiy/browsers'/f'{chrome.pid}.sock'
            require(wait_until(bridge.exists, timeout=30), 'custom-profile native bridge started')
            env = {'SKFIY_CURSOR': '0', 'SKFIY_APPROVE': 'ask', 'SKFIY_BROWSER_TRACE': '1'}
            a = Client(binary, evidence=evidence('a'), env=env, answer=APPROVE); clients.append(a)
            b = Client(binary, evidence=evidence('b'), env=env); clients.append(b)
            browser = {'browser': str(chrome.pid)}
            require(wait_until(lambda: not a.call('browser_tabs', allow_error=True, **browser)['is_error'], timeout=30), 'extension connected')
            recovered = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/snapshot-transient', **browser)
            check('new tab snapshot recovers transient frame readiness without re-navigation',
                  not recovered['is_error'] and 'Approve' in recovered['text'] and navigation_hits.get('/snapshot-transient') == 1)
            a.call('browser_close_tab', tab_id=recovered['structured']['tab_id'], **browser)
            unreadable = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/snapshot-error', allow_error=True, **browser)
            unreadable_tab = unreadable.get('structured', {}).get('tab_id')
            check('unreadable new tab keeps its id and acknowledged navigation',
                  unreadable['is_error'] and unreadable_tab is not None and unreadable['structured']['action']['status'] == 'sent'
                  and 'state_error' in unreadable['structured'] and navigation_hits.get('/snapshot-error') == 1)
            a.call('browser_close_tab', tab_id=unreadable_tab, **browser)
            failed = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/empty-response', allow_error=True, **browser)
            failed_tab = {**browser, 'tab_id': failed['structured']['tab_id']}
            network_error = 'net::ERR_EMPTY_RESPONSE'
            check('real Chrome reports the connection failure for the destination', failed['is_error']
                  and failed['structured']['action']['status'] == 'sent' and network_error in failed['text'], failed['text'])
            started = time.monotonic()
            stopped = a.call('browser_wait', text='Loaded', timeout=15, allow_error=True, **failed_tab)
            check('a real network error ends a text wait promptly', stopped['is_error'] and network_error in stopped['text']
                  and time.monotonic() - started < 5, stopped['text'])
            a.call('browser_close_tab', **failed_tab)
            source = a.call('browser_open', url=f'view-source:http://127.0.0.1:{server.server_port}/', allow_error=True, **browser)
            check('source navigation retains its tab and explains the restriction', source['is_error'] and source['structured']['action']['status'] == 'sent'
                  and 'view-source' in source['structured']['state_error'], source['text'])
            a.call('browser_close_tab', tab_id=source['structured']['tab_id'], **browser)
            framed = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/framed-controls', **browser)
            panel = {**browser, 'tab_id': framed['structured']['tab_id']}
            check('cross-origin button and link are listed in page state',
                  'button "Close"' in framed['text'] and 'link "Contact us Tell us more"' in framed['text'])
            located = a.call('browser_locate', target={'role': 'button', 'name': 'Close'}, allow_error=True, **panel)
            check('a listed cross-origin button is locatable by role and name',
                  not located['is_error'] and '1 match' in located['text'] and re.search(r'\[\d+\] button "Close"', located['text']),
                  located['text'])
            shot = a.call('browser_state', background_screenshot=True, **panel)
            scale = int(re.search(r'Screenshot: (\d+)', shot['text'])[1]) / int(re.search(r'Viewport (\d+)', shot['text'])[1])
            point = a.call('browser_click', x=540*scale, y=237*scale, allow_error=True, **panel)
            check('a coordinate landing on the iframe does not claim to click its inner button',
                  point['structured']['action']['status'] == 'not_sent' and 'embedded frame' in point['text']
                  and 'panel-close' not in receipts)
            constrained = a.call('browser_locate', target={'name': 'Close', 'role': 'button', 'region': 'top-left'}, allow_error=True, **panel)
            check('an embedded frame never provides a false top-viewport position',
                  constrained['is_error'] and 'elsewhere' in constrained['text'] and 'embedded frame' in constrained['text']
                  and 'x=' not in constrained['text'])
            for name, role, receipt in [('Close', 'button', 'panel-close'), ('Contact us', 'link', 'panel-contact')]:
                a.call('browser_click', target={'name': name, 'role': role}, **panel)
                check(f'cross-origin {role} receives exactly one named click', wait_until(lambda: receipts.get(receipt) == 1))
            ambiguous = a.call('browser_click', target={'name': 'Shared command', 'role': 'button'}, allow_error=True, **panel)
            check('identical buttons in different frames are ambiguous', ambiguous['structured']['action']['status'] == 'not_sent'
                  and '2 candidates' in ambiguous['text'] and not any(k in receipts for k in ('main-shared', 'panel-shared')))
            a.call('browser_click', target={'name': 'Shared command', 'within': 'Help panel'}, **panel)
            check('section selects just the embedded button', wait_until(lambda: receipts.get('panel-shared') == 1)
                  and 'main-shared' not in receipts)
            same_frame = a.call('browser_click', target='Frame action', **panel)
            check('focusable same-origin iframe exposes its controls', same_frame['structured']['action']['status'] == 'sent'
                  and wait_until(lambda: receipts.get('frame') == 1))
            typed_field = a.call('browser_type', target='Identifier', text='named field', expect={'value': 'named field'}, **panel)
            check('typing by name resolves the editable field beside an identically named table header',
                  typed_field['structured']['verification']['status'] == 'verified')
            aliases = a.call('browser_type', target='Alias', text='ambiguous', allow_error=True, **panel)
            check('two matching editable fields still require disambiguation',
                  aliases['structured']['action']['status'] == 'not_sent' and '2 candidates' in aliases['text'])
            invitation = a.call('browser_locate', target='Accept invite', **panel)
            check('nested email rows and cells resolve to their single named link',
                  '1 match' in invitation['text'] and 'link "Accept invite"' in invitation['text'])
            a.call('browser_click', target='Accept invite', **panel)
            check('the named email link receives one click', wait_until(lambda: receipts.get('mail-link') == 1))
            rows = a.call('browser_locate', target={'name': 'Accept invite', 'role': 'row'}, **panel)
            check('explicit row lookup still lists enclosing structural rows', '2 candidates' in rows['text'])
            for name in ['Open details', 'Review update']:
                collision = a.call('browser_click', target=name, allow_error=True, **panel)
                check(name + ' preserves genuinely distinct candidates', collision['structured']['action']['status'] == 'not_sent'
                      and '2 candidates' in collision['text'] and 'action-row' not in receipts, collision['text'])
            file = root/'owned-attachment.txt'; file.write_text('local')
            prompts = len(a.asked)
            for name, paths in [('Shared command', [str(file)]), ('Ambiguous upload', [str(file)]), ('Attach evidence', [str(file)] * 2)]:
                # Scope the shared command to the frame so the file-association check actually runs.
                locator = {'name': name, 'role': 'button'}
                if name == 'Shared command': locator['within'] = 'Help panel'
                refusal = a.call('browser_upload', target=locator, paths=paths, allow_error=True, **panel)
                check(name + ' refuses an ineligible upload before approval', refusal['structured']['action']['status'] == 'not_sent'
                      and len(a.asked) == prompts and ('file input' in refusal['text'].lower()), refusal['text'])
            for content in ('local', ''):
                file.write_text(content)
                result = a.call('browser_upload', target={'name': 'Attach evidence', 'role': 'button'}, path=str(file), **panel)
                check(f'embedded upload delivers exactly {len(content)} bytes once to the approved origin',
                      result['structured']['action']['status'] == 'sent' and f'http://localhost:{server.server_port}' in a.asked[-1]
                      and wait_until(lambda: receipts.get(f'received-{len(content)}-{content}') == 1))
            a.call('browser_close_tab', **panel)
            controls = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/label-controls', **browser)
            form = {**browser, 'tab_id': controls['structured']['tab_id']}
            scroll = a.call('browser_scroll', **form)
            check('an omitted direction scrolls the page down', 'Scrolled down:' in scroll['text'])
            check('a named ARIA log is locatable', '1 match' in a.call('browser_locate', target={'name': 'Support chat', 'role': 'log'}, **form)['text'])
            wrong = a.call('browser_click', target={'name': 'Use a travel network', 'role': 'radio'}, allow_error=True, **form)
            check('an explicit wrong role shows the real control and sends no click', wrong['structured']['action']['status'] == 'not_sent'
                  and 'checkbox "Use a travel network"' in wrong['text'] and 'check-true' not in receipts)
            for role, label, receipt in [('checkbox', 'Use a travel network', 'check-true'), ('radio', 'Choose a region', 'radio-true')]:
                result = a.call('browser_click', target={'name': label, 'role': role}, **form)
                check(role + ' behind a visible label toggles once, including offscreen', 'checked' in result['text']
                      and wait_until(lambda: receipts.get(receipt) == 1))
            check('accessibility-hidden labels stay excluded', 'Private control' not in controls['text'])
            a.call('browser_close_tab', **form)
            late = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/late-frame', **browser)
            late_tab = {**browser, 'tab_id': late['structured']['tab_id']}
            main_index = int(re.search(r'\[(\d+)\] button "Stable main button"', late['text'])[1])
            child_index = int(re.search(r'\[(\d+)\] button "Frame action"', late['text'])[1])
            reload_child.set()
            require(wait_until(lambda: receipts.get('child-loaded') == 1), 'embedded document navigated')
            stale_child = a.call('browser_click', index=child_index, allow_error=True, **late_tab)
            check('navigation invalidates the old same-origin child index',
                  stale_child['structured']['action']['status'] == 'not_sent' and receipts.get('frame') == 1 and 'replacement' not in receipts)
            a.call('browser_click', index=main_index, **late_tab)
            check('the original main-document button still receives its indexed click', wait_until(lambda: receipts.get('stable') == 1))
            a.call('browser_close_tab', **late_tab)
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
                check('same-origin frame indices remain bound and usable', wait_until(lambda: receipts.get('frame') == 2))
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
            amount = a.call('browser_type', target={'name': 'Amount', 'role': 'spinbutton'}, text='12.5', clear=True,
                            expect={'value': '12.5'}, **target)
            check('observed spinbutton role locates and types a real numeric input',
                  amount['structured']['verification']['status'] == 'verified' and wait_until(lambda: receipts.get('amount') == 1))
            for tool, extra in [('browser_click', {'idempotent': False}), ('browser_press_key', {'key': 'cmd+Up'})]:
                refused = a.call(tool, target='Noop', trusted=True, allow_error=True, **extra, **target)
                check(tool + ' rejects hidden trusted input as not_sent',
                      refused['is_error'] and refused['structured']['action']['status'] == 'not_sent'
                      and 'tab is in the background' in refused['text'])
            retry = a.call('browser_click', target='Noop', idempotent=False, **target)
            check('a refused trusted click does not block the first actual click as a duplicate',
                  retry['structured']['action']['status'] == 'sent')

            # Both entry points must choose on the first click and release the
            # animated portal, while the browser's original active tab stays put.
            front_tabs = lambda text: re.findall(r'tab (\d+) \[(?:shown|front tab of its window)\]', text)
            front_before = front_tabs(a.call('browser_tabs', **browser)['text'])
            def bridge_request(method, params):
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.settimeout(10); connection.connect(str(bridge))
                    connection.sendall((json.dumps({'id': 1, 'method': method, 'params': params})+'\n').encode())
                    with connection.makefile('r') as response:
                        result = json.loads(response.readline())
                require('error' not in result, str(result))
                return result['result']
            for mode in ['index', 'coordinates']:
                popup = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/popup?case={mode}', **browser)
                popup_target = {**browser, 'tab_id': popup['structured']['tab_id']}
                a.call('browser_click', target='New expense', **popup_target)
                opened_menu = a.call('browser_click', target='Expense category', **popup_target)
                check(f'{mode}: background menu stays open', 'option "Cloud"' in opened_menu['text']
                      and receipts.get(f'popup-unexpected-blur-{mode}', 0) == 0)
                if mode == 'index':
                    selected = a.call('browser_click', index=int(re.search(r'\[(\d+)\] option "Cloud"', opened_menu['text'])[1]), **popup_target)
                else:
                    # Capture would blur an open menu. Exercise coordinate
                    # dispatch through the bridge with its session/geometry guards.
                    state = bridge_request('state', {'tab_id': popup_target['tab_id'], 'session_id': 'popup-coordinates'})
                    result = bridge_request('act', {'tab_id': popup_target['tab_id'], 'session_id': state['session_id'],
                        'snapshot_id': state['snapshot_id'], 'action': 'click', 'x': 180, 'y': 210, 'coordinate_geometry': state['geometry']})
                    require(result['action_status'] == 'sent' and not result.get('error'), str(result))
                    selected = a.call('browser_state', screenshot=False, **popup_target)
                check(f'{mode}: first click selects once in a hidden tab and removes the closing portal',
                      wait_until(lambda: receipts.get(f'popup-selected-hidden-{mode}') == 1 and receipts.get(f'popup-dismissed-{mode}') == 1)
                      and 'Selected Cloud' in selected['text'] and 'option "Cloud"' not in selected['text'])
                a.call('browser_close_tab', **popup_target)
            check('popup selection leaves the original active tab unchanged', front_tabs(a.call('browser_tabs', **browser)['text']) == front_before)

            destroyed = a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/destroy', **browser)
            destroy_target = {**browser, 'tab_id': int(re.search(r'tab (\d+)', destroyed['text'])[1])}
            receipt = a.call('browser_click', target='Submit and clear view', allow_error=True, **destroy_target)
            check('failed post-action snapshot preserves the sent acknowledgement', receipt['is_error'] and receipt['structured']['action']['status'] == 'sent'
                  and 'state_error' in receipt['structured'] and wait_until(lambda: receipts.get('destroy') == 1))
            a.call('browser_close_tab', **destroy_target)

            profile2 = root/'profile2'
            subprocess.run([str(host), 'install-browser-bridge', '--user-data-dir', str(profile2)], check=True, capture_output=True)
            chrome2 = subprocess.Popen([str(chrome_path/'Contents/MacOS/Google Chrome for Testing'),
                f'--user-data-dir={profile2}', '--headless=new', '--no-proxy-server', '--window-size=2000,1000', '--no-first-run', '--no-default-browser-check',
                '--disable-features=DisableLoadExtensionCommandLineSwitch', f'--load-extension={extension}', 'about:blank'], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
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
                  and stale['images'] and receipts.get('inner-approve', 0) == 0 and receipts.get('inner-delete', 0) == 0)
            # Use the fresh image returned with the refusal, without an extra browser_state.
            a.call('browser_click', x=125*scale, y=125*scale, **left)
            check('fresh screenshot coordinates work after nested scrolling', wait_until(lambda: receipts.get('inner-delete') == 1))

            a.call('browser_open', url=f'http://127.0.0.1:{server.server_port}/probe-unavailable', **left)
            started = time.monotonic()
            unreadable = a.call('browser_wait', text='Processing', gone=True, timeout=.5, allow_error=True, **left)
            check('renderer probe failure reports the reason while text presence is unknown',
                  unreadable['is_error'] and 'fixture renderer unavailable' in unreadable['text'] and 'was gone' not in unreadable['text'])
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
                stop_browser(process)
            log.close()
            server.shutdown(); server.server_close()

if __name__ == '__main__':
    main()
