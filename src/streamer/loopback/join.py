#!/usr/bin/env python3
"""Join the loopback latency probe's logs into per-press legs.

    python3 join.py FLIPS RUN [--json]

FLIPS is flip-window.py's stdout on the Sunshine PC. RUN is the stream's log on the host
(live.js stdout and stderr), holding the feeder's probe-press lines (HBL_PROBE_PRESS_MS) and the
helper's probe-patch lines (HBL_PROBE_PATCH). Times are microseconds on the wall clock, the two
machines NTP-synced, except a flip's evdevUs, which can be on the pad's own clock. total is
stamped on the host alone; the AB/C split carries the PC-host skew.

Everything pairs by time, never by edge number (each tool counts its own edges): a press takes
the first flip swapped before the next press, and that flip the first unit with its state that
reaches the helper before the next flip. Pairing goes by the swap time because the pad's evdev
times can come on a clock of their own.

Legs per press: A press -> evdev on the PC, B evdev -> flip swapped, AB their sum, C flip ->
first unit showing it reaches the helper (capture, encode, network), D that unit's probe decode
on the host, total press -> decoded. A and B are left out of a row whose evdev time is not on
the wall clock. The console leg is the run's gateAgeMs from its stats rows; it is not per press.

A patch line whose receivedUs is after its decodedUs, or more than MATCH_US before it, has a
broken clock reference; it is dropped and counted as insane rather than joined.
"""
import argparse
import json
import math
import sys

SLACK_US = 2000
MATCH_US = 1_000_000


def events(path):
    with open(path, errors='replace') as lines:
        for line in lines:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                yield event


def percentile(values, p):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)] if ordered else None


def spread(values):
    return {'n': len(values), 'p50': percentile(values, 50), 'p95': percentile(values, 95),
            'max': max(values) if values else None}


def first_after(items, key, since, until, used):
    """The first unused item with since - SLACK_US <= item[key] < until."""
    for item in items:
        if id(item) not in used and since - SLACK_US <= item[key] < until:
            used.add(id(item))
            return item
    return None


def on_wall_clock(press, flip):
    """Whether the flip's evdev time falls between its press and its swap."""
    return press['wallUs'] - SLACK_US <= flip['evdevUs'] <= flip['flipUs'] + SLACK_US


def join(flip_log, run_log):
    flips = [e for e in events(flip_log) if e.get('event') == 'flip']
    run = list(events(run_log))
    presses = [e for e in run if e.get('event') == 'probe-press' and e.get('pressed')]
    lines = [e for e in run if e.get('event') == 'probe-patch' and 'seq' in e
             and e.get('receivedUs')]
    patches = [e for e in lines if 0 <= e['decodedUs'] - e['receivedUs'] < MATCH_US]
    cost = [e for e in run if e.get('event') == 'probe-stats']
    gate = [row['au']['gateAgeMs'] for row in run
            if 'codec' in row and 'gateAgeMs' in row.get('au', {})][1:]
    flips.sort(key=lambda e: e['flipUs'])
    patches.sort(key=lambda e: e['receivedUs'])
    used_flips, used_patches = set(), set()
    joined = []
    presses.sort(key=lambda e: e['wallUs'])
    for i, press in enumerate(presses):
        until = min(press['wallUs'] + MATCH_US,
                    presses[i + 1]['wallUs'] if i + 1 < len(presses) else math.inf)
        flip = first_after(flips, 'flipUs', press['wallUs'], until, used_flips)
        if not flip:
            joined.append({'edge': press['edge'], 'missing': 'flip'})
            continue
        later = [f['flipUs'] for f in flips if f['flipUs'] > flip['flipUs']]
        until = min(later, default=flip['flipUs'] + MATCH_US)
        shown = [p for p in patches if p['state'] == flip['state']]
        patch = first_after(shown, 'receivedUs', flip['flipUs'], until, used_patches)
        row = {'edge': press['edge'], 'AB': (flip['flipUs'] - press['wallUs']) / 1000}
        if on_wall_clock(press, flip):
            row.update(A=(flip['evdevUs'] - press['wallUs']) / 1000,
                       B=(flip['flipUs'] - flip['evdevUs']) / 1000)
        if patch:
            row.update(seq=patch['seq'], C=(patch['receivedUs'] - flip['flipUs']) / 1000,
                       D=(patch['decodedUs'] - patch['receivedUs']) / 1000,
                       total=(patch['decodedUs'] - press['wallUs']) / 1000)
        else:
            row['missing'] = 'patch'
        joined.append(row)
    legs = {leg: spread([r[leg] for r in joined if leg in r]) for leg in LEGS}
    legs['console'] = spread(gate)
    return {'presses': len(presses), 'flips': len(flips), 'patches': len(patches),
            'insane': len(lines) - len(patches),
            'probeCost': {'seconds': len(cost),
                          'meanMs': spread([e['meanMs'] for e in cost])['p50'],
                          'maxMs': max((e['maxMs'] for e in cost), default=None)},
            'missing': {kind: sum(r.get('missing') == kind for r in joined)
                        for kind in ('flip', 'patch')},
            'negative': sum(any(r.get(leg, 0) < 0 for leg in ('A', 'B', 'AB', 'C'))
                            for r in joined),
            'foreignEvdev': sum('AB' in r and 'A' not in r for r in joined),
            'legs': legs, 'rows': joined}


LEGS = ('A', 'B', 'AB', 'C', 'D', 'total')
NAMES = {'A': 'press -> evdev', 'B': 'evdev -> flip', 'AB': 'press -> flip',
         'C': 'flip -> unit at helper', 'D': 'probe decode', 'total': 'press -> decoded',
         'console': 'gateAgeMs (rows)'}


def text(result):
    out = [f"presses {result['presses']}  flips {result['flips']}  patch changes "
           f"{result['patches']}  missing flip {result['missing']['flip']}  missing patch "
           f"{result['missing']['patch']}  rows with a negative leg {result['negative']}", '']
    out.append(f"{'leg':32} {'n':>4} {'p50':>8} {'p95':>8} {'max':>8}  (ms)")
    for leg, s in result['legs'].items():
        cells = ' '.join(f'{s[k]:8.1f}' if s[k] is not None else f"{'-':>8}"
                         for k in ('p50', 'p95', 'max'))
        out.append(f'{leg + " " + NAMES[leg]:32} {s["n"]:4} {cells}')
    cost = result['probeCost']
    out += ['', f"probe decode per unit: {cost['seconds']} s, p50 of mean {cost['meanMs']} ms, "
            f"max {cost['maxMs']} ms"]
    if result['foreignEvdev']:
        out.append(f"{result['foreignEvdev']} rows with an evdev time off the wall clock: "
                   'A and B left out, AB holds')
    if result['insane']:
        out.append(f"dropped {result['insane']} patch lines with receivedUs after decodedUs "
                   'or 1 s before it: check the helper clock reference')
    return '\n'.join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('flips')
    parser.add_argument('run')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    result = join(args.flips, args.run)
    if not result['presses']:
        sys.exit('no probe-press lines in ' + args.run)
    print(json.dumps(result, indent=2) if args.json else text(result))


if __name__ == '__main__':
    main()
