#!/usr/bin/env python3
"""Reading less: one task set against the scenario app, done twice, in
whatever state the Mac is in:

    python3 scripts/bench_reads.py .build/debug/skfiy [--rounds 2]

- full: every look is a full get_app_state, and waits poll (SKFIY_WAIT_EVENTS=0),
  as before state versions existed;
- incremental: looks pass since: <the last State version> and get only the
  changes, waits are woken by accessibility notifications (unlocked) or
  compare small screenshots at a slowing pace (locked).

Both must catch the same things: a status change after a click, a text that
completes later, a dialog window opening and closing, an animation ending.
Measured per call on the client side: seconds, text bytes, image bytes.
Writes eval/results/bench-reads-*/summary.json.
"""
import argparse
import os
import json
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import ROOT, Session, main_binary  # noqa: E402


def run_tasks(s, incremental):
    rows = []
    state = {'version': None}
    main_title = f'Scenario {s.nonce}'
    dialog = f'Scenario dialog {s.nonce}'

    def call(step, tool, **arguments):
        started = time.monotonic()
        result = s.call(tool, **arguments)
        seconds = time.monotonic() - started
        images = sum(Path(path).stat().st_size for path in result['images'])
        looks = re.search(r'\((\d+) looks?', result['text'])
        rows.append({'step': step, 'tool': tool, 'seconds': round(seconds, 3), 'textBytes': len(result['text'].encode()),
                     'imageBytes': images, 'error': result['is_error'], 'looks': int(looks[1]) if looks else None})
        version = re.search(r'State: (v\d+)', result['text'])
        if version:
            state['version'] = version[1]
        return result

    def look(step, **extra):
        arguments = {'app': s.app, 'window': main_title, **extra}
        if incremental and state['version']:
            arguments['since'] = state['version']
        return call(step, 'get_app_state', **arguments)

    call('first look', 'get_app_state', app=s.app, window=main_title)
    for _ in range(3):
        idle = look('look again, nothing changed')
    s.check('nothing changed: ' + ('"unchanged", no screenshot' if incremental else 'full state again'),
            ('Unchanged since' in idle['text'] and not idle['images']) if incremental else (not idle['is_error'] and idle['images']), idle['text'][-160:])

    # While locked an action returns the state after it (with its version);
    # unlocked it returns a screenshot, and the next look brings the tree.
    clicked = call('click Apply', 'click', app=s.app, target={'name': 'Apply'})
    after = look('look after the click')
    reported = 'apply 1' in clicked['text'] or ('apply 1' in after['text'] and (not incremental or 'Changes since' in after['text']))
    s.check('status change after the click is reported', reported, after['text'][-240:])

    done = f'done {s.nonce[:6]}'
    s.fixture.command('text', value=done, after=3)
    waited = call('wait for a text that comes after 3 s', 'wait_for', app=s.app, window=main_title, text=done, timeout=15,
                  **({'since': state['version']} if incremental else {}))
    s.check('completion text caught by wait_for', not waited['is_error'] and 'appeared after' in waited['text'], waited['text'][:200])

    s.fixture.command('open_window', title=dialog)
    s.fixture.wait(lambda st: len(st['windows']) == 2)
    opened = look('look after a dialog opened')
    s.check('dialog window reported', dialog in opened['text'] and (not incremental or 'opened' in opened['text']), opened['text'][-240:])

    s.fixture.command('close_window', title=dialog)
    s.fixture.wait(lambda st: len(st['windows']) == 1)
    time.sleep(1)  # the window server lists a closed window for up to about a second
    closed = look('look after the dialog closed')
    s.check('dialog closing reported', (dialog in closed['text'] and 'closed' in closed['text']) if incremental else dialog not in closed['text'],
            closed['text'][-240:])

    s.fixture.command('animate', seconds=2)
    settled = call('wait for the animation to settle', 'wait_for', app=s.app, window=main_title, stable_for=1, timeout=15,
                   **({'since': state['version']} if incremental else {}))
    s.check('animation end caught (window stable, completion message shown)', not settled['is_error'] and 'animation done' in settled['text'],
            settled['text'][:240])
    for _ in range(2):
        idle = look('look again, nothing changed')
    return rows


def run_textedit(s, incremental):
    """A real app: a TextEdit document, typed into and scrolled, looked at
    between steps."""
    import subprocess
    rows = []
    state = {'version': None}
    path = s.directory / f'bench-{s.nonce}.txt'
    path.write_text(''.join(f'Bench line {i:03d}\n' for i in range(1, 121)))
    subprocess.run(['open', '-g', '-F', '-a', 'TextEdit', str(path)], check=True)
    time.sleep(2.5)

    def call(step, tool, **arguments):
        started = time.monotonic()
        result = s.call(tool, **arguments)
        seconds = time.monotonic() - started
        images = sum(Path(p).stat().st_size for p in result['images'])
        looks = re.search(r'\((\d+) looks?', result['text'])
        rows.append({'step': step, 'tool': tool, 'seconds': round(seconds, 3), 'textBytes': len(result['text'].encode()),
                     'imageBytes': images, 'error': result['is_error'], 'looks': int(looks[1]) if looks else None})
        version = re.search(r'State: (v\d+)', result['text'])
        if version:
            state['version'] = version[1]
        return result

    def look(step):
        arguments = {'app': 'TextEdit', 'window': path.name, 'ocr': True}
        if incremental and state['version']:
            arguments['since'] = state['version']
        return call(step, 'get_app_state', **arguments)

    try:
        first = call('first look', 'get_app_state', app='TextEdit', window=path.name, ocr=True)
        for _ in range(3):
            idle = look('look again, nothing changed')
        s.check('TextEdit: nothing changed', ('Unchanged since' in idle['text']) if incremental else ('Bench' in idle['text'] and idle['images']),
                idle['text'][-160:])
        marker = f'MARK{s.nonce[:5].upper()}'
        typed = call('type a marker', 'type_text', app='TextEdit', text=marker)
        after = look('look after typing')
        # Locked, the action already returned the state after it.
        s.check('TextEdit: the typed marker is reported', marker in after['text'] or marker in typed['text'], after['text'][-200:])
        waited = call('wait for the marker', 'wait_for', app='TextEdit', window=path.name, text=marker, timeout=10,
                      **({'since': state['version']} if incremental else {}))
        s.check('TextEdit: wait_for sees the marker', not waited['is_error'], waited['text'][:160])
        line = re.search(r'"Bench[^"]*" x=(\d+) y=(\d+)', first['text'])
        if line:
            scrolled = call('scroll down', 'scroll', app='TextEdit', x=int(line[1]), y=int(line[2]), direction='down', pages=1)
            moved = look('look after scrolling')
            # As with the click: the action's own result can already show the
            # new lines (then the look after it is rightly "unchanged").
            shown = lambda text: {m for m in re.findall(r'Bench line (\d+)', text)}
            in_result = bool(shown(scrolled['text']) - shown(first['text']))
            s.check('TextEdit: scrolling is reported as changed lines', in_result or (('Changes since' in moved['text'] or 'Most of the window' in moved['text'])
                    if incremental else 'Bench line' in moved['text']), moved['text'][-200:])
        for _ in range(2):
            look('look again, nothing changed')
    finally:
        subprocess.run(['pkill', '-x', 'TextEdit'])
    return rows


def totals(rows):
    return {'calls': len(rows), 'seconds': round(sum(r['seconds'] for r in rows), 2),
            'textBytes': sum(r['textBytes'] for r in rows), 'imageBytes': sum(r['imageBytes'] for r in rows),
            'waitLooks': sum(r['looks'] or 0 for r in rows if r['tool'] == 'wait_for')}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('binary')
    parser.add_argument('--rounds', type=int, default=2)
    parser.add_argument('--textedit', action='store_true', help='the real-app task set (TextEdit) instead of the scenario app')
    args = parser.parse_args()
    main_binary()
    if args.textedit:
        import subprocess
        if subprocess.run(['pgrep', '-x', 'TextEdit'], capture_output=True).returncode == 0:
            raise SystemExit('TextEdit is running (maybe with the user\'s documents); not touching it.')
    results = {'full': [], 'incremental': []}
    sessions = []
    for round_number in range(args.rounds):
        for style in ('full', 'incremental'):
            environment = {**({'SKFIY_WAIT_EVENTS': '0'} if style == 'full' else {}), **({'SKFIY_OCR_DUMP': os.environ['SKFIY_OCR_DUMP']} if os.environ.get('SKFIY_OCR_DUMP') else {})}
            name = f'bench-reads{"-textedit" if args.textedit else ""}-{style}'
            with Session(name, environment=environment, fixture=not args.textedit) as s:
                print(f'round {round_number + 1}, {style} ({s.mode})', flush=True)
                rows = (run_textedit if args.textedit else run_tasks)(s, style == 'incremental')
                results[style].append(rows)
            sessions.append({'style': style, 'round': round_number + 1, 'summary': s.summary})
    mode = sessions[0]['summary']['mode']
    directory = ROOT / 'eval/results' / f'bench-reads{"-textedit" if args.textedit else ""}-{mode}-{time.strftime("%Y%m%d-%H%M%S")}'
    directory.mkdir(parents=True)
    report = {style: [totals(rows) for rows in runs] for style, runs in results.items()}
    steps = {}
    for style, runs in results.items():
        for rows in runs:
            for row in rows:
                entry = steps.setdefault(row['step'], {}).setdefault(style, {'seconds': [], 'textBytes': [], 'imageBytes': [], 'looks': []})
                for key in ('seconds', 'textBytes', 'imageBytes', 'looks'):
                    if row[key] is not None:
                        entry[key].append(row[key])
    summary = {'mode': mode, 'rounds': args.rounds, 'totals': report, 'steps': steps, 'rows': results,
               'sessions': [{'style': x['style'], 'round': x['round'], 'ok': x['summary'].get('ok'), 'checks': x['summary']['checks'],
                             'lockSamples': x['summary'].get('lockSamples'), 'evidence': x['summary'].get('nonce')} for x in sessions]}
    (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    for style in ('full', 'incremental'):
        for t in report[style]:
            print(f"{style:12} calls={t['calls']} seconds={t['seconds']} text={t['textBytes']} B images={t['imageBytes']} B waitLooks={t['waitLooks']}")
    print('all checks ok' if all(x['summary'].get('ok') for x in sessions) else 'SOME CHECKS FAILED')
    print(directory.relative_to(ROOT))


if __name__ == '__main__':
    main()
