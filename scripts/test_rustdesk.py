#!/usr/bin/env python3
"""RustDesk (Flutter, runs as several processes) through skfiy, in the background:

    SKFIY_TEST_BIN=/tmp/skfiy-wf4/bin python3 scripts/test_rustdesk.py .build/debug/skfiy

Uses the RustDesk the user has running, so it only reads and checks
refusals; it sends RustDesk no click, key or value (a remote session forwards
input to another computer, and the main window's fields are the user's):

- "RustDesk" resolves to the UI process (regular, with windows), not to the
  windowless `RustDesk --server` copy that shares its bundle id.
- get_app_state turns Flutter's semantics on (AXEnhancedUserInterface): the
  main window's fields and buttons appear in the tree; skfiy turns the flag
  back to what it was when the session ends.
- The main window inspected by id is captured on its own, even where a
  remote-session window lies over it.
- A remote-session window is captured and labelled as such; keys, typing,
  drags and the wheel aimed at it are refused, and get_app_capabilities says so.
- set_value on a Flutter text field is refused (it would only change an
  invisible stand-in field), and the field keeps its value.

Skipped while RustDesk is the front app (the user is in it) or not running;
each step re-checks that RustDesk is still in the background and stops otherwise.
"""
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, geometry, main_binary, probe, tool  # noqa: E402
from test_background_windows import Watch, tree_index  # noqa: E402

BUNDLE = 'com.carriez.rustdesk'


def main():
    main_binary()
    tool('AXProbe')
    instances = probe('instances', BUNDLE)['instances']
    ui = [i for i in instances if i['policy'] == 'regular' and i['windows'] > 0]
    if not ui:
        sys.exit('skipped: RustDesk is not running with a window')
    if any(i['active'] for i in instances):
        sys.exit('skipped: RustDesk is the front app (the user is using it)')
    pid = ui[0]['pid']
    flag_before = probe('attribute', pid, 'AXEnhancedUserInterface').get('value')
    with Session('rustdesk', fixture=False, window_guard=False, environment={'SKFIY_CURSOR': '0'}) as s:
        if s.locked:
            s.check('the Mac is unlocked', False, 'skipped')
            return
        s.summary['instances'] = instances
        w = Watch(s)

        def background():
            front = probe('front')
            if 'RustDesk' in front['front']:
                raise RuntimeError('RustDesk came to the front (the user?): stopping')
            return front

        def windows():
            return probe('perwindow', pid)

        background()
        capabilities = w.call('get_app_capabilities', None, app='RustDesk')
        report = json.loads(next(line[6:] for line in capabilities['text'].splitlines() if line.startswith('JSON: ')))
        s.check('"RustDesk" resolves to the UI process, not the windowless server copy', report.get('pid') == pid and len(report['windows']) >= 1,
                {'pid': report.get('pid'), 'ui': pid, 'instances': instances})

        state = windows()
        main_window = next((x for x in state['windows'] if x['title'] == 'RustDesk'), None)
        remote = next((x for x in state['windows'] if 'Remote Desktop - ' in x['title']), None)
        key_before = state['focusedWindow']
        if not main_window:
            s.check('the main window is open', False, [x['title'] for x in state['windows']])
            return
        background()
        look = w.call('get_app_state', main_window['id'], app='RustDesk', window=str(main_window['id']))
        fields = [line for line in look['text'].splitlines() if re.search(r'\] (TextField|Button)', line)]
        s.check('Flutter semantics are on: the main window lists its fields and buttons', len(fields) >= 2, fields[:6])
        s.check('the main window inspected by id comes with its own screenshot', bool(look['images']) and geometry(look['text']) is not None
                and f'id {main_window["id"]}' in look['text'], look['text'].splitlines()[1][:200])
        field = tree_index(look['text'], r'\] TextField')
        if field is not None:
            before = [t for x in windows()['windows'] if x['id'] == main_window['id'] for t in x['texts']]
            background()
            refused = w.call('set_value', main_window['id'], app='RustDesk', element_index=field, value='skfiy-test')
            after = [t for x in windows()['windows'] if x['id'] == main_window['id'] for t in x['texts']]
            s.check('set_value on a Flutter text field is refused, and nothing changes', refused['is_error'] and 'Flutter' in refused['text']
                    and before == after, refused['text'][:200])

        if remote:
            background()
            shot = w.call('get_app_state', remote['id'], app='RustDesk', window=str(remote['id']))
            s.check('the remote-session window is captured and labelled as a remote session', bool(shot['images']) and 'remote session' in shot['text'],
                    shot['text'].splitlines()[1][:200])
            g = geometry(shot['text'])
            for name, arguments in (('type_text', {'text': 'x'}), ('press_key', {'key': 'a'}),
                                    ('drag', {'from_x': g['width'] * 0.5, 'from_y': g['height'] * 0.7, 'to_x': g['width'] * 0.55, 'to_y': g['height'] * 0.7}),
                                    ('scroll', {'x': g['width'] * 0.5, 'y': g['height'] * 0.6, 'direction': 'down'})):
                background()
                refused = w.call(name, remote['id'], app='RustDesk', **arguments)
                s.check(f'{name} aimed at the remote session is refused before anything is sent', refused['is_error'] and 'remote' in refused['text']
                        and 'Nothing was sent' in refused['text'], refused['text'][:200])
            capabilities = w.call('get_app_capabilities', None, app='RustDesk', window=str(remote['id']))
            channels = json.loads(next(line[6:] for line in capabilities['text'].splitlines() if line.startswith('JSON: ')))['channels']
            s.check('get_app_capabilities: no background pointer or keyboard for the remote session, screenshots yes',
                    not channels['pointer']['available'] and not channels['keyboard']['available'] and channels['screenshot']['available'],
                    (channels['pointer']['detail'][:80], channels['keyboard']['detail'][:80]))
        else:
            s.summary['remote'] = 'no remote session open: its checks were not run'
            print('  note: no remote session window is open; those checks were not run', flush=True)
        s.check('RustDesk\'s key window is the one it had (skfiy changed nothing in it)', windows()['focusedWindow'] == key_before,
                (key_before, windows()['focusedWindow']))
        w.finish()
        # Ending the MCP session turns Flutter's semantics back off.
        s.client.close()
        flag_after = probe('attribute', pid, 'AXEnhancedUserInterface').get('value')
        s.check('AXEnhancedUserInterface is back to what it was once the session ends', flag_after == flag_before, (flag_before, flag_after))
        # The screenshots show the user's RustDesk (its one-time password, the
        # remote computer's screen): checked above, not kept.
        for image in list(s.directory.glob('tool-*.jpg')) + list(s.directory.glob('tool-*.png')):
            image.unlink()
        (s.directory / 'IMAGES-REMOVED.txt').write_text('Screenshots removed after the checks: they show the user\'s RustDesk.\n')


if __name__ == '__main__':
    main()
