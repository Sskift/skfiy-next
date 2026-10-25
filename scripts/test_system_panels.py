#!/usr/bin/env python3
"""Real sandboxed AppKit panels, exact AX paths and honest open_file receipts.

Uses a dedicated fixture. Brief foreground operations are approved by this
test and restore the previous app; no personal app receives input.
"""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile

from harness import APPROVE, Client, index, frontmost
from scenario import open_in_background, probe
import smoke_fixture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    args = parser.parse_args()
    smoke_fixture.build()
    pid = open_in_background(smoke_fixture.APP_PATH)
    app = f'pid:{pid}'
    client = Client(Path(args.binary).resolve(), answer=APPROVE, env={'SKFIY_CURSOR': '0'})
    try:
        with tempfile.TemporaryDirectory(prefix='skfiy-system-panels-') as temp:
            folder = Path(temp).resolve()
            for name in ['ignored.txt', 'ignored.zip']:
                file = folder / name
                file.write_text('skfiy test fixture\n')
                result = client.call('open_file', app=app, path=str(file), allow_error=True)
                assert result['is_error'] and result['structured']['open_status'] == 'unverified', result['text']
                assert result['structured']['request_accepted']
            print('PASS accepted but ignored txt/zip requests never report Opened', flush=True)
            file = folder / 'skfiy-open-verified.txt'
            file.write_text('verified fixture\n')
            result = client.call('open_file', app=app, path=str(file))
            assert result['structured']['open_status'] == 'verified', result['text']
            print('PASS a matching document URL confirms a real open', flush=True)

            state = client.call('get_app_state', app=app, window='skfiy fixture', ocr=False)
            client.call('click', app=app, element_index=index(state['text'], r'Button "Choose file'))
            client.call('get_app_state', app=app, ocr=False)
            previous = frontmost()
            client.call('run_in_front', app=app, key='cmd+shift+g')
            assert frontmost() == previous, 'foreground was not restored after opening Go To'
            state = client.call('get_app_state', app=app, ocr=False)
            window = re.search(r'Window:.*?\(id (\d+)\)', state['text'])[1]
            state = client.call('get_app_state', app=app, window=window, ocr=False)
            assert state['images'], state['text']
            field = index(state['text'], r'TextField(?: value=| settable)')
            client.call('click', app=app, element_index=field)
            client.call('press_key', app=app, key='cmd+a')
            path = folder / '路径 空格.txt'
            path.write_text('file chosen through skfiy\n')
            client.call('type_text', app=app, text=str(path))
            actual = probe('dump', pid)
            assert actual['focused']['value'] == str(path), actual.get('focused')
            print('PASS floating Go To sheet is selectable by ID and receives an exact AX path', flush=True)
            state = client.call('get_app_state', app=app, window=window, ocr=False)
            assert f'(id {window})' in state['text'] and str(path) in state['text'], state['text']
            previous = frontmost()
            client.call('run_in_front', app=app, key='Return')
            assert len(client.asked) == 1, client.asked
            assert frontmost() == previous, 'foreground was not restored'
            state = client.call('get_app_state', app=app, ocr=False)
            client.call('click', app=app, element_index=index(state['text'], r'Button "Open"'))
            state = client.call('get_app_state', app=app, ocr=False)
            assert 'status: chosen ' + str(path) in state['text'], state['text']
            print('PASS file selection completes entirely through skfiy with one foreground approval', flush=True)
    finally:
        client.close()
        subprocess.run(['kill', str(pid)], check=False)


if __name__ == '__main__':
    main()
