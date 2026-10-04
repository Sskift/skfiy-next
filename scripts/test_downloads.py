#!/usr/bin/env python3
"""Browser downloads and file hand-off, on the local test site in Chrome for
Testing (its own profile; files go to /tmp/skfiy-compat/downloads):

    python3 scripts/test_downloads.py .build/debug/skfiy [--restart-chrome]

Success (the file matches what the server sent, then is uploaded to a page
by download_id), a second download of the same name renamed, a broken
transfer and a missing file reported with their reasons, a slow one still in
progress at timeout and then cancelled, and only complete downloads ever
handing out a path. The user's own downloads are not listed.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_baseline as compat  # noqa: E402
from scenario import Session, main_binary  # noqa: E402


def main():
    binary = main_binary()
    compat.TOOLS.update(compat.build_tools())
    compat.ensure_server()
    pid = compat.launch_chrome(binary, restart='--restart-chrome' in sys.argv)
    with Session('downloads', fixture=False, environment={'SKFIY_UPLOAD_WITHOUT_ASKING': '1'}) as s:
        browser = str(pid)
        connected = compat.wait_until(lambda: not s.call('browser_tabs', browser=browser)['is_error'], timeout=60, interval=1)
        if not s.check('test browser connected', connected, f'pid {pid}'):
            return
        run = s.nonce
        opened = s.call('browser_open', browser=browser, url=f'http://127.0.0.1:{compat.PORT}/downloads.html?run={run}')
        tab = int(re.search(r'tab (\d+)', opened['text'])[1])

        def index(label, page_tab=tab):
            state = s.call('browser_state', browser=browser, tab_id=page_tab, screenshot=False)
            line = next(l for l in state['text'].splitlines() if label in l and re.search(r'\[\d+\]', l))
            return int(re.search(r'\[(\d+)\]', line)[1])

        def download(label, timeout=20):
            clicked = s.call('browser_click', browser=browser, tab_id=tab, index=index(label))
            time.sleep(0.8)
            listing = s.call('browser_downloads', browser=browser)
            newest = re.search(r'download (\d+):', listing['text'])
            waited = s.call('browser_downloads', browser=browser, action='wait', download_id=int(newest[1]), timeout=timeout) if newest else None
            return clicked, newest and int(newest[1]), waited

        _, ok_id, ok = download('Download ok')
        path = re.search(r'finished: (/.+) \([\d.,]+ [A-Za-z]+\)\.', ok['text']) if ok else None
        s.check('success: complete with a local path', ok and not ok['is_error'] and path, ok['text'] if ok else 'no download')
        if path:
            data = Path(path[1]).read_bytes()
            sent = urllib.request.urlopen(f'http://127.0.0.1:{compat.PORT}/download/ok?name=report-{run}.txt&run={run}').read()
            s.check('success: the file is exactly what the server sent', hashlib.sha256(data).digest() == hashlib.sha256(sent).digest()
                    and str(compat.DOWNLOADS) in path[1], f'{len(data)} bytes at {path[1]}')
            ok_path = path[1]

        # A second click on the site: Chrome blocks automatic downloads after the first.
        s.call('browser_click', browser=browser, tab_id=tab, index=index('Download again'))
        time.sleep(1)
        waited = s.call('browser_downloads', browser=browser, action='wait', timeout=4)
        s.check('wait without id reports that no new download started (not the old one)', waited['is_error'] and 'No download started after' in waited['text'],
                waited['text'][:200])

        def start(path, timeout=20):
            result = s.call('browser_downloads', browser=browser, action='start', url=f'http://127.0.0.1:{compat.PORT}{path}', timeout=timeout)
            number = re.search(r'download (\d+)', result['text'], re.I)
            return (int(number[1]) if number else None), result

        again_id, again = start(f'/download/ok?name=report-{run}.txt&run={run}')
        again_path = re.search(r'finished: (/.+) \([\d.,]+ [A-Za-z]+\)\.', again['text'])
        s.check('same name: renamed, both files kept', again_path and again_path[1] != ok_path and Path(ok_path).exists() and Path(again_path[1]).exists(),
                f"{ok_path} | {again['text'][:200]}")

        broken_id, broken = start(f'/download/broken?name=broken-{run}.bin')
        s.check('broken transfer: failed with the reason, no path', broken['is_error'] and 'did not finish' in broken['text'] and 'finished:' not in broken['text'],
                broken['text'][:200])

        missing_id, missing = start(f'/download/missing?name=missing-{run}.txt')
        s.check('missing file: failed with the reason, no path', missing['is_error'] and 'did not finish' in missing['text'], missing['text'][:200])

        slow_id, slow = start(f'/download/slow?name=slow-{run}.bin&seconds=40', timeout=2)
        s.check('slow download: still in progress at timeout, no path handed out', slow['is_error'] and 'still downloading' in slow['text'],
                slow['text'][:200])
        if slow_id:
            cancelled = s.call('browser_downloads', browser=browser, action='cancel', download_id=slow_id)
            after = s.call('browser_downloads', browser=browser, action='wait', download_id=slow_id, timeout=5)
            s.check('cancel: reported cancelled, no path', 'cancelled' in cancelled['text'] and after['is_error'] and 'cancelled' in after['text'],
                    f"{cancelled['text']} | {after['text']}")

        upload_early = s.call('browser_upload', browser=browser, tab_id=tab, index=0, download_id=slow_id or 0)
        s.check('an unfinished download is never handed on', upload_early['is_error'] and 'not a finished file' in upload_early['text'], upload_early['text'][:160])

        # Hand-off: the finished download goes to a page's file input by id.
        page = s.call('browser_open', browser=browser, url=f'http://127.0.0.1:{compat.PORT}/compat.html?run={run}-upload')
        page_tab = int(re.search(r'tab (\d+)', page['text'])[1])
        uploaded = s.call('browser_upload', browser=browser, tab_id=page_tab, index=index('Upload file', page_tab), download_id=ok_id)
        received = compat.wait_until(lambda: compat.page_state(f'{run}-upload').get('upload'), timeout=6)
        s.check('hand-off: the page received the downloaded file', not uploaded['is_error'] and received and received['size'] == len(data)
                and run in received['head'], f"{uploaded['text'][:100]} | {received}")

        if not s.locked and subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True).returncode != 0:
            # The other hand-off: open the finished file in an app.
            opened = s.call('open_file', path=ok_path, app='TextEdit')
            time.sleep(1.5)
            shown = s.call('get_app_state', app='TextEdit', window=Path(ok_path).name)
            s.check('hand-off: open_file shows the downloaded file in TextEdit', not opened['is_error'] and run in shown['text'], shown['text'][:160])
            subprocess.run(['pkill', '-x', 'TextEdit'])

        # A download nobody asked skfiy for: another site starts one by itself 17 s later.
        other = s.call('browser_open', browser=browser, url=f'http://localhost:{compat.PORT}/downloads.html?run={run}&auto=17')
        other_tab = int(re.search(r'tab (\d+)', other['text'])[1])
        unrelated = compat.DOWNLOADS / f'unrelated-{run}.txt'
        appeared = compat.wait_until(unrelated.exists, timeout=40, interval=0.5)
        time.sleep(1)
        listing = s.call('browser_downloads', browser=browser)
        ids = {int(i) for i in re.findall(r'download (\d+):', listing['text'])}
        s.check('skfiy\'s downloads are listed', {ok_id, again_id, broken_id, missing_id, slow_id} - {None} <= ids, listing['text'][:300])
        s.check('a download skfiy did not cause is not listed', appeared and f'unrelated-{run}' not in listing['text'],
                f'file appeared: {bool(appeared)}')
        for t in (tab, page_tab, other_tab):
            s.call('browser_close_tab', browser=browser, tab_id=t)


if __name__ == '__main__':
    main()
