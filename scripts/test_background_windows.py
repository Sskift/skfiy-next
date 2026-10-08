#!/usr/bin/env python3
"""Windows that are not on top, in the background, unlocked:

    SKFIY_TEST_BIN=/tmp/skfiy-wf4/bin python3 scripts/test_background_windows.py .build/debug/skfiy [--textedit] [--minimize]

The scenario app gets a second window under its main window (both under the
user's windows) with a text field of its own; the main window is the app's
key window. skfiy inspects the second window by id and must act on it, not on
the main window lying over it: x/y clicks and wheel events, a click on its
text field (which makes it the key window, as a real click would, without
raising it), typing and keys, expect verification, cmd+w, zoom. A third window
without a text field gets keys refused, not sent to the key window. The main
window, inspected by id, opens a window that takes the keyboard (as cmd+n
does): the reply shows that window and typing goes there, not back into the
main window; a window that opens on its own after the last look and takes
the keyboard gets typing refused, and so does a window worked in that has
closed (keys are not handed to a window that was open before); a sheet the main window opens shows in the
after-action screenshot and in get_app_state, and an x/y click on its button
as seen there answers it. Then the
app hides itself (an accessory app, which NSRunningApplication does not report
as hidden): x/y and wheel input is refused as hidden, not as a closed window.

--textedit: two of the test's own TextEdit documents, alpha under beta (beta
the key window): scrolling, clicking, typing and cmd+w aimed at alpha by id.
Skipped while TextEdit runs (it may hold the user's documents).
--minimize: also a minimized window (one Dock animation, so only on request).

Everything is checked outside skfiy: the scenario app's own state (field
values, key and main window, mouse and wheel events per window, buttons), and
scripts/fixtures/AXProbe.swift (TextEdit's per-window text, selection and
scroll bars; the window order; the front app). No window guard: nothing here
may put a test window on top, so the order is checked after every step
instead, and the front app must never become a test app. Each step records how
much of its target window other windows covered.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, geometry, main_binary, ocr_lines, probe, to_pixels, tool, wait_until  # noqa: E402

TEST_OWNERS = ('SkfiyScenario', 'TextEdit')


def tree_index(text, pattern):
    for line in text.splitlines():
        if re.search(pattern, line) and (m := re.search(r'\[(\d+)\]', line)):
            return int(m[1])
    return None


def covered(window_id):
    """Share of a window's area under other on-screen normal windows (0-1), and the front-to-back stack."""
    stack = probe('stack')['windows']
    rects = []
    for row in stack:
        if row['id'] == window_id:
            x, y, w, h = row['x'], row['y'], row['width'], row['height']
            # Sample a grid: exact enough to say covered / partly / not covered.
            hits = total = 0
            for i in range(40):
                for j in range(40):
                    px, py = x + (i + 0.5) * w / 40, y + (j + 0.5) * h / 40
                    total += 1
                    hits += any(rx <= px < rx + rw and ry <= py < ry + rh for rx, ry, rw, rh in rects)
            return hits / total
        rects.append((row['x'], row['y'], row['width'], row['height']))
    return None


class Watch:
    """The user's front app and the top window, around every call."""

    def __init__(self, s):
        self.s = s
        self.start = probe('front')
        self.front_changes = []
        self.test_on_top = []

    def call(self, tool_name, target=None, **arguments):
        before = probe('front')
        result = self.s.call(tool_name, **arguments)
        after = probe('front')
        if after['front'] != before['front']:
            self.front_changes.append((tool_name, before['front'], after['front']))
        if any(owner in after['front'] for owner in TEST_OWNERS) or any(owner in after['topOwner'] for owner in TEST_OWNERS):
            self.test_on_top.append((tool_name, after['front'], after['topOwner']))
        share = covered(target) if target else None
        self.s.evidence.record('conditions', tool=tool_name, target=target,
                               coverage=None if share is None else round(share, 3), front=after['front'], top=after['topOwner'])
        return result

    def finish(self):
        self.s.check('the user\'s front app never became a test app, and no test window got on top', not self.test_on_top, self.test_on_top)
        self.s.summary['frontChanges'] = self.front_changes
        if self.front_changes:
            print(f'  note: the front app changed during calls (the user switching?): {self.front_changes}', flush=True)


def window(state, title):
    return next((w for w in state['windows'] if w['title'] == title), None)


def fixture_case(s, minimize):
    w = Watch(s)
    app, fx = s.app, s.fixture
    main_title, second, third = f'Scenario {s.nonce}', f'Scenario second {s.nonce}', f'Scenario third {s.nonce}'
    # The app's key window as accessibility reports it (AppKit's keyWindow is
    # nil while the app is inactive, though keys still go to that window).
    key_window = lambda: probe('perwindow', fx.pid)['focusedWindow']
    fx.command('open_window', title=second, input=True)
    fx.wait(lambda st: window(st, second) is not None)
    state = fx.state()
    apply = state['buttons']['apply']
    frame = window(state, second)['frame']
    bar = frame['height'] - 180
    # Second's Done button exactly under main's Apply button.
    fx.command('place', title=second, x=apply['x'] + apply['width'] / 2 - 290, y=apply['y'] + apply['height'] / 2 - bar - 145)
    fx.command('key', title='main')
    time.sleep(0.6)
    state = fx.state()
    main_id, second_id = window(state, main_title)['number'], window(state, second)['number']
    s.check('setup: the main window is the key window, the second lies under it', key_window() == main_id,
            {'key': key_window(), 'main id': main_id, 'coverage of second': covered(second_id), 'coverage of main': covered(main_id)})

    look = w.call('get_app_state', second_id, app=app, window=str(second_id), ocr=True)
    s.check('inspecting the second window by id names the key window keys go to', not look['is_error']
            and f'id {second_id}' in look['text'] and 'key window' in look['text'], look['text'].splitlines()[1][:200])
    g = geometry(look['text'])
    frame = window(fx.state(), second)['frame']
    done_point = (frame['x'] + 290, frame['y'] + bar + 145)
    scroll_point = (frame['x'] + 180, frame['y'] + bar + 120)

    before = fx.state()
    scroll_px = to_pixels(g, scroll_point)
    scrolled = w.call('scroll', second_id, app=app, x=scroll_px[0], y=scroll_px[1], direction='down', pages=1)
    after = fx.state()
    got = lambda st, title, kind: (window(st, title) or {}).get('pointer', {}).get(kind, 0)
    s.check('x/y scroll where the main window covers the second: wheel events reach the second only', not scrolled['is_error']
            and got(after, second, 'scroll') > got(before, second, 'scroll') and got(after, main_title, 'scroll') == got(before, main_title, 'scroll'),
            f"second {got(before, second, 'scroll')}->{got(after, second, 'scroll')}, main {got(before, main_title, 'scroll')}->{got(after, main_title, 'scroll')}; {scrolled['text'][:120]}")
    if scrolled['images']:
        words = ' '.join(probe('ocr', scrolled['images'][0])['lines'])
        s.check('the after-action screenshot shows the second window alone', 'Done' in words and 'Apply' not in words and 'Submit' not in words, words[:200])
    else:
        s.check('the after-action screenshot shows the second window alone (unchanged from its own capture)', 'looks the same' in scrolled['text'], scrolled['text'][-200:])

    field = tree_index(look['text'], r'TextField[^\n]*Extra input')
    clicked = w.call('click', second_id, app=app, element_index=field)
    state = fx.state()
    stack = [row['id'] for row in probe('stack')['windows']]
    s.check('a click on the second window\'s field makes it the key window, without raising it',
            not clicked['is_error'] and key_window() == second_id and stack.index(main_id) < stack.index(second_id) and not state['active'],
            f"key {key_window()} (second {second_id}); order main {stack.index(main_id)} second {stack.index(second_id)}; {clicked['text'].splitlines()[0][:160]}")

    typed = w.call('type_text', second_id, app=app, text='wf4x')
    state = fx.state()
    s.check('typing goes into the second window\'s field, not the main window\'s', not typed['is_error']
            and window(state, second)['input'] == 'wf4x' and state['input'] == '', (window(state, second)['input'], state['input'], typed['text'][:120]))
    pressed = w.call('press_key', second_id, app=app, key='BackSpace')
    state = fx.state()
    s.check('a key goes to the second window too', not pressed['is_error'] and window(state, second)['input'] == 'wf4', window(state, second)['input'])

    # The app (or the user) makes the main window key again: skfiy must not follow it.
    fx.command('key', title='main')
    time.sleep(0.3)
    keys_main = fx.state()['keys'].get(main_title, 0)
    verified = w.call('type_text', second_id, app=app, text='q', expect={'value_changes': True})
    state = fx.state()
    s.check('with the main window key again, typing still reaches the second window (made key again) and is verified there',
            not verified['is_error'] and verified['text'].startswith('Verification: verified') and window(state, second)['input'] == 'wf4q'
            and state['input'] == '' and state['keys'].get(main_title, 0) == keys_main,
            (verified['text'].splitlines()[0][:120], window(state, second)['input'], state['input']))

    fx.command('open_window', title=third)
    fx.wait(lambda st: window(st, third) is not None)
    fx.command('key', title='main')
    time.sleep(0.4)
    third_id = window(fx.state(), third)['number']
    w.call('get_app_state', third_id, app=app, window=str(third_id))
    keys_before = dict(fx.state()['keys'])
    refused = w.call('press_key', third_id, app=app, key='x')
    s.check('a window without a text field, not the key window: the key is refused, not sent to the key window',
            refused['is_error'] and 'key window' in refused['text'] and fx.state()['keys'] == keys_before, refused['text'][:220])
    closed = w.call('press_key', third_id, app=app, key='cmd+w', window_id=str(third_id))
    gone = fx.wait(lambda st: window(st, third) is None, timeout=3)
    state = fx.state()
    s.check('cmd+w aimed at that window by window_id closes it, not the key window', not closed['is_error'] and gone
            and window(state, main_title) and window(state, second), (closed['text'][:160], [x['title'] for x in state['windows']]))

    look = w.call('get_app_state', second_id, app=app, window=str(second_id), ocr=True)
    g = geometry(look['text'])
    zoomed = w.call('zoom', second_id, app=app, x=0, y=g['height'] / 2, width=g['width'], height=g['height'] / 2, ocr=True)
    words = zoomed['text']
    s.check('zoom into the second window reads that window, not the main window over it',
            not zoomed['is_error'] and 'Done' in words and 'Apply' not in words and 'Noop' not in words, words[:200])

    before = dict(fx.state()['counters'])
    done_px = to_pixels(g, done_point)
    hit = w.call('click', second_id, app=app, x=done_px[0], y=done_px[1], window_id=str(second_id))
    closed = fx.wait(lambda st: window(st, second) is None, timeout=3)
    after = dict(fx.state()['counters'])
    s.check('x/y click on the second window\'s Done, under the main window\'s Apply: Done is pressed, Apply is not',
            not hit['is_error'] and closed and after.get('done', 0) == before.get('done', 0) + 1 and after.get('apply', 0) == before.get('apply', 0),
            (hit['text'].splitlines()[0][:160], before, after))
    # skfiy's own click closed the window worked in; the main window, open before, has the keyboard.
    keys_before, main_before = dict(fx.state()['keys']), fx.state()['input']
    stray = w.call('type_text', main_id, app=app, text='stray')
    state = fx.state()
    s.check('after skfiy\'s own click closed the window worked in, typing is refused, not sent to the window open before',
            stray['is_error'] and 'is closed' in stray['text'] and state['keys'] == keys_before and state['input'] == main_before,
            (stray['text'][:240], state['input']))

    if minimize:
        fx.command('open_window', title=third, input=True)
        fx.wait(lambda st: window(st, third) is not None)
        time.sleep(0.6)  # a window just opened can still be settling: capture refuses a frame that changes under it
        third_id = window(fx.state(), third)['number']
        look = w.call('get_app_state', third_id, app=app, window=str(third_id), ocr=True)
        g = geometry(look['text'])
        fx.command('minimize', title=third)
        fx.wait(lambda st: (window(st, third) or {}).get('minimized'), timeout=4)
        refused = w.call('click', third_id, app=app, x=g['width'] / 2, y=g['height'] / 2)
        s.check('x/y on a minimized window is refused as minimized, not as closed', refused['is_error'] and 'minimized' in refused['text']
                and 'closed' not in refused['text'], refused['text'][:200])
        fx.command('close_window', title=third)

    new_window_and_sheet(s, w, main_id, key_window)

    main_look = w.call('get_app_state', main_id, app=app, ocr=True)
    g = geometry(main_look['text'])
    noop = tree_index(main_look['text'], r'Button[^\n]*"Noop"')
    counters = dict(fx.state()['counters'])
    fx.command('hide')
    fx.wait(lambda st: st['hidden'], timeout=4)
    capabilities = w.call('get_app_capabilities', None, app=app)
    channels = json.loads(next(line[6:] for line in capabilities['text'].splitlines() if line.startswith('JSON: ')))['channels']
    s.check('an accessory app that hid itself is reported hidden', channels['screenshot']['available'] is False
            and 'hidden' in channels['screenshot']['detail'], channels['screenshot']['detail'])
    refused = w.call('click', main_id, app=app, x=g['width'] / 2, y=g['height'] / 2)
    s.check('x/y click in the hidden app: refused as hidden, not as a closed window', refused['is_error'] and 'hidden' in refused['text']
            and 'closed' not in refused['text'], refused['text'][:200])
    wheel = w.call('scroll', main_id, app=app, element_index=noop, direction='down')
    s.check('scroll by element_index in the hidden app: refused, not reported as done', wheel['is_error'] and 'hidden' in wheel['text'], wheel['text'][:200])
    s.check('nothing reached the hidden app', fx.state()['counters'] == counters, fx.state()['counters'])
    w.finish()


def shot_words(result):
    return ' '.join(probe('ocr', result['images'][0])['lines']) if result['images'] else ''


def new_window_and_sheet(s, w, main_id, key_window):
    """The window inspected by id opens a window that takes the keyboard (as
    cmd+n does), or a sheet: the reply shows them, and keys follow the new
    window instead of being pulled back to the inspected one."""
    app, fx = s.app, s.fixture
    main_title, new_title, late = f'Scenario {s.nonce}', f'Scenario new {s.nonce}', f'Scenario late {s.nonce}'
    fx.command('key', title='main')
    time.sleep(0.3)
    look = w.call('get_app_state', main_id, app=app, window=str(main_id))
    main_input = fx.state()['input']
    opened = w.call('click', main_id, app=app, element_index=tree_index(look['text'], r'Button[^\n]*"New window"'))
    fx.wait(lambda st: window(st, new_title) is not None)
    new_id = window(fx.state(), new_title)['number']
    words = shot_words(opened)
    s.check('an action opens a window that takes the keyboard: the reply names it and its screenshot shows it',
            not opened['is_error'] and f'id {new_id}' in opened['text'] and 'new' in words and 'Extra input' in words
            and 'Apply' not in words, (opened['text'][:300], words[:200]))
    typed = w.call('type_text', new_id, app=app, text='wfnew')
    state = fx.state()
    s.check('typing after it goes into the new window; the inspected window is not made key again',
            not typed['is_error'] and window(state, new_title)['input'] == 'wfnew' and state['input'] == main_input
            and key_window() == new_id, (window(state, new_title)['input'], state['input'], key_window(), typed['text'][:200]))

    # A window opens on its own after the last look and takes the keyboard.
    fx.command('open_window', title=late, input=True)
    fx.wait(lambda st: window(st, late) is not None)
    fx.command('key', title=late)
    time.sleep(0.4)
    late_id = window(fx.state(), late)['number']
    keys_before = dict(fx.state()['keys'])
    refused = w.call('type_text', new_id, app=app, text='zz')
    state = fx.state()
    s.check('a window opened after the last look has the keyboard: typing is refused, not pulled back with a click',
            refused['is_error'] and 'opened after the latest screenshot' in refused['text'] and key_window() == late_id
            and state['keys'] == keys_before and window(state, new_title)['input'] == 'wfnew' and window(state, late)['input'] == '',
            (refused['text'][:240], key_window(), window(state, late)['input']))
    fx.command('close_window', title=late)
    fx.command('close_window', title=new_title)
    fx.wait(lambda st: window(st, new_title) is None and window(st, late) is None)
    # The window worked in closed; the main window, open before, has the keyboard again.
    fx.command('key', title='main')
    time.sleep(0.3)
    keys_before, main_before = dict(fx.state()['keys']), fx.state()['input']
    gone = w.call('type_text', new_id, app=app, text='yy')
    state = fx.state()
    s.check('the window worked in closed: typing is refused, not sent to the window that was open before',
            gone['is_error'] and 'is closed' in gone['text'] and state['keys'] == keys_before and state['input'] == main_before,
            (gone['text'][:240], state['input']))

    look = w.call('get_app_state', main_id, app=app, window=str(main_id))
    asked = w.call('click', main_id, app=app, element_index=tree_index(look['text'], r'Button[^\n]*"Ask"'))
    fx.wait(lambda st: st['sheet'], timeout=4)
    words = shot_words(asked)
    s.check('an action opens a sheet on the inspected window: the after-action screenshot shows it',
            not asked['is_error'] and fx.state()['sheet'] and 'SHEET QUESTION' in words and 'Discard' in words, (asked['text'][:200], words[:240]))
    look = w.call('get_app_state', main_id, app=app, window=str(main_id), ocr=True)
    s.check('get_app_state of that window shows the sheet in its screenshot too', 'SHEET QUESTION' in shot_words(look), shot_words(look)[:200])
    discard = [hit for hit in ocr_lines(look['text']) if hit[0] == 'Discard']
    counters = dict(fx.state()['counters'])
    if discard:
        hit = w.call('click', main_id, app=app, x=discard[0][1], y=discard[0][2])
        closed = fx.wait(lambda st: not st['sheet'], timeout=4)
        after = fx.state()['counters']
        s.check('an x/y click on the sheet\'s Discard, as the screenshot shows it, answers the sheet',
                not hit['is_error'] and closed and after.get('sheet-discard', 0) == counters.get('sheet-discard', 0) + 1, (hit['text'][:160], after))
    else:
        s.check('the sheet\'s Discard button is in the recognized text', False, look['text'][-400:])
    if fx.state()['sheet']:
        index = tree_index(w.call('get_app_state', main_id, app=app, window=str(main_id))['text'], r'Button[^\n]*"Keep"')
        w.call('click', main_id, app=app, element_index=index)


def textedit_case(s):
    if subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True).returncode == 0:
        s.check('TextEdit is not running (it may hold the user\'s documents)', False, 'skipped: TextEdit is running')
        return
    w = Watch(s)
    folder = Path(f'/tmp/skfiy-wf4/te-{s.nonce}')
    folder.mkdir(parents=True)
    alpha, beta = folder / f'alpha-{s.nonce}.txt', folder / f'beta-{s.nonce}.txt'
    alpha.write_text(''.join(f'Alpha line {i:03d}\n' for i in range(1, 151)))
    beta.write_text(''.join(f'Beta line {i:03d}\n' for i in range(1, 151)))
    try:
        subprocess.run(['open', '-g', '-F', '-a', 'TextEdit', str(alpha)], check=True)
        pid = wait_until(lambda: int(subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True, text=True).stdout.split()[0]), timeout=10)
        wait_until(lambda: any(x['title'].startswith('alpha') for x in probe('perwindow', pid)['windows']), timeout=10)
        subprocess.run(['open', '-g', '-a', 'TextEdit', str(beta)], check=True)
        wait_until(lambda: len(probe('perwindow', pid)['windows']) == 2, timeout=10)
        time.sleep(1)
        windows = {x['title'].split('-')[0]: x for x in probe('perwindow', pid)['windows']}
        alpha_id, beta_id = windows['alpha']['id'], windows['beta']['id']
        per = lambda: {x['title'].split('-')[0]: x for x in probe('perwindow', pid)['windows']}
        key = lambda: probe('perwindow', pid)['focusedWindow']
        s.check('setup: beta is TextEdit\'s key window; alpha lies under it', key() == beta_id,
                {'key': key(), 'alpha coverage': covered(alpha_id), 'beta coverage': covered(beta_id)})

        look = w.call('get_app_state', alpha_id, app='TextEdit', window=str(alpha_id), ocr=True)
        area = tree_index(look['text'], r'ScrollArea')
        before = per()
        scrolled = w.call('scroll', alpha_id, app='TextEdit', element_index=area, direction='down', pages=2)
        time.sleep(0.4)
        after = per()
        s.check('TextEdit: scroll by element_index of alpha\'s text scrolls alpha, not beta', not scrolled['is_error']
                and after['alpha']['scroll'] != before['alpha']['scroll'] and after['beta']['scroll'] == before['beta']['scroll'],
                (before['alpha']['scroll'], after['alpha']['scroll'], before['beta']['scroll'], after['beta']['scroll']))

        look = w.call('get_app_state', alpha_id, app='TextEdit', window=str(alpha_id), ocr=True)
        g = geometry(look['text'])
        lines = [hit for hit in ocr_lines(look['text']) if hit[0].startswith('Alpha line')]
        before = per()
        point = lines[len(lines) // 2]
        scrolled = w.call('scroll', alpha_id, app='TextEdit', x=point[1], y=point[2], direction='down', pages=1, window_id=str(alpha_id))
        time.sleep(0.4)
        after = per()
        s.check('TextEdit: x/y scroll on alpha (where beta lies over it) scrolls alpha only', not scrolled['is_error']
                and after['alpha']['scroll'] != before['alpha']['scroll'] and after['beta']['scroll'] == before['beta']['scroll'],
                (before['alpha']['scroll'], after['alpha']['scroll'], before['beta']['scroll'], after['beta']['scroll']))

        look = w.call('get_app_state', alpha_id, app='TextEdit', window=str(alpha_id), ocr=True)
        text_area = tree_index(look['text'], r'TextArea')
        clicked = w.call('click', alpha_id, app='TextEdit', element_index=text_area)
        stack = [row['id'] for row in probe('stack')['windows']]
        s.check('TextEdit: clicking alpha\'s text makes alpha the key window, leaving the order alone',
                not clicked['is_error'] and key() == alpha_id and stack.index(beta_id) < stack.index(alpha_id),
                (key(), clicked['text'].splitlines()[0][:200]))
        marker = f'MARKA{s.nonce[:4].upper()} '
        typed = w.call('type_text', alpha_id, app='TextEdit', text=marker)
        time.sleep(0.4)
        now = per()
        s.check('TextEdit: typing lands in alpha, not in beta', not typed['is_error'] and marker.strip() in now['alpha']['texts'][0]['tail']
                and marker.strip() not in json.dumps(now['beta']['texts']), (now['alpha']['texts'][0]['tail'], typed['text'][:120]))

        look = w.call('get_app_state', alpha_id, app='TextEdit', window=str(alpha_id), ocr=True)
        lines = [hit for hit in ocr_lines(look['text']) if re.match(r'Alpha line \d{3}$', hit[0])]
        target = lines[len(lines) // 2]
        number = int(target[0][-3:])
        beta_before = per()['beta']['texts'][0].get('selection')
        clicked = w.call('click', alpha_id, app='TextEdit', x=target[1], y=target[2], window_id=str(alpha_id))
        time.sleep(0.3)
        content = alpha.read_text()
        start = content.index(f"Alpha line {number:03d}")
        now = per()
        location = (now['alpha']['texts'][0].get('selection') or {}).get('location', -1)
        s.check('TextEdit: an x/y click on an alpha line places alpha\'s caret on that line; beta\'s caret stays',
                not clicked["is_error"] and start <= location <= start + 15 and now['beta']['texts'][0].get('selection') == beta_before,
                (target[0], location, start, clicked['text'].splitlines()[0][:160]))

        look = w.call('get_app_state', beta_id, app='TextEdit', window=str(beta_id))
        closed = w.call('press_key', beta_id, app='TextEdit', key='cmd+w', window_id=str(beta_id))
        gone = wait_until(lambda: 'beta' not in per(), timeout=4)
        s.check('TextEdit: cmd+w aimed at beta closes beta; alpha (with its unsaved text) stays', not closed['is_error'] and gone and 'alpha' in per(),
                (closed['text'][:160], list(per())))
        w.finish()
    finally:
        for found in subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True, text=True).stdout.split():
            titles = [x['title'] for x in probe('perwindow', int(found))['windows']]
            if all(s.nonce in title for title in titles):
                subprocess.run(['kill', '-9', found])
            else:
                print(f'  note: TextEdit left running, it has other windows: {titles}', flush=True)


def main():
    main_binary()
    tool('AXProbe')
    with Session('background-windows', window_guard=False, environment={'SKFIY_CURSOR': '0'}) as s:
        if s.locked:
            s.check('the Mac is unlocked', False, 'skipped: these are the unlocked paths')
            return
        fixture_case(s, '--minimize' in sys.argv)
    if '--textedit' in sys.argv:
        with Session('background-windows-textedit', fixture=False, window_guard=False, environment={'SKFIY_CURSOR': '0'}) as s:
            textedit_case(s)


if __name__ == '__main__':
    main()
