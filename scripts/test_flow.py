#!/usr/bin/env python3
"""Flows with checkpoints, resumed after interruptions, in a real browser
(Chrome for Testing with the extension, so it runs locked or unlocked):

    python3 scripts/test_flow.py .build/debug/skfiy [--restart-chrome]

The task is download -> open -> process: download a data file, open it in a
processing page (upload by download id), count its words and submit the
count once. A scripted agent does only what flow_status names next, and the
MCP server is stopped between steps (a disconnect). Checked by the local
server's own counts: how often the file was served, how often the page
loaded it, how often a count was submitted.

- resume: interrupted after the download, and again right after the submit
  (recorded pending, never recorded done): nothing is repeated;
- takeover: the agent records "open" as pending and disconnects; the user
  (another client) opens the file; the resumed flow confirms it, no second load;
- replan: after two steps the file is deleted and the tab closed; the status
  says which steps no longer hold and to redo from the download;
- unconfirmed: the submit was recorded pending but never sent; the status
  says it is not confirmed, the agent looks, then submits exactly once;
- a checkpoint whose proof does not hold is refused.
"""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_baseline as compat  # noqa: E402
from scenario import Client, Session, main_binary  # noqa: E402

STEPS = [{'id': 'download', 'title': 'Download the data file'},
         {'id': 'open', 'title': 'Open it in the processing page'},
         {'id': 'process', 'title': 'Count its words and submit the count'}]


def server_ready():
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{compat.PORT}/stats?name=x', timeout=1).read()
        return True
    except OSError:
        return False


def stats(name, run):
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{compat.PORT}/stats?name={name}&run={run}', timeout=3).read())


class Agent:
    """Does what flow_status says is next, one step at a time, through skfiy only."""

    def __init__(self, s, browser, flow, run, file_name):
        self.s, self.browser, self.flow, self.run, self.file_name = s, browser, flow, run, file_name
        self.memory = {}

    def call(self, tool, **arguments):
        if tool.startswith('browser_'):
            arguments.setdefault('browser', self.browser)
        return self.s.call(tool, **arguments)

    def status(self):
        result = self.call('flow_status', name=self.flow)
        data = json.loads(result['text'].rsplit('JSON: ', 1)[1])
        return result, data

    def record(self, step, status, proof, **extra):
        return self.call('flow_record', name=self.flow, step=step, status=status, proof=proof, **extra)

    def tab(self):
        """The processing tab, found again by its address (tab ids are not remembered across sessions)."""
        tabs = self.call('browser_tabs')['text']
        match = re.search(rf'tab (\d+)[^\n]*process\.html\?run={self.run}', tabs)
        return int(match[1]) if match else None

    def download(self):
        url = f'http://127.0.0.1:{compat.PORT}/download/ok?name={self.file_name}&size=600&run={self.run}'
        result = self.call('browser_downloads', action='start', url=url, timeout=20)
        path = re.search(r'finished: (/.+?) \([\d.,]+ [A-Za-z]+\)\.', result['text'])
        number = re.search(r'download (\d+)', result['text'], re.I)
        assert path and number, result['text']
        self.memory.update(path=path[1], download=int(number[1]))
        return self.record('download', 'done', {'file': path[1], 'download_id': int(number[1]), 'browser': self.browser}, note=f'saved as {path[1]}')

    def open(self, record_pending_only=False):
        tab = self.tab()
        if tab is None:
            opened = self.call('browser_open', url=f'http://127.0.0.1:{compat.PORT}/process.html?run={self.run}')
            tab = int(re.search(r'tab (\d+)', opened['text'])[1])
        name = Path(self.memory.get('path') or self.download_path()).name
        proof = {'tab_id': tab, 'text': f'Loaded {name}', 'browser': self.browser}
        self.record('open', 'pending', proof)
        if record_pending_only:
            return tab
        self.call('browser_upload', tab_id=tab, target={'name': 'Data file'}, download_id=self.memory.get('download') or self.download_id())
        time.sleep(0.5)
        return self.record('open', 'done', proof)

    def download_path(self):
        flow = json.loads((Path(self.s.environment['SKFIY_FLOW_DIR']) / f'{self.flow.replace(" ", "_")}.json').read_text())
        step = next(step for step in flow['steps'] if step['id'] == 'download')
        self.memory.update(path=step['proof']['file'], download=step['proof'].get('download_id'))
        return self.memory['path']

    def download_id(self):
        self.download_path()
        return self.memory['download']

    def process(self, send=True, record_done=True):
        tab = self.tab()
        self.call('browser_click', tab_id=tab, target='Count words')
        page = self.call('browser_state', tab_id=tab, screenshot=False)['text']
        words = re.search(r'Words: (\d+)', page)[1]
        self.record('process', 'pending', {'tab_id': tab, 'text': f'Submitted {words}', 'browser': self.browser})
        self.call('browser_type', tab_id=tab, target={'name': 'Answer'}, text=words, clear=True)
        if send:
            self.call('browser_click', tab_id=tab, target={'name': 'Submit', 'role': 'button'})
            if record_done:
                time.sleep(0.4)
                return self.record('process', 'done', {'tab_id': tab, 'text': f'Submitted {words}', 'browser': self.browser})
        return None


def app_flow(flows):
    """A desktop app (the scenario app, so it runs locked too): proofs by the
    app's text and windows; the user closes a window; the app restarts."""
    with Session('flow-app', environment={'SKFIY_FLOW_DIR': str(flows)}) as s:
        app, flow = s.app, f'app {s.nonce}'
        main_title, dialog = f'Scenario {s.nonce}', f'Scenario dialog {s.nonce}'
        s.call('flow_start', name=flow, steps=['Apply the settings', 'Open the dialog', 'Keep the main window open'])
        s.call('get_app_state', app=app)
        s.call('click', app=app, target='Apply')
        first = s.call('flow_record', name=flow, step='1', status='done', proof={'app': app, 'text': 'apply 1'})
        s.check('app text proof recorded (checked now)', not first['is_error'], first['text'][:160])
        s.call('click', app=app, target='Open dialog')
        s.fixture.wait(lambda st: len(st['windows']) == 2)
        second = s.call('flow_record', name=flow, step='2', status='done', proof={'app': app, 'window': 'Scenario dialog'})
        third = s.call('flow_record', name=flow, step='3', status='done', proof={'app': app, 'window': main_title})
        s.check('window proofs recorded', not second['is_error'] and not third['is_error'], second['text'][:160])

        def reconnect():
            # A new MCP server process, as after a disconnect.
            s.client.close()
            stderr = s.directory / 'mcp.stderr'
            stderr.rename(s.directory / f'mcp.stderr.{time.time_ns()}')
            s.client = Client(s.binary, s.evidence, environment=s.environment, name='skfiy-scenario')

        def status():
            result = s.call('flow_status', name=flow)
            return result, json.loads(result['text'].rsplit('JSON: ', 1)[1])

        reconnect()
        result, data = status()
        s.check('after reconnecting all three hold', data['complete'] and not data['replan'], result['text'][:400])
        s.fixture.command('close_window', title=dialog)
        s.fixture.wait(lambda st: len(st['windows']) == 1)
        time.sleep(1.2)  # the window server lists a closed window for about a second
        result, data = status()
        s.check('the user closed the dialog: that step no longer holds, replan from it', data['replan'] and data['broken'] == ['2']
                and 'no window' in result['text'] and data['next'].startswith('2.'), result['text'][:500])
        old_pid = s.fixture.pid
        s.fixture.stop()
        (s.fixture.directory / 'control.jsonl').write_text('')
        s.fixture.next_id = 0
        s.fixture.launch()
        time.sleep(1)
        reconnect()
        result, data = status()
        s.check('the app restarted: its text is gone (step 1 broken), the main window is back under a new pid and id',
                '1' in data['broken'] and f'pid {old_pid} → {s.fixture.pid}' in result['text'] and 'closed and opened again' in result['text'],
                result['text'][:700])


def session(name, flows, binary):
    return Session(name, fixture=False, environment={'SKFIY_FLOW_DIR': str(flows), 'SKFIY_UPLOAD_WITHOUT_ASKING': '1'})


def main():
    binary = main_binary()
    compat.TOOLS.update(compat.build_tools())
    if not server_ready():
        subprocess.run(['pkill', '-f', 'compat_server.py'])
        time.sleep(0.5)
    compat.ensure_server()
    pid = compat.launch_chrome(binary, restart='--restart-chrome' in sys.argv)
    browser = str(pid)
    flows = Path('/tmp/skfiy-compat') / f'flows-{int(time.time())}'
    flows.mkdir(parents=True)

    app_flow(flows)

    def connect(s):
        return s.check('test browser connected', compat.wait_until(lambda: not s.call('browser_tabs', browser=browser)['is_error'], timeout=60, interval=1), pid)

    # resume: interrupted after the download, and right after the submit.
    with session('flow-resume-1', flows, binary) as s:
        if not connect(s):
            return
        run = s.nonce
        flow, file_name = f'report {run}', f'data-{run}.txt'
        agent = Agent(s, browser, flow, run, file_name)
        started = agent.call('flow_start', name=flow, goal='Count the words of the data file and submit the count', steps=STEPS)
        s.check('flow started', not started['is_error'], started['text'][:120])
        recorded = agent.download()
        s.check('download recorded as done, verified now', not recorded['is_error'] and 'verified now' in recorded['text'], recorded['text'][:200])
    with session('flow-resume-2', flows, binary) as s:
        agent = Agent(s, browser, flow, run, file_name)
        result, data = agent.status()
        s.check('after reconnecting: download still holds, next is open', data['next'].startswith('2.') and not data['replan']
                and '✓ 1. download' in result['text'], result['text'][:400])
        again = agent.call('flow_start', name=flow, steps=STEPS)
        s.check('flow_start on an existing flow resumes it, nothing reset', 'resuming it' in again['text'] and '✓ 1. download' in again['text'], again['text'][:200])
        agent.open()
        agent.process(send=True, record_done=False)  # the connection drops right after the submit
    with session('flow-resume-3', flows, binary) as s:
        agent = Agent(s, browser, flow, run, file_name)
        result, data = agent.status()
        s.check('the submit sent before the drop is confirmed from the page, flow complete', data['complete'] and not data['unconfirmed']
                and 'has taken effect' in result['text'], result['text'][:500])
        counts = stats(file_name, run)
        page = compat.page_state(run)
        s.check('nothing repeated: served once, loaded once, submitted once', counts['served'] == 1 and page.get('loads') == 1 and counts['submits'] == 1,
                f'{counts} loads={page.get("loads")}')
        s.check('the submitted count is correct', page.get('answer') == str(page.get('words')), page)
        tab = agent.tab()
        if tab:
            agent.call('browser_close_tab', tab_id=tab)

    # takeover: open recorded pending, the user opens the file, the flow confirms it.
    with session('flow-takeover-1', flows, binary) as s:
        run = s.nonce
        flow, file_name = f'takeover {run}', f'data-{run}.txt'
        agent = Agent(s, browser, flow, run, file_name)
        agent.call('flow_start', name=flow, steps=STEPS)
        agent.download()
        tab = agent.open(record_pending_only=True)
    with session('flow-takeover-user', flows, binary) as user:  # the user, in the browser
        user.call('browser_upload', browser=browser, tab_id=tab, target={'name': 'Data file'}, download_id=agent.memory['download'])
        time.sleep(0.5)
    with session('flow-takeover-2', flows, binary) as s:
        agent = Agent(s, browser, flow, run, file_name)
        result, data = agent.status()
        s.check('the step the user did is confirmed, not redone; next is process', data['next'].startswith('3.') and 'has taken effect' in result['text'],
                result['text'][:400])
        agent.process()
        result, data = agent.status()
        page = compat.page_state(run)
        s.check('takeover flow complete with one load and one submit', data['complete'] and page.get('loads') == 1 and stats(file_name, run)['submits'] == 1,
                f'loads={page.get("loads")} {stats(file_name, run)}')
        agent.call('browser_close_tab', tab_id=agent.tab())

    # replan: the file is deleted and the tab closed behind the flow's back.
    with session('flow-replan-1', flows, binary) as s:
        run = s.nonce
        flow, file_name = f'replan {run}', f'data-{run}.txt'
        agent = Agent(s, browser, flow, run, file_name)
        agent.call('flow_start', name=flow, steps=STEPS)
        agent.download()
        agent.open()
        path, tab = agent.memory['path'], agent.tab()
    Path(path).unlink()
    with session('flow-replan-outside', flows, binary) as other:
        other.call('browser_close_tab', browser=browser, tab_id=tab)
    with session('flow-replan-2', flows, binary) as s:
        agent = Agent(s, browser, flow, run, file_name)
        result, data = agent.status()
        s.check('replan needed: download and open no longer hold, with reasons', data['replan'] and data['broken'] == ['download', 'open']
                and 'not there any more' in result['text'] and data['next'].startswith('1.'), result['text'][:600])
        agent.download()
        agent.open()
        agent.process()
        result, data = agent.status()
        counts = stats(file_name, run)
        s.check('after the replan the flow completes; one submit', data['complete'] and counts['submits'] == 1 and counts['served'] == 2,
                f'{counts} {result["text"][-200:]}')
        agent.call('browser_close_tab', tab_id=agent.tab())

    # unconfirmed: the submit was recorded pending, but the drop came before it was sent.
    with session('flow-unconfirmed-1', flows, binary) as s:
        run = s.nonce
        flow, file_name = f'unconfirmed {run}', f'data-{run}.txt'
        agent = Agent(s, browser, flow, run, file_name)
        agent.call('flow_start', name=flow, steps=STEPS)
        agent.download()
        agent.open()
        agent.process(send=False)
        refused = agent.record('process', 'done', {'tab_id': agent.tab(), 'text': 'Submitted 999999', 'browser': browser})
        s.check('a checkpoint whose proof does not hold is refused', refused['is_error'] and 'does not hold' in refused['text'], refused['text'][:200])
        missing = agent.record('download', 'done', {'file': '/tmp/skfiy-compat/no-such-file.txt'})
        s.check('a file proof for a missing file is refused', missing['is_error'] and 'not there' in missing['text'], missing['text'][:200])
    with session('flow-unconfirmed-2', flows, binary) as s:
        agent = Agent(s, browser, flow, run, file_name)
        result, data = agent.status()
        s.check('the unsent submit is reported unconfirmed, with the warning not to repeat blindly', data['unconfirmed'] == ['process']
                and 'never repeat a submit' in result['text'] and 'check whether it happened first' in data['next'], result['text'][:500])
        page = agent.call('browser_state', tab_id=agent.tab(), screenshot=False)['text']
        s.check('looking first: the page shows it was not submitted', 'Not submitted' in page, page[:200])
        agent.process()
        result, data = agent.status()
        s.check('then submitted exactly once, flow complete', data['complete'] and stats(file_name, run)['submits'] == 1, stats(file_name, run))
        agent.call('browser_close_tab', tab_id=agent.tab())
    shutil.rmtree(flows, ignore_errors=True)


if __name__ == '__main__':
    main()
