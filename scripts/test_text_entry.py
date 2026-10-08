#!/usr/bin/env python3
"""Text entered through accessibility must count as a change.

    python3 scripts/test_text_entry.py .build/debug/skfiy

skfiy enters text through accessibility instead of keystrokes when an input
method would compose the keys (the app in front) or the text is long. TextEdit
takes such text without counting it as an edit: closing the document dropped
it without asking (found in the front column of the compatibility baseline).
skfiy now follows the text with a space taken back by a real Delete key.

In the background (TextEdit unlocked, never brought forward), with a new
untitled document: 250 characters (the accessibility path) and then a short
text (keystrokes) are entered; each time the document holds exactly the text
(no stray space) and closing it brings TextEdit's keep-or-delete sheet, which
is answered Delete. Skipped while TextEdit has documents that are not the
test's own.
"""
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_baseline as compat  # noqa: E402


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    binary = Path(sys.argv[1]).resolve()
    compat.TOOLS.update(compat.build_tools())
    session = compat.probe('session')
    if session['locked']:
        print('skipped: the Mac is locked (this is about the unlocked paths)')
        return
    nonce = uuid.uuid4().hex[:10]
    directory = compat.RESULTS / f'text-entry-unlocked-{time.strftime("%Y%m%d-%H%M%S")}-{nonce}'
    directory.mkdir(parents=True, mode=0o700)
    run = compat.Run(binary, 'background', directory, nonce)
    case = compat.TextEdit(run)
    problem = case.precondition()
    if problem:
        print(f'skipped: {problem}')
        run.finish()
        return
    checks = []

    def check(name, ok, detail=''):
        checks.append(bool(ok))
        run.evidence.record('check', check=name, ok=bool(ok), detail=str(detail)[:500])
        print(f"  {'ok ' if ok else 'FAIL'} {name}: {str(detail)[:160]}", flush=True)

    try:
        run.start_client()
        case.prepare()
        for label, text in [('250 characters (accessibility)', ''.join(f'entry{i:03d} ' for i in range(28))[:250]),
                            ('a short text (keystrokes)', f'KEYED {nonce.upper()}')]:
            windows = len(case.dump()['windows'])
            run.call('get_app_state', app='TextEdit')
            run.call('press_key', app='TextEdit', key='cmd+n')
            if not compat.wait_until(lambda: len(case.dump()['windows']) > windows, timeout=4):
                check(f'{label}: a new document', False, 'cmd+n opened none')
                continue
            run.call('get_app_state', app='TextEdit')
            typed = run.call('type_text', app='TextEdit', text=text)
            value = compat.wait_until(lambda: (case.dump().get('focused') or {}).get('value') == text and text, timeout=3)
            check(f'{label}: the document holds exactly the text', not typed['is_error'] and value,
                  f"{typed['text'].splitlines()[0]} | value ends {((case.dump().get('focused') or {}).get('value') or '')[-20:]!r}")
            run.call('get_app_state', app='TextEdit')
            run.call('press_key', app='TextEdit', key='cmd+w')
            sheet = compat.wait_until(lambda: any(w['sheets'] for w in case.dump()['windows']), timeout=4)
            check(f'{label}: closing asks whether to keep it (TextEdit counts it as a change)', sheet,
                  [(w['title'], w['sheets']) for w in case.dump()['windows']])
            if sheet:
                state = run.call('get_app_state', app='TextEdit')
                delete = compat.tree_index(state['text'], r'Button "Delete"')
                if delete:
                    run.call('click', app='TextEdit', element_index=delete)
                compat.wait_until(lambda: len(case.dump()['windows']) == windows, timeout=4)
    finally:
        for pid in compat.pids_of('TextEdit'):
            subprocess.run(['kill', '-9', str(pid)])
        run.finish()
    ok = bool(checks) and all(checks)
    print(f"{'PASS' if ok else 'FAIL'} {directory.relative_to(compat.ROOT)} ({sum(checks)}/{len(checks)} checks)")
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
