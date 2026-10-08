#!/usr/bin/env python3
"""Window identity through reading and acting, against the scenario app, in
whatever state the Mac is in:

    python3 scripts/test_windows.py .build/debug/skfiy [--textedit]

Two windows with the same title must be told apart by id; actions go to the
window of the latest screenshot and nowhere else; a window closed and
recreated (same title, new id), a moved window, or a window_id that is not the
screenshot's are refused without sending anything. With --textedit, also two
same-named TextEdit documents, scrolled by id.
"""
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, main_binary, ocr_lines  # noqa: E402

WINDOW = re.compile(r'Window: "([^"]*)" \(id (\d+)\)')


def shown_window(result):
    match = WINDOW.search(result['text'])
    return (match[1], int(match[2])) if match else (None, None)


def button(result, label, locked):
    if not locked:
        for line in result['text'].splitlines():
            if re.search(rf'\] Button[^\n]*"{re.escape(label)}"', line):
                return {'element_index': re.search(r'\[(\d+)\]', line)[1]}
    hits = [hit for hit in ocr_lines(result['text']) if hit[0].strip() == label]
    return {'x': hits[0][1], 'y': hits[0][2]} if hits else None


def main():
    main_binary()
    with Session('windows') as s:
        app = s.app
        main_title = f'Scenario {s.nonce}'
        s.fixture.command('open_window', title=main_title, key='twin')
        s.fixture.wait(lambda st: len(st['windows']) == 2)
        time.sleep(0.5)
        numbers = sorted(w['number'] for w in s.fixture.state()['windows'])
        same = s.call('get_app_state', app=app, window=main_title)
        s.check('same-titled windows: choosing by title is refused, listing ids', same['is_error'] and all(str(n) in same['text'] for n in numbers),
                same['text'][:220])
        twin_id = next(w['number'] for w in s.fixture.state()['windows'] if w['number'] != s.fixture.state()['windows'][0]['number'])
        main_id = s.fixture.state()['windows'][0]['number']
        twin = s.call('get_app_state', app=app, window=str(twin_id), ocr=True)
        s.check('the twin by id', not twin['is_error'] and shown_window(twin)[1] == twin_id, twin['text'][:160])

        before = dict(s.fixture.state()['counters'])
        done = button(twin, 'Done', s.locked)
        mismatched = s.call('click', app=app, window_id=str(main_id), **done)
        s.check('window_id that is not the screenshot\'s: refused', mismatched['is_error'] and 'window_id' in mismatched['text']
                and s.fixture.state()['counters'] == before, mismatched['text'][:200])
        pressed = s.call('click', app=app, window_id=str(twin_id), **done)
        closed = s.fixture.wait(lambda st: len(st['windows']) == 1, timeout=4)
        after = s.fixture.state()['counters']
        s.check('the click went to the twin only (it closed, the main window got nothing)', not pressed['is_error'] and closed
                and after.get('done', 0) == before.get('done', 0) + 1 and {k: v for k, v in after.items() if k != 'done'} == {k: v for k, v in before.items() if k != 'done'},
                (before, after))

        extra = f'Scenario extra {s.nonce}'
        s.fixture.command('open_window', title=extra)
        s.fixture.wait(lambda st: len(st['windows']) == 2)
        time.sleep(0.5)
        first = s.call('get_app_state', app=app, window=extra, ocr=True)
        old_id = shown_window(first)[1]
        target = button(first, 'Done', s.locked)
        s.fixture.command('recreate', title=extra)
        s.fixture.wait(lambda st: len(st['windows']) == 2 and old_id not in [w['number'] for w in st['windows']], timeout=4)
        time.sleep(0.5)
        counts = dict(s.fixture.state()['counters'])
        stale = s.call('click', app=app, **target)
        s.check('recreated window: old screenshot refused', stale['is_error'] and s.fixture.state()['counters'] == counts, stale['text'][:220])
        fresh = s.call('get_app_state', app=app, window=extra, ocr=True)
        s.check('recreated window has a new id', not fresh['is_error'] and shown_window(fresh)[1] not in (None, old_id),
                (old_id, shown_window(fresh)))
        s.fixture.command('close_window', title=extra)
        s.fixture.wait(lambda st: len(st['windows']) == 1)

        main_state = s.call('get_app_state', app=app, ocr=True)
        apply = button(main_state, 'Apply', s.locked)
        point = apply if 'x' in apply else {'x': 20, 'y': 20}
        s.fixture.command('move', title='main', dx=-40, dy=25)
        time.sleep(0.5)
        counts = dict(s.fixture.state()['counters'])
        moved = s.call('click', app=app, **point)
        s.check('moved window: old x/y refused', moved['is_error'] and ('moved' in moved['text'] or 'no longer' in moved['text'] or 'changed' in moved['text'])
                and s.fixture.state()['counters'] == counts, moved['text'][:200])
        again = s.call('get_app_state', app=app, ocr=True)
        apply = button(again, 'Apply', s.locked)
        clicked = s.call('click', app=app, expect={'text': 'apply 1'}, **apply)
        s.check('after a fresh screenshot the same button is hit where it is now', not clicked['is_error'] and s.fixture.state()['counters'].get('apply') == 1,
                clicked['text'].splitlines()[0])
        if not s.locked:
            index_click = s.call('click', app=app, element_index=apply.get('element_index', '0'))
            s.check('element_index actions are not affected by window moves', not index_click['is_error'], index_click['text'][:120])


def textedit(s):
    """A real app: two TextEdit documents with the same name from different
    folders; scrolling one by id leaves the other where it was."""
    import subprocess
    if subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True).returncode == 0:
        s.check('TextEdit not running with the user\'s documents', False, 'skipped: TextEdit is running')
        return
    paths = []
    for name, word in (('a', 'Alpha'), ('b', 'Beta')):
        folder = s.directory / name
        folder.mkdir()
        path = folder / 'twin.txt'
        path.write_text(''.join(f'{word} line {i:03d}\n' for i in range(1, 151)))
        paths.append(path)
    subprocess.run(['open', '-g', '-F', '-a', 'TextEdit', str(paths[0])], check=True)
    time.sleep(2)
    subprocess.run(['open', '-g', '-a', 'TextEdit', str(paths[1])], check=True)
    try:
        time.sleep(2.5)
        same = s.call('get_app_state', app='TextEdit', window='twin.txt')
        s.check('TextEdit: same-named documents need an id', same['is_error'] and same['text'].count('twin') >= 2, same['text'][:220])
        states = {}
        for candidate in sorted(set(re.findall(r'\b(\d{3,6})\b', same['text']))):
            state = s.call('get_app_state', app='TextEdit', window=candidate, ocr=True)
            if not state['is_error'] and shown_window(state)[1] == int(candidate):
                words = ' '.join(label for label, _, _ in ocr_lines(state['text']))
                states['Beta' if 'Beta' in words else 'Alpha' if 'Alpha' in words else '?'] = (int(candidate), state)
        if not s.check('TextEdit: each document by its id', set(states) == {'Alpha', 'Beta'}, list(states)):
            return
        beta_id, beta = states['Beta']
        line = next(hit for hit in ocr_lines(beta['text']) if re.search(r'line 0\d\d', hit[0]))
        s.call('get_app_state', app='TextEdit', window=str(beta_id), ocr=True)
        scrolled = s.call('scroll', app='TextEdit', window_id=str(beta_id), x=line[1], y=line[2], direction='down', pages=2)
        beta_after = s.call('get_app_state', app='TextEdit', window=str(beta_id), ocr=True)
        alpha_after = s.call('get_app_state', app='TextEdit', window=str(states['Alpha'][0]), ocr=True)
        first = lambda text: min((int(m[1]) for label, _, _ in ocr_lines(text) if (m := re.search(r'line (\d{3})', label))), default=None)
        s.check('TextEdit: the Beta window scrolled', not scrolled['is_error'] and (first(beta_after['text']) or 0) > 10,
                f"Beta first line {first(beta['text'])} -> {first(beta_after['text'])}")
        s.check('TextEdit: the Alpha window did not move', first(alpha_after['text']) == 1, f"Alpha first line {first(alpha_after['text'])}")
    finally:
        subprocess.run(['pkill', '-x', 'TextEdit'])


if __name__ == '__main__':
    main()
    if '--textedit' in sys.argv:
        with Session('windows-textedit', fixture=False) as session:
            textedit(session)
