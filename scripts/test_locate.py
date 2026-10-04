#!/usr/bin/env python3
"""Semantic locating (locate, browser_locate, and target on actions), against
the scenario app in whatever state the Mac is in, and with --chrome against a
local page in Chrome for Testing:

    python3 scripts/test_locate.py .build/debug/skfiy [--textedit] [--chrome] [--restart-chrome]

Two Save buttons are listed, never guessed between; region, within (a box or
section), near and right_of pick exactly one; after the layout changes the
same description is resolved again (the moved Save is found where it is now,
or reported elsewhere when the description no longer fits). Every press is
checked in the app's or page's own counters, so a wrong pick shows.
"""
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, main_binary, ocr_lines  # noqa: E402


def candidates(text):
    return len(re.findall(r'^\s+\d+\. ', text, re.M))


def app_suite(s):
    app = s.app
    counters = lambda: dict(s.fixture.state()['counters'])
    s.call('get_app_state', app=app, ocr=True)
    source = 'recognized text' if s.locked else 'accessibility'

    both = s.call('locate', app=app, target={'name': 'Save'})
    s.check(f'locate: both Save buttons listed, none chosen ({source})', not both['is_error'] and candidates(both['text']) == 2
            and 'does not choose' in both['text'], both['text'][:300])

    before = counters()
    refused = s.call('click', app=app, target={'name': 'Save'})
    s.check('click on an ambiguous target: refused with the candidates, nothing pressed', refused['is_error'] and 'nothing was done' in refused['text']
            and candidates(refused['text']) == 2 and counters() == before, refused['text'][:300])

    def press(description, target, button):
        before = counters()
        result = s.call('click', app=app, target=target)
        after = counters()
        changed = {k: after.get(k, 0) - before.get(k, 0) for k in set(after) | set(before) if after.get(k, 0) != before.get(k, 0)}
        s.check(description, not result['is_error'] and changed == {button: 1}, f"{result['text'].splitlines()[0][:200]} | changed {changed}")
        return result

    press('region bottom-right: the bottom-right Save only', {'name': 'Save', 'region': 'bottom-right'}, 'save-bottom-right')
    press('region top (中文 "顶部"): the other Save', {'name': 'Save', 'region': '顶部'}, 'save-top-left')
    press('within the Billing box: its Edit', {'name': 'Edit', 'within': 'Billing'}, 'edit-billing')
    press('within the Profile box: its Edit', {'name': 'Edit', 'within': 'Profile'}, 'edit-profile')

    # The layout changes after the model looked: the bottom-right Save moves up.
    s.fixture.command('swap')
    s.fixture.wait(lambda st: st['swapped'])
    time.sleep(0.4)
    before = counters()
    gone = s.call('click', app=app, target={'name': 'Save', 'region': 'bottom-right'})
    s.check('after the move: bottom-right no longer fits; refused, saying where Save is now', gone['is_error'] and 'Nothing' in gone['text']
            and 'elsewhere' in gone['text'] and re.search(r'\bright\b', gone['text']) and counters() == before, gone['text'][:300])
    press('after the move: near Cancel re-resolves to where it is now', {'name': 'Save', 'near': 'Cancel'}, 'save-bottom-right')
    s.fixture.command('swap')
    s.fixture.wait(lambda st: not st['swapped'])
    time.sleep(0.4)
    press('moved back: the same description finds it again', {'name': 'Save', 'near': 'Cancel'}, 'save-bottom-right')

    missing = s.call('locate', app=app, target={'name': f'Frobnicate {s.nonce}'})
    s.check('nothing matches: an error saying so', missing['is_error'] and 'Nothing' in missing['text'], missing['text'][:200])
    both_ways = s.call('click', app=app, target='Apply', x=10, y=10)
    s.check('target together with x/y: refused', both_ways['is_error'] and 'not both' in both_ways['text'], both_ways['text'][:160])

    if s.locked:
        value = s.call('set_value', app=app, target={'name': 'Scenario input'}, value='x')
        s.check('locked: set_value by target needs accessibility, refused', value['is_error'] and 'accessibility' in value['text'], value['text'][:200])
    else:
        value = s.call('set_value', app=app, target={'role': 'text field', 'name': 'Scenario input'}, value=f'located {s.nonce[:4]}')
        s.check('unlocked: set_value by target (role + name)', not value['is_error'] and s.fixture.state().get('input') == f'located {s.nonce[:4]}',
                value['text'].splitlines()[0][:200])
        button = s.call('locate', app=app, target={'role': 'button', 'name': 'Apply'})
        s.check('unlocked: role filters by the accessibility role, with an element_index', not button['is_error'] and candidates(button['text']) == 1
                and re.search(r'\[\d+\] Button "Apply"', button['text']), button['text'][:200])


def chrome_suite(s, restart):
    import compat_baseline as compat
    compat.TOOLS.update(compat.build_tools())
    compat.ensure_server()
    pid = compat.launch_chrome(main_binary(), restart=restart)
    browser = str(pid)
    connected = compat.wait_until(lambda: not s.call('browser_tabs', browser=browser)['is_error'], timeout=60, interval=1)
    if not s.check('test browser connected', connected, f'pid {pid}'):
        return
    run = s.nonce
    opened = s.call('browser_open', browser=browser, url=f'http://127.0.0.1:{compat.PORT}/locate.html?run={run}')
    tab = int(re.search(r'tab (\d+)', opened['text'])[1])
    page = lambda: compat.page_state(run)
    compat.wait_until(lambda: page().get('run') == run, timeout=8)

    both = s.call('browser_locate', browser=browser, tab_id=tab, target={'name': 'Save', 'role': 'button'})
    if 'older than skfiy' in both['text'] and not restart:
        return chrome_suite(s, True)
    s.check('browser_locate: both Save buttons listed, none chosen', not both['is_error'] and candidates(both['text']) == 2, both['text'][:300])

    def press(description, target, button, tool='browser_click', **extra):
        before = dict(page().get('counters', {}))
        result = s.call(tool, browser=browser, tab_id=tab, target=target, **extra)
        compat.wait_until(lambda: page().get('counters', {}) != before, timeout=3)
        after = page().get('counters', {})
        changed = {k: after.get(k, 0) - before.get(k, 0) for k in set(after) | set(before) if after.get(k, 0) != before.get(k, 0)}
        s.check(description, not result['is_error'] and changed == ({button: 1} if button else {}), f"{result['text'].splitlines()[0][:200]} | changed {changed}")
        return result

    before = dict(page().get('counters', {}))
    refused = s.call('browser_click', browser=browser, tab_id=tab, target='Save')
    time.sleep(0.5)
    s.check('page: ambiguous Save refused, nothing clicked', refused['is_error'] and 'nothing was done' in refused['text']
            and page().get('counters', {}) == before, refused['text'][:200])
    press('page: region bottom-right', {'name': 'Save', 'region': 'bottom-right'}, 'save-bottom')
    press('page: within a fieldset legend (Billing)', {'name': 'Edit', 'within': 'Billing'}, 'edit-billing')
    press('page: within a card under its heading (Shipping)', {'name': 'Edit', 'within': 'Shipping'}, 'edit-shipping')

    typed = s.call('browser_type', browser=browser, tab_id=tab, target={'role': 'text field', 'right_of': 'Email'}, text=f'a{run[:4]}@example.com')
    ok = compat.wait_until(lambda: page().get('email') == f'a{run[:4]}@example.com', timeout=3)
    s.check('page: an unlabeled field found by the text to its left', not typed['is_error'] and ok, typed['text'].splitlines()[0][:200])

    press('page: rearrange the layout', 'Rearrange', 'rearrange')
    compat.wait_until(lambda: page().get('rearranged'), timeout=3)
    before = dict(page().get('counters', {}))
    gone = s.call('browser_click', browser=browser, tab_id=tab, target={'name': 'Save', 'region': 'bottom-right'})
    s.check('page: after rearranging, bottom-right no longer fits; refused, saying where Save is', gone['is_error'] and 'elsewhere' in gone['text']
            and page().get('counters', {}) == before, gone['text'][:300])
    press('page: near Cancel re-resolves to its new place', {'name': 'Save', 'near': 'Cancel'}, 'save-bottom')
    s.call('browser_close_tab', browser=browser, tab_id=tab)


def textedit_suite(s):
    """A real app: the same line in two sections of a TextEdit document.
    Lines are not accessibility elements there, so they are found by
    recognized text in either state; the caret lands on the line in the
    asked-for section, proven by a marker typed at its end."""
    import subprocess
    if subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True).returncode == 0:
        s.check('TextEdit not running with the user\'s documents', False, 'skipped: TextEdit is running')
        return
    path = s.directory / f'locate-{s.nonce}.txt'
    path.write_text('Section Alpha\n\n    item: apple\n    item: banana\n\nSection Beta\n\n    item: apple\n    item: cherry\n')
    subprocess.run(['open', '-g', '-F', '-a', 'TextEdit', str(path)], check=True)
    try:
        time.sleep(2.5)
        s.call('get_app_state', app='TextEdit', window=path.name, ocr=True)
        both = s.call('locate', app='TextEdit', target={'name': 'item: apple'})
        s.check('TextEdit: the repeated line is listed twice, none chosen', candidates(both['text']) == 2 and 'does not choose' in both['text'],
                both['text'][:300])
        if s.locked:
            # A locked click does not move TextEdit's caret (compatibility
            # finding 8), so the pick is checked by where it is on screen.
            one = s.call('locate', app='TextEdit', target={'name': 'item: apple', 'within': 'Section Beta'})
            seen = s.call('get_app_state', app='TextEdit', window=path.name, ocr=True)
            hits = sorted(ocr_lines(seen['text']), key=lambda hit: hit[2])
            beta = next((hit for hit in hits if 'Beta' in hit[0]), None)
            alpha_apple = next((hit for hit in hits if 'apple' in hit[0]), None)
            chosen = re.search(r'1\. text "item: apple" \S+ x=(\d+) y=(\d+)', one['text'])
            s.check('TextEdit: within the second section, exactly the apple line under Section Beta', not one['is_error'] and candidates(one['text']) == 1
                    and chosen and beta and int(chosen[2]) > beta[2] and alpha_apple and int(chosen[2]) != alpha_apple[2],
                    f"{one['text'][:200]} | Beta at {beta and beta[2]}")
            return
        clicked = s.call('click', app='TextEdit', target={'name': 'item: apple', 'within': 'Section Beta'})
        s.check('TextEdit: within the second section, exactly one', not clicked['is_error'] and 'Target' in clicked['text'], clicked['text'][:200])
        marker = f'MARK{s.nonce[:4].upper()}'
        s.call('press_key', app='TextEdit', key='cmd+right')
        s.call('type_text', app='TextEdit', text=f' {marker}')
        time.sleep(0.5)
        value = s.call('get_app_state', app='TextEdit', window=path.name, find=marker)
        text_value = re.search(r'value="([^"]*)', value['text'])
        content = text_value[1].replace('\\n', '\n') if text_value else ''
        s.check('TextEdit: the marker went to the apple line of Section Beta (the clicked line)',
                content.find(marker) > content.find('Section Beta') > 0 and f'apple {marker}' in content, content[:300])
    finally:
        subprocess.run(['pkill', '-x', 'TextEdit'])


def main():
    main_binary()
    with Session('locate') as s:
        app_suite(s)
    if '--textedit' in sys.argv:
        with Session('locate-textedit', fixture=False) as s:
            textedit_suite(s)
    if '--chrome' in sys.argv:
        with Session('locate-chrome', fixture=False) as s:
            chrome_suite(s, '--restart-chrome' in sys.argv)


if __name__ == '__main__':
    main()
