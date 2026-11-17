#!/usr/bin/env python3
"""Navigate real sandboxed file panels whose AXBrowser is replaced on navigation.

Only an owned background fixture and temporary files are used. No foreground
approval, personal document, clipboard or browser profile is needed.
"""
import argparse
from pathlib import Path
import subprocess
import tempfile

from harness import Client, index
from scenario import open_in_background, probe
import smoke_fixture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    args = parser.parse_args()
    smoke_fixture.build()
    pid = open_in_background(smoke_fixture.APP_PATH)
    app = f'pid:{pid}'
    client = Client(Path(args.binary).resolve(), env={'SKFIY_CURSOR': '0'})
    try:
        # /Users/Shared is visible in panels and outside privacy-protected
        # folders; /tmp is intentionally hidden by the file panel.
        with tempfile.TemporaryDirectory(prefix='skfiy-panel-recovery-', dir='/Users/Shared') as temp:
            root = Path(temp)
            first, second = root / 'first', root / '第二个目录 空格'
            first.mkdir()
            second.mkdir()
            long_name = 'dzfp_20261117000000000001_中文测试有限公司_20261117160235.pdf'
            files = [first / 'same.txt', second / 'same.txt', second / long_name]
            for file in files:
                file.write_text('owned panel fixture: ' + file.parent.name)

            def open_panel(button):
                state = client.call('get_app_state', app=app, window='skfiy fixture', screenshot=False, ocr=False)
                client.call('click', app=app, element_index=index(state['text'], button))

            for file in files:
                open_panel(r'Button "Choose file')
                result = client.call('file_dialog', app=app, path=str(file))
                state = client.call('get_app_state', app=app, window='skfiy fixture', screenshot=False, ocr=False)
                assert 'status: chosen ' + str(file) in state['text'], (result['text'], state['text'])
                assert probe('front')['frontPID'] != pid, 'file navigation activated the fixture'
                print('PASS chose exact file after directory replacement: ' + str(file.relative_to(root)), flush=True)

            destination = second / 'saved result.txt'
            open_panel(r'Button "Save as')
            client.call('file_dialog', app=app, path=str(destination))
            assert destination.exists() and 'saved by the fixture' in destination.read_text()
            assert probe('front')['frontPID'] != pid, 'saving activated the fixture'
            assert not client.asked, 'background navigation requested foreground approval'
            print('PASS saved to the exact directory without foreground input', flush=True)
    finally:
        client.close()
        subprocess.run(['kill', str(pid)], check=False)


if __name__ == '__main__':
    main()
