#!/usr/bin/env python3
"""Local web server for the compatibility and download tests.

    python3 scripts/compat_server.py --port 8766 --root scripts/fixtures --events /tmp/skfiy-compat/events

- GET  /<file>              static files from --root
- POST /event               a page report: {"event", "state": {"run", ...}}; appended to
                            <events>/<run>.jsonl, the latest state kept per run
- GET  /state?run=R         the latest state the page reported for run R ({} when none)
- GET  /download/ok?name=N&size=B        a complete attachment
- GET  /download/slow?name=N&seconds=S   an attachment that trickles in over S seconds
- GET  /download/broken?name=N           announces more bytes than it sends, then hangs up
- GET  /download/missing?name=N          404, as a broken link
- GET  /downloads.html?run=R             a page linking to all of the above
- GET  /stats?name=N&run=R               how often /download/ok served N, and how many
                                         "submit" events run R reported

It binds to 127.0.0.1 only, and never reads anything outside --root.
"""
import argparse
import json
import os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs, urlparse

STATES = {}
SERVED = {}
SUBMITS = {}
LOCK = threading.Lock()


def make_handler(root, events):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, *args):
            pass

        def send_json(self, value, status=200):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if urlparse(self.path).path != '/event':
                return self.send_json({'error': 'not found'}, 404)
            length = int(self.headers.get('Content-Length') or 0)
            try:
                report = json.loads(self.rfile.read(min(length, 1_000_000)))
            except ValueError:
                return self.send_json({'error': 'bad json'}, 400)
            run = ''.join(c for c in str(report.get('state', {}).get('run', 'none')) if c.isalnum() or c in '-_')[:64] or 'none'
            report['received'] = time.time()
            with LOCK:
                STATES[run] = report
                if report.get('event') == 'submit':
                    SUBMITS[run] = SUBMITS.get(run, 0) + 1
                with open(events / f'{run}.jsonl', 'a') as journal:
                    journal.write(json.dumps(report) + '\n')
            self.send_json({'ok': True})

        def attachment(self, name, size_hint=None):
            safe = os.path.basename(name or 'file.txt') or 'file.txt'
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', f'attachment; filename="{safe}"')
            self.send_header('Cache-Control', 'no-store')
            if size_hint is not None:
                self.send_header('Content-Length', str(size_hint))
            self.end_headers()

        def do_GET(self):
            url = urlparse(self.path)
            query = {key: values[-1] for key, values in parse_qs(url.query).items()}
            if url.path == '/state':
                with LOCK:
                    return self.send_json(STATES.get(query.get('run', ''), {}))
            if url.path == '/stats':
                with LOCK:
                    return self.send_json({'served': SERVED.get(query.get('name', ''), 0), 'submits': SUBMITS.get(query.get('run', ''), 0)})
            if url.path == '/download/ok':
                with LOCK:
                    SERVED[query.get('name', 'file.txt')] = SERVED.get(query.get('name', 'file.txt'), 0) + 1
                size = max(1, min(int(query.get('size', '2048')), 50_000_000))
                line = f"skfiy download {query.get('name', 'file.txt')} {query.get('run', '')}\n".encode()
                body = (line * (size // len(line) + 1))[:size]
                self.attachment(query.get('name'), len(body))
                self.wfile.write(body)
                return
            if url.path == '/download/slow':
                seconds = max(1.0, min(float(query.get('seconds', '20')), 120.0))
                chunks = int(seconds * 4)
                chunk = b'x' * 4096
                self.attachment(query.get('name'), len(chunk) * chunks)
                try:
                    for _ in range(chunks):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        time.sleep(0.25)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if url.path == '/download/broken':
                self.attachment(query.get('name'), 1_000_000)
                try:
                    self.wfile.write(b'y' * 1000)
                    self.wfile.flush()
                    time.sleep(0.5)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                self.close_connection = True
                self.connection.shutdown(2)
                return
            if url.path == '/download/missing':
                return self.send_json({'error': 'missing'}, 404)
            if url.path == '/downloads.html':
                run = query.get('run', 'none')
                links = [('ok', f'/download/ok?name=report-{run}.txt&run={run}'),
                         ('again', f'/download/ok?name=report-{run}.txt&run={run}'),
                         ('slow', f'/download/slow?name=slow-{run}.bin&seconds=40'),
                         ('broken', f'/download/broken?name=broken-{run}.bin'),
                         ('missing', f'/download/missing?name=missing-{run}.txt')]
                items = ''.join(f'<li><a id="{key}" href="{href}" download>Download {key}</a></li>' for key, href in links)
                # ?auto=S: the page downloads a file by itself after S seconds, as a
                # page (or the user) would, without any skfiy action just before.
                auto = query.get('auto')
                script = (f'<script>setTimeout(() => {{ const a = document.createElement("a"); a.href = "/download/ok?name=unrelated-{run}.txt";'
                          f' a.download = ""; document.body.appendChild(a); a.click(); }}, {float(auto) * 1000:.0f});</script>') if auto else ''
                body = f'<!doctype html><meta charset="utf-8"><title>skfiy downloads {run}</title><h1>Downloads</h1><ul>{items}</ul>{script}'.encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent / 'fixtures')
    parser.add_argument('--events', type=Path, default=Path('/tmp/skfiy-compat/events'))
    args = parser.parse_args()
    args.events.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(args.root.resolve(), args.events))
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
