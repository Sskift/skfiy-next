#!/usr/bin/env python3
"""Action outcome verification (expect) against the scenario app, in whatever
state the Mac is in:

    python3 scripts/test_verify.py .build/debug/skfiy [--textedit]

A real success is verified; a click that does nothing is no_effect; another
change is timeout; the window closing or another opening is target_changed;
window_opened / window_closed are verified; failures bring the current state;
an unverified Submit is not repeated blindly (refused until the state is
looked at, and then allowed), with the app's own submission count as proof.
With --textedit, also typing, a key without effect, scrolling and closing in
a TextEdit document.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Session, main_binary, ocr_find, ocr_lines, open_in_background  # noqa: E402


def verdict(result):
    match = re.search(r'Verification: (\w+)', result['text'])
    return match[1] if match else None


def main():
    main_binary()
    with Session('verify') as s:
        app = s.app

        def target(label, window=None):
            state = s.call('get_app_state', app=app, ocr=True, **({'window': window} if window else {}))
            if not s.locked:
                for line in state['text'].splitlines():
                    if re.search(rf'\] (Button|TextField)[^\n]*"{re.escape(label)}"', line):
                        return {'element_index': re.search(r'\[(\d+)\]', line)[1]}
            # The button's own label exactly: "apply 1" in the status line is not the Apply button.
            hits = [hit for hit in ocr_lines(state['text']) if hit[0].strip() == label]
            hit = min(hits, key=lambda h: (h[2], h[1])) if hits else ocr_find(state['text'], label)
            return {'x': hit[1], 'y': hit[2]} if hit else None

        counters = lambda: s.fixture.state()['counters']

        result = s.call('click', app=app, expect={'text': 'apply 1'}, **target('Apply'))
        s.check('real success: verified', verdict(result) == 'verified' and not result['is_error'] and counters().get('apply') == 1,
                result['text'].splitlines()[0])

        result = s.call('click', app=app, expect={'text': 'noop 1', 'timeout': 2}, **target('Noop'))
        s.check('click without effect: no_effect', verdict(result) == 'no_effect' and result['is_error'], result['text'].splitlines()[0])
        s.check('...although the app received it', counters().get('noop') == 1, counters())
        s.check('failure brings the current state', 'Current state:' in result['text'] and result['images'], result['text'][-200:])

        result = s.call('click', app=app, expect={'text': f'never {s.nonce}', 'timeout': 2}, **target('Apply'))
        s.check('other change: timeout', verdict(result) == 'timeout' and counters().get('apply') == 2, result['text'].splitlines()[0])

        dialog = f'Scenario dialog {s.nonce}'
        result = s.call('click', app=app, expect={'window_opened': 'dialog'}, **target('Open dialog'))
        s.check('window_opened verified', verdict(result) == 'verified' and len(s.fixture.state()['windows']) == 2, result['text'].splitlines()[0])
        result = s.call('click', app=app, expect={'text': f'never {s.nonce}', 'timeout': 3}, **target('Done', window=dialog))
        s.check('window closing instead: target_changed', verdict(result) == 'target_changed' and 'closed' in result['text'].splitlines()[0],
                result['text'].splitlines()[0])
        s.call('click', app=app, **target('Open dialog'))
        s.fixture.wait(lambda st: len(st['windows']) == 2)
        result = s.call('click', app=app, expect={'window_closed': True}, **target('Done', window=dialog))
        s.check('window_closed verified', verdict(result) == 'verified' and len(s.fixture.state()['windows']) == 1, result['text'].splitlines()[0])

        if s.locked:
            result = s.call('click', app=app, expect={'value_changes': True}, **target('Apply'))
            s.check('value expectations refused while locked, nothing sent', result['is_error'] and 'need accessibility' in result['text']
                    and counters().get('apply') == 2, result['text'][:160])
        else:
            field = target('Scenario input')
            result = s.call('set_value', app=app, element_index=field['element_index'], value=f'v{s.nonce[:4]}', expect={'value': f'v{s.nonce[:4]}'})
            s.check('value verified', verdict(result) == 'verified', result['text'].splitlines()[0])

        # A submit whose effect is not verified must not be repeated blindly.
        field = target('Scenario input')
        s.call('click', app=app, **field)
        s.call('type_text', app=app, text=f'order-{s.nonce[:4]}')
        submit = target('Submit')
        first = s.call('click', app=app, expect={'text': f'never {s.nonce}', 'timeout': 1.5}, **submit)
        submitted = len(s.fixture.state()['submitted'])
        s.check('submit not verified (timeout), warned not to repeat', verdict(first) == 'timeout' and 'repeating' in first['text'].splitlines()[0]
                and submitted == 1, first['text'].splitlines()[0])
        again = s.call('click', app=app, **submit)
        s.check('identical submit refused before looking', again['is_error'] and 'confirm_repeat' in again['text']
                and len(s.fixture.state()['submitted']) == 1, again['text'][:200])
        submit = target('Submit')   # looking at the state lifts the guard
        third = s.call('click', app=app, expect={'text': 'submitted 2'}, **submit)
        s.check('after looking, a deliberate repeat is allowed and verified', verdict(third) == 'verified' and len(s.fixture.state()['submitted']) == 2,
                third['text'].splitlines()[0])
        quick = s.call('click', app=app, **submit)
        s.check('a verified submit does not block a deliberate next one', not quick['is_error'] and len(s.fixture.state()['submitted']) == 3,
                quick['text'].splitlines()[0])


def textedit(s):
    """A real app: a fresh TextEdit document; typing is verified by its text
    showing up, a key with no effect is no_effect, scrolling is verified."""
    import subprocess
    import time
    if subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True).returncode == 0:
        s.check('TextEdit not running with the user\'s documents', False, 'skipped: TextEdit is running')
        return
    path = s.directory / f'verify-{s.nonce}.txt'
    path.write_text(''.join(f'Verify line {i:03d}\n' for i in range(1, 121)))
    open_in_background('TextEdit', path, fresh=True)
    try:
        time.sleep(2.5)
        state = s.call('get_app_state', app='TextEdit', window=path.name, ocr=True)
        s.check('TextEdit: document shown', not state['is_error'] and 'Verify line' in state['text'], state['text'][:160])
        marker = f'CHECK{s.nonce[:5].upper()}'
        typed = s.call('type_text', app='TextEdit', text=marker, expect={'text': marker})
        s.check('TextEdit: typing verified by its text', verdict(typed) == 'verified', typed['text'].splitlines()[0])
        noop = s.call('press_key', app='TextEdit', key='F15', expect={'changed': True, 'timeout': 1.5})
        s.check('TextEdit: a key without effect is no_effect', verdict(noop) == 'no_effect' and 'Current state:' in noop['text'], noop['text'].splitlines()[0])
        state = s.call('get_app_state', app='TextEdit', window=path.name, ocr=True)
        # Recognition sometimes splits a word ("Verif y line 001"): any of the lines will do.
        line = ocr_find(state['text'], 'line 00')
        if not s.check('TextEdit: a line found to scroll at', line, state['text'][-300:]):
            return
        scrolled = s.call('scroll', app='TextEdit', x=line[1], y=line[2], direction='down', pages=2, expect={'changed': True})
        s.check('TextEdit: scrolling verified as a change', verdict(scrolled) == 'verified', scrolled['text'].splitlines()[0])
        if not s.locked:
            gone = s.call('press_key', app='TextEdit', key='cmd+w', expect={'window_closed': True})
            s.check('TextEdit: closing verified', verdict(gone) == 'verified', gone['text'].splitlines()[0])
    finally:
        subprocess.run(['pkill', '-x', 'TextEdit'])


if __name__ == '__main__':
    main()
    if '--textedit' in sys.argv:
        with Session('verify-textedit', fixture=False) as session:
            textedit(session)
