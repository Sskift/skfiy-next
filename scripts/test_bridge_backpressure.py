#!/usr/bin/env python3
"""Actual native host/socket fault injection, using only a temporary HOME."""
import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time


def frame(obj):
    data = json.dumps(obj).encode()
    return struct.pack('<I', len(data)) + data


def exact(fd, length):
    data = b''
    deadline = time.monotonic() + 5
    while len(data) < length:
        if not select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
            raise TimeoutError('native host output timed out')
        part = os.read(fd, length - len(data))
        if not part:
            raise EOFError('native host exited')
        data += part
    return data


def receive(host):
    length = struct.unpack('<I', exact(host.stdout.fileno(), 4))[0]
    return json.loads(exact(host.stdout.fileno(), length))


def main():
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else '.build/debug/skfiy').resolve()
    with tempfile.TemporaryDirectory(prefix='skb-', dir='/tmp') as folder:
        host = subprocess.Popen([str(binary), 'chrome-extension://backpressure-test/'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                env={**os.environ, 'HOME': folder})
        clients = []
        try:
            host.stdin.write(frame({'event': 'hello', 'browser': 'fixture', 'snapshotProtocol': 2}))
            host.stdin.flush()
            path = Path(folder) / f'Library/Application Support/skfiy/browsers/{os.getpid()}.sock'
            deadline = time.monotonic() + 5
            while not path.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            for index in (1, 2):
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                clients.append(client)
                client.settimeout(2)
                client.connect(str(path))
                client.sendall(json.dumps({'id': index, 'method': 'test', 'params': {'client': index}}).encode() + b'\n')
            requests = sorted([receive(host), receive(host)], key=lambda request: request['params']['client'])
            delivered = threading.Event()
            def large_reply():
                host.stdin.write(frame({'id': requests[0]['id'], 'result': 'x' * (4 * 1024 * 1024)}))
                host.stdin.flush()
                delivered.set()
            writer = threading.Thread(target=large_reply, daemon=True)
            writer.start()
            assert delivered.wait(5), 'host did not consume native reply'
            host.stdin.write(frame({'id': requests[1]['id'], 'result': 'second-ready'}))
            host.stdin.flush()
            started = time.monotonic()
            answer = b''
            while not answer.endswith(b'\n'):
                answer += clients[1].recv(4096)
            assert json.loads(answer) == {'id': 2, 'result': 'second-ready'}
            assert time.monotonic() - started < 2
            print('PASS unread 4 MiB response does not delay another client', flush=True)
            # The host also stops the slow writer instead of retaining it forever.
            time.sleep(5.2)
            while clients[0].recv(65536):
                pass
            print('PASS stalled client is disconnected at its write deadline', flush=True)
            writer.join(1)
        finally:
            for client in clients:
                client.close()
            host.terminate()
            try:
                host.wait(timeout=3)
            except subprocess.TimeoutExpired:
                host.kill(); host.wait()


if __name__ == '__main__':
    main()
