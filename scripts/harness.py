#!/usr/bin/env python3
"""The MCP client and small helpers every test script shares.

    from harness import APPROVE, Client
    client = Client('.build/debug/skfiy', answer=APPROVE)
    result = client.call('get_app_state', app='TextEdit')   # {'text', 'images', 'is_error'}

A client never writes the user's action log: with an Evidence folder the log,
the emergency-stop flag, stderr, every reply and every screenshot go there;
without one the log is off. Given an answer (APPROVE or DECLINE) it tells
skfiy that it can ask the user, and gives that answer to every approval
skfiy asks for; without one, skfiy cannot ask.
"""
import base64
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parent.parent
# Answers to skfiy's approval questions (MCP elicitation).
APPROVE = {'action': 'accept', 'content': {'allow': True}}
DECLINE = {'action': 'decline'}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_until(check, timeout=8, interval=0.1, errors=(OSError, ValueError, KeyError)):
    """check's first truthy value within timeout, else its last; errors count as not yet."""
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        try:
            value = check()
        except errors:
            value = None
        if value:
            return value
        time.sleep(interval)
    return value


class Evidence:
    def __init__(self, directory):
        self.directory = directory
        self.events = (directory / 'harness.jsonl').open('x', buffering=1)
        self.sequence = 0

    def record(self, event, **details):
        self.sequence += 1
        row = {'sequence': self.sequence, 'timestamp': time.time(), 'monotonic': time.monotonic(), 'event': event, **details}
        self.events.write(json.dumps(row, ensure_ascii=False) + '\n')
        return row


class Client:
    def __init__(self, binary, evidence=None, *, env=None, answer=None, name='skfiy-test'):
        self.evidence = evidence
        self.answer = answer
        self.asked = []  # the approvals skfiy asked for
        self.next_id = 0
        self.inbox = queue.Queue()
        own = {}
        if evidence:
            own = {'SKFIY_ACTION_LOG': str(evidence.directory / 'actions.jsonl'), 'SKFIY_STOP_FILE': str(evidence.directory / 'stopped')}
        self.stderr = (evidence.directory / 'mcp.stderr').open('x') if evidence else None
        self.proc = subprocess.Popen([str(binary), 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.stderr, text=True, bufsize=1,
                                     env={**os.environ, 'SKFIY_ACTION_LOG': 'off', **(env or {}), **own})

        def read():
            try:
                for line in self.proc.stdout:
                    self.inbox.put(json.loads(line))
            except Exception as error:
                self.inbox.put(error)
            finally:
                self.inbox.put(EOFError('MCP stdout closed'))

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        try:
            self.info = self.request('initialize', {'protocolVersion': '2025-11-25',
                                                    'capabilities': {'elicitation': {'form': {}}} if answer else {},
                                                    'clientInfo': {'name': name, 'version': '1'}})
            self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        except BaseException:
            self.close()
            raise

    def send(self, value):
        self.proc.stdin.write(json.dumps(value) + '\n')
        self.proc.stdin.flush()

    def request(self, method, params, timeout=25):
        self.next_id += 1
        request_id = self.next_id
        self.send({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while True:
            reply = self.inbox.get(timeout=max(0.01, deadline - time.monotonic()))
            if isinstance(reply, Exception):
                raise reply
            if reply.get('method') == 'elicitation/create':
                message = reply['params']['message']
                self.asked.append(message)
                self.send({'jsonrpc': '2.0', 'id': reply['id'], 'result': self.answer or DECLINE})
                if self.evidence:
                    self.evidence.record('elicitation', message=message, answer=self.answer)
                require(self.answer, f'skfiy asked a client that cannot ask: {message}')
                continue
            if reply.get('id') != request_id:
                if self.evidence:
                    self.evidence.record('mcp_notification', message=reply)
                require(time.monotonic() < deadline, 'MCP reply deadline elapsed')
                continue
            if 'error' in reply:
                raise RuntimeError(reply['error'])
            return reply['result']

    def call(self, tool, allow_error=False, rpc_timeout=25, **arguments):
        """The result's text, its screenshots (paths in the evidence folder, else
        the image bytes) and whether skfiy reported an error, which raises
        RuntimeError unless allow_error."""
        began = time.time()
        result = self.request('tools/call', {'name': tool, 'arguments': arguments}, timeout=rpc_timeout)
        text = '\n'.join(block['text'] for block in result.get('content', []) if block.get('type') == 'text')
        images = []
        for offset, block in enumerate(result.get('content', [])):
            if block.get('type') == 'image':
                image = base64.b64decode(block['data'], validate=True)
                if self.evidence:
                    path = self.evidence.directory / f"tool-{self.next_id:03d}-{offset}{'.png' if block.get('mimeType') == 'image/png' else '.jpg'}"
                    path.write_bytes(image)
                    image = str(path)
                images.append(image)
        if self.evidence:
            self.evidence.record('tool', tool=tool, arguments=arguments, started=began,
                                 is_error=bool(result.get('isError')), text=text, images=images)
        if result.get('isError') and not allow_error:
            raise RuntimeError(f'{tool}: {text}')
        return {'text': text, 'images': images, 'is_error': bool(result.get('isError'))}

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except BrokenPipeError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)
        self.reader.join(timeout=1)
        if self.stderr:
            self.stderr.close()


def frontmost():
    """The front app, as lsappinfo names it."""
    asn = subprocess.run(['lsappinfo', 'front'], capture_output=True, text=True).stdout.strip()
    return subprocess.run(['lsappinfo', 'info', '-only', 'name', asn], capture_output=True, text=True).stdout.strip()


def index(tree, pattern):
    """The element index on the first line of tree that matches pattern."""
    for line in tree.splitlines():
        found = re.search(pattern, line) and re.search(r'\[(\d+)\]', line)
        if found:
            return int(found[1])
    raise AssertionError(f'no element matches {pattern!r}')


def status(text):
    """What a test page or app shows on its "status: …" line."""
    match = re.search(r'status: ([^"\n]*)', text)
    return match[1] if match else '?'


results = []  # every case() so far, passed or not


def case(name, run, expect):
    """One capability, scored on its own: what run returns, or the error it
    raises, must match the regular expression expect."""
    try:
        observed = run()
    except Exception as error:  # noqa: BLE001 - scored, not raised
        observed = f'error: {error}'
    ok = re.search(expect, observed) is not None
    results.append(ok)
    print(f"  {'✔' if ok else '✘'} {name}: {observed}")
    return ok
