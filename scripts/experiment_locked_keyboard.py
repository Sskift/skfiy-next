#!/usr/bin/env python3
"""Feasibility experiment: keyboard input to an app with two windows while
macOS is locked. Which window receives a key posted to the process, and can
anything available to skfiy tell that window in advance?

    python3 scripts/experiment_locked_keyboard.py [--trials 12] [--allow-unlocked]

Uses only the scenario app (two windows of one process). For each delivery
variant (plain: posted to the process, as skfiy does; routed: with the
window fields set; focus: after a focus record for the target window;
focus-routed: both) and each target window, with the app itself moving its
key window between trials, it records the signals read beforehand (AX
focused/main window, window-server order, ScreenCaptureKit active windows)
and the window that actually received the key (the app's own journal).
Writes eval/results/locked-keyboard-*/summary.json. Never unlocks.
"""
import argparse
import collections
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario import Fixture, ROOT, probe, tool, wait_until  # noqa: E402


def run(binary, *args):
    return json.loads(subprocess.run([str(binary), *map(str, args)], capture_output=True, text=True, timeout=20, check=True).stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--trials', type=int, default=12)
    parser.add_argument('--allow-unlocked', action='store_true', help='also run while unlocked (for comparison only)')
    args = parser.parse_args()
    session = probe('session')
    if not session['locked'] and not args.allow_unlocked:
        raise SystemExit('The Mac is not locked; this experiment is about the locked state (or pass --allow-unlocked).')
    kp = tool('KeyboardProbe')
    nonce = uuid.uuid4().hex[:10]
    mode = 'locked' if session['locked'] else 'unlocked'
    directory = ROOT / 'eval/results' / f'locked-keyboard-{mode}-{time.strftime("%Y%m%d-%H%M%S")}-{nonce}'
    (directory / 'fixture').mkdir(parents=True)
    fixture = Fixture(directory / 'fixture', nonce).launch()
    rows = []
    samples = []
    try:
        extra = f'Scenario extra {nonce}'
        fixture.command('open_window', title=extra)
        wait_until(lambda: len(fixture.state()['windows']) == 2)
        time.sleep(0.5)
        windows = {w['title']: w['number'] for w in fixture.state()['windows']}
        main_title = f'Scenario {nonce}'
        titles = [main_title, extra]
        for variant in ('plain', 'routed', 'focus', 'focus-routed'):
            for trial in range(args.trials):
                target = titles[trial % 2]
                # The app moves its own key window too, every third trial.
                if trial % 3 == 0:
                    fixture.command('key', title=titles[(trial // 3) % 2])
                    time.sleep(0.15)
                state = fixture.state()
                truth_key = [w['title'] for w in state['windows'] if w['key']]
                signals = run(kp, 'signals', fixture.pid)
                before = dict(state['keys'])
                sent = run(kp, 'send', fixture.pid, variant, windows[target], 'k')
                time.sleep(0.3)
                after = fixture.state()
                receivers = [title for title in titles if after['keys'].get(title, 0) > before.get(title, 0)]
                key_after = [w['title'] for w in after['windows'] if w['key']]
                session = probe('session')
                samples.append(session)
                rows.append({'variant': variant, 'trial': trial, 'target': target, 'targetID': windows[target],
                             'keyWindowBefore': truth_key, 'keyWindowAfter': key_after, 'signals': signals, 'sent': sent,
                             'receivers': receivers, 'locked': session['locked']})
                print(f"{variant:13} target={target[-15:]:15} key_before={[t[-5:] for t in truth_key]} "
                      f"received={[t[-5:] for t in receivers]} axFocused={signals['axFocused']} active={signals['sckActive']}", flush=True)
    finally:
        fixture.stop()
    by_title = {v: k for k, v in windows.items()}
    summary = {'mode': mode, 'nonce': nonce, 'trialsPerVariant': args.trials, 'windows': windows, 'rows': rows,
               'lockSamples': {'count': len(samples), 'locked': sum(1 for s in samples if s['locked'])}}
    report = {}
    for variant in ('plain', 'routed', 'focus', 'focus-routed'):
        subset = [r for r in rows if r['variant'] == variant]
        single = [r for r in subset if len(r['receivers']) == 1]
        hit = sum(1 for r in single if r['receivers'][0] == r['target'])
        agreement = collections.Counter()
        for r in single:
            receiver = r['receivers'][0]
            if by_title.get(r['signals'].get('axFocused')) == receiver:
                agreement['axFocused'] += 1
            if by_title.get(r['signals'].get('axMain')) == receiver:
                agreement['axMain'] += 1
            order = [by_title.get(i) for i in r['signals']['cgOrder'] if by_title.get(i)]
            if order and order[0] == receiver:
                agreement['cgFront'] += 1
            if r['keyWindowBefore'] == [receiver]:
                agreement['appKeyWindowBefore'] += 1
        report[variant] = {'trials': len(subset), 'oneReceiver': len(single), 'noReceiver': sum(1 for r in subset if not r['receivers']),
                           'receivedByTarget': hit, 'signalAgreesWithReceiver': dict(agreement)}
    summary['report'] = report
    feasible = {variant: data['oneReceiver'] == data['trials'] and data['receivedByTarget'] == data['trials']
                for variant, data in report.items()}
    confirmable = {variant: any(count == report[variant]['trials'] for name, count in report[variant]['signalAgreesWithReceiver'].items()
                                if name != 'appKeyWindowBefore') for variant in report}
    summary['conclusion'] = {'targetsReliably': feasible, 'receiverConfirmableBySkfiySignal': confirmable}
    (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'report': report, 'conclusion': summary['conclusion'], 'lockSamples': summary['lockSamples']}, indent=1))
    print(directory)


if __name__ == '__main__':
    main()
