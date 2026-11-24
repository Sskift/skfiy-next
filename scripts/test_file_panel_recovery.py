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
from scenario import probe, tool
import smoke_fixture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    args = parser.parse_args()
    smoke_fixture.build()
    pid = int(subprocess.check_output([str(tool('Launch')), smoke_fixture.APP_PATH, '--fixture-show-hidden-files'], text=True).split()[0])
    app = f'pid:{pid}'
    client = None
    try:
        client = Client(Path(args.binary).resolve(), env={'SKFIY_CURSOR': '0'})
        # The owned panel explicitly shows hidden files.
        with tempfile.TemporaryDirectory(prefix='skfiy-panel-recovery-', dir='/Users/Shared') as temp:
            root = Path(temp)
            first, second = root / 'first', root / '第二个目录 空格'
            first.mkdir()
            second.mkdir()
            long_name = 'dzfp_20261117000000000001_中文测试有限公司_20261117160235.pdf'
            files = [first / 'same.txt', second / 'same.txt', second / long_name, second / '.hidden-attachment.txt']
            for file in files:
                file.write_text('owned panel fixture: ' + file.parent.name)

            def open_panel(button):
                state = client.call('get_app_state', app=app, window='skfiy fixture', screenshot=False, ocr=False)
                client.call('click', app=app, element_index=index(state['text'], button))

            for i, file in enumerate(files):
                if i == 0:
                    client.call('click', app=app, target={'role': 'button', 'name': 'Choose file'})
                    fresh = Client(Path(args.binary).resolve(), env={'SKFIY_CURSOR': '0'})
                    try:
                        result = fresh.call('file_dialog', app=app, path=str(file))
                    finally:
                        fresh.close()
                    print('PASS first-call named click and first-call open panel selection', flush=True)
                else:
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
            absent = client.call('file_dialog', app=app, path=str(files[0]), allow_error=True)
            assert absent['is_error'] and 'not showing an Open or Save panel' in absent['text'], absent['text']
            print('PASS missing panel remains a refusal', flush=True)
    finally:
        if client: client.close()
        subprocess.run(['kill', str(pid)], check=False)


if __name__ == '__main__':
    main()
