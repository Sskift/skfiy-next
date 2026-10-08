#!/usr/bin/env python3
"""get_app_capabilities against the scenario app and real apps, in whatever
state the Mac is in (direct mode while locked):

    python3 scripts/test_capabilities.py .build/debug/skfiy [--browser]

Checks that the answer follows changes: windows opening and closing, the app
hiding (unlocked), screenshot coordinates aging (locked), emergency stop, a
browser connecting (--browser: quits and relaunches Chrome for Testing), and a
session without direct mode while locked; and that a query sends nothing.
"""
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compat_baseline import ready_test_chrome  # noqa: E402
from scenario import Session, capabilities, main_binary, tool, wait_until  # noqa: E402

CFT = 'Google Chrome for Testing'


def channel(report, name):
    return report['channels'][name]


def main():
    main_binary()
    browser = '--browser' in sys.argv
    with Session('capabilities') as s:
        app = s.app
        before = s.fixture.state()
        first_result = s.call('get_app_capabilities', app=app)
        first = capabilities(first_result)
        s.check('query answers', not first_result['is_error'], first_result['text'][:200])
        s.check('session reported truthfully', first['session'] == ('locked' if s.locked else 'unlocked'), first['session'])
        s.check('one window', len(first['windows']) == 1, first['windows'])
        s.check('screenshot available', channel(first, 'screenshot')['available'], channel(first, 'screenshot'))
        s.check('keyboard available with one window', channel(first, 'keyboard')['available'], channel(first, 'keyboard'))
        s.check('not a browser', not channel(first, 'browser')['available'], channel(first, 'browser')['detail'])
        if s.locked:
            s.check('ax unavailable while locked', not channel(first, 'ax')['available'], channel(first, 'ax')['detail'])
            s.check('pointer needs a screenshot first', any('No valid screenshot' in limit for limit in channel(first, 'pointer')['limits']),
                    channel(first, 'pointer')['limits'])
            s.check('foreground unavailable while locked', not channel(first, 'foreground')['available'], channel(first, 'foreground')['detail'])
            s.check('locked tools listed', {'get_app_state', 'click', 'type_text'} <= set(first['tools']) and 'set_value' not in first['tools'], first['tools'])
            s.call('get_app_state', app=app, ocr=False)
            aged = capabilities(s.call('get_app_capabilities', app=app))
            s.check('screenshot age reported after get_app_state', any(' s old' in limit for limit in channel(aged, 'pointer')['limits']),
                    channel(aged, 'pointer')['limits'])
        else:
            s.check('ax available', channel(first, 'ax')['available'], channel(first, 'ax')['detail'])
            s.check('unlocked tools include element actions', {'set_value', 'click'} <= set(first['tools']), first['tools'])

        s.fixture.command('open_window', title=f'Scenario extra {s.nonce}')
        time.sleep(0.5)
        two_result = s.call('get_app_capabilities', app=app)
        two = capabilities(two_result)
        s.check('second window seen', len(two['windows']) == 2, [w['title'] for w in two['windows']])
        s.check('version changed with the window', two['version'] != first['version'], (first['version'], two['version']))
        s.check('change named', 'changed since the last query' in two_result['text'] and 'windows' in two_result['text'].split('\n')[0],
                two_result['text'].split('\n')[0])
        if s.locked:
            s.check('keyboard refused with two active windows', not channel(two, 'keyboard')['available'],
                    f"{channel(two, 'keyboard')['detail']} (active keyboard windows: {two.get('activeKeyboardWindows')})")
        s.fixture.command('close_window', title=f'Scenario extra {s.nonce}')
        time.sleep(0.5)
        back = capabilities(s.call('get_app_capabilities', app=app))
        s.check('back to one window', len(back['windows']) == 1, [w['title'] for w in back['windows']])
        s.check('keyboard available again', channel(back, 'keyboard')['available'], channel(back, 'keyboard')['detail'])

        if not s.locked:
            s.fixture.command('hide')
            time.sleep(0.5)
            hidden = capabilities(s.call('get_app_capabilities', app=app))
            s.check('hidden app: no screenshot', not channel(hidden, 'screenshot')['available'], channel(hidden, 'screenshot')['detail'])
            s.check('hidden app: no pointer', not channel(hidden, 'pointer')['available'], channel(hidden, 'pointer')['detail'])
            s.fixture.command('unhide')
            time.sleep(0.5)
            shown = capabilities(s.call('get_app_capabilities', app=app))
            s.check('unhidden app: screenshot again', channel(shown, 'screenshot')['available'], channel(shown, 'screenshot')['detail'])

        # Emergency stop: this session's own flag file.
        stop = s.directory / 'stopped'
        stop.touch()
        stopped = capabilities(s.call('get_app_capabilities', app=app))
        stop.unlink()
        s.check('emergency stop reported', stopped['emergencyStop'] and not channel(stopped, 'keyboard')['available'], channel(stopped, 'keyboard')['detail'])
        resumed = capabilities(s.call('get_app_capabilities', app=app))
        s.check('resumed', not resumed['emergencyStop'] and channel(resumed, 'screenshot')['available'], resumed['emergencyStop'])

        # Real apps, read only: a terminal is protected; an app that is not running.
        for name in ('Ghostty', 'Terminal'):
            if subprocess.run(['pgrep', '-x', name.lower() if name == 'Ghostty' else name], capture_output=True).returncode == 0:
                term = capabilities(s.call('get_app_capabilities', app=name))
                s.check(f'{name}: no keyboard (terminal)', not channel(term, 'keyboard')['available'], channel(term, 'keyboard')['detail'])
                break
        finder = capabilities(s.call('get_app_capabilities', app='Finder'))
        if s.locked:
            consistent = channel(finder, 'keyboard')['available'] == (finder.get('activeKeyboardWindows') == 1)
            s.check('Finder: keyboard follows its active windows', consistent,
                    f"{finder.get('activeKeyboardWindows')} active window(s): {channel(finder, 'keyboard')['detail']}")
        else:
            s.check('Finder: accessibility and keyboard', channel(finder, 'ax')['available'] and channel(finder, 'keyboard')['available'],
                    channel(finder, 'ax')['detail'])
        calculator = s.call('get_app_capabilities', app='Calculator')
        if not calculator['is_error']:
            report = capabilities(calculator)
            if 'pid' not in report:
                s.check('not running: says how to start', 'not running' in channel(report, 'screenshot')['detail'], channel(report, 'screenshot')['detail'])

        if browser:
            check_browser(s)

        after = s.fixture.state()
        s.check('queries sent nothing to the app', after['keys'] == before['keys'] and after['counters'] == before['counters'],
                (before['counters'], after['counters'], after['keys']))

    if s.locked:
        # A session started without direct mode explains why nothing works.
        with Session('capabilities-nodirect', direct=False) as plain:
            report = capabilities(plain.call('get_app_capabilities', app=plain.app))
            plain.check('no direct mode: blocked with the reason', not channel(report, 'screenshot')['available']
                        and 'SKFIY_LOCKED_USE=direct' in channel(report, 'screenshot')['detail'], channel(report, 'screenshot')['detail'])


def check_browser(s):
    """Chrome for Testing's browser channel follows its extension connection."""
    pid = ready_test_chrome(s)
    if not s.check('browser: Chrome for Testing running with its extension', pid, 'it did not start or connect'):
        return
    connected = capabilities(s.call('get_app_capabilities', app=CFT))
    s.check('browser channel available while connected', channel(connected, 'browser')['available'], channel(connected, 'browser')['detail'])
    command = subprocess.run(['ps', '-o', 'command=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    subprocess.run(['kill', '-TERM', str(pid)])
    def browser_available():
        result = s.call('get_app_capabilities', app=CFT)
        # Chrome for Testing is not in /Applications: once it quits it is no app at all.
        return not result['is_error'] and channel(capabilities(result), 'browser')['available']
    gone = wait_until(lambda: not browser_available(), timeout=15, interval=1)
    s.check('browser channel gone when the browser quits', gone, '')
    if not gone:
        return
    app = command.split('/Contents/MacOS/')[0]
    arguments = [part for part in command.split(' ') if part.startswith('--')]
    subprocess.run([str(tool('Launch')), app, *arguments], capture_output=True, timeout=30)
    back = wait_until(browser_available, timeout=60, interval=1)
    s.check('browser channel back after reconnecting', back, '')


if __name__ == '__main__':
    main()
