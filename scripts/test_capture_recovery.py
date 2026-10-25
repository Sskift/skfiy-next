#!/usr/bin/env python3
"""Inject a never-completing SCK request; verify repeated screenshots and real clicks."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from harness import Client, index
from scenario import Fixture, geometry, canvas_target, to_pixels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='skfiy-capture-recovery-') as temp:
        directory = Path(temp)
        dylib = directory / 'stall.dylib'
        subprocess.run(['clang', '-dynamiclib', '-framework', 'Foundation', '-framework', 'ScreenCaptureKit',
                        'scripts/fixtures/StalledCapture.m', '-o', str(dylib)], check=True)
        fixture = Fixture(directory, uuid.uuid4().hex[:10]).launch()
        client = Client(Path(args.binary).resolve(), env={'DYLD_INSERT_LIBRARIES': str(dylib), 'SKFIY_CURSOR': '0'})
        app = f'pid:{fixture.pid}'
        try:
            window = next(w['number'] for w in fixture.state()['windows'] if w['title'] == 'Scenario ' + fixture.nonce)
            started = time.monotonic()
            state = client.call('get_app_state', app=app, window=str(window), ocr=False)
            elapsed = time.monotonic() - started
            assert state['images'] and elapsed >= 3, f'fault injection/recovery did not run: {elapsed}'
            print('PASS stalled independent capture recovers to a real system screenshot', flush=True)
            for _ in range(3):
                state = client.call('get_app_state', app=app, window=str(window), ocr=False)
                assert state['images'], state['text']
            print('PASS three subsequent captures work in the same MCP process', flush=True)
            before = fixture.state()['counters'].get('paint', 0)
            result = client.call('click', app=app, element_index=index(state['text'], r'Button "Paint pixels"'),
                                 expect={'changed': True, 'timeout': 2})
            assert fixture.state()['counters']['paint'] == before + 1 and 'verified' in result['text'], result['text']
            print('PASS pixel-change verification works after the SCK connection stalls', flush=True)
            state = client.call('get_app_state', app=app, window=str(window), ocr=False)
            point = canvas_target(fixture.state()['canvas'])
            x, y = to_pixels(geometry(state['text']), point)
            before = len(fixture.state()['canvasClicks'])
            client.call('click', app=app, x=x, y=y)
            assert len(fixture.state()['canvasClicks']) == before + 1, fixture.state()['canvasClicks']
            assert fixture.state()['canvasClicks'][-1]['target'], fixture.state()['canvasClicks'][-1]
            print('PASS recovered image coordinates hit the actual canvas target', flush=True)
            client.call('get_app_state', app=app, window=str(window), screenshot=False, ocr=False)
            refused = client.call('click', app=app, x=point[0], y=point[1], coordinate_space='screen', allow_error=True)
            assert refused['is_error'] and 'window_id' in refused['text'], refused['text']
            client.call('click', app=app, window_id=str(window), x=point[0], y=point[1], coordinate_space='screen')
            assert len(fixture.state()['canvasClicks']) == before + 2, fixture.state()['canvasClicks']
            print('PASS explicit screen coordinates work without pixels and require a bound window', flush=True)
            # A default app-region read must recover too, not only named-window reads.
            state = client.call('get_app_state', app=app, ocr=False)
            assert state['images'], state['text']
            print('PASS app-region capture recovers in the same process', flush=True)
            client.close()
            listing = directory / 'stalled-list.dylib'
            subprocess.run(['clang', '-DSTALL_LIST', '-dynamiclib', '-framework', 'Foundation', '-framework', 'ScreenCaptureKit',
                            'scripts/fixtures/StalledCapture.m', '-o', str(listing)], check=True)
            client = Client(Path(args.binary).resolve(), env={'DYLD_INSERT_LIBRARIES': str(listing), 'SKFIY_CURSOR': '0'})
            started = time.monotonic()
            state = client.call('get_app_state', app=app, ocr=False)
            elapsed = time.monotonic() - started
            assert state['images'] and 4.5 < elapsed < 12, (elapsed, state['text'])
            state = client.call('get_app_state', app=app, ocr=False)
            assert state['images'], state['text']
            print('PASS a stalled shareable-content listing recovers without three swallowed timeouts', flush=True)
        finally:
            client.close()
            fixture.stop()


if __name__ == '__main__':
    main()
