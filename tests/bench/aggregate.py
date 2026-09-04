#!/usr/bin/env python3
"""Merge every tests/bench/runs/*/results.json into one table.
Keeps only runs that produced output (turns > 0); when a case+arm appears in several batches the latest batch wins.
Prints markdown and writes tests/bench/runs/aggregate.json."""
import json, glob, os, sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
HERE = os.path.dirname(os.path.abspath(__file__))
batches = sorted(glob.glob(os.path.join(HERE, 'runs', '*', 'results.json')))
latest = {}
for b in batches:
    for r in json.load(open(b, encoding='utf-8')):
        if r['turns'] == 0:
            continue
        latest.setdefault((r['case'], r['arm']), {})[b] = latest.get((r['case'], r['arm']), {}).get(b, []) + [r]
runs = []
for key, per_batch in latest.items():
    runs += per_batch[max(per_batch)]  # newest batch for this case+arm

def avg(xs): xs = [x for x in xs if x is not None]; return sum(xs) / len(xs) if xs else 0
def rt_calls(r): return [t for t in r['tool_calls'] if t['tool'].startswith('mcp__')]
def rt_chars(r): return sum(t.get('result_chars', 0) for t in rt_calls(r))

cases = sorted({r['case'] for r in runs}); arms = ['stock', 'lean']
rows = []
print('| case | arm | runs | correct | assistant turns | realtime calls | realtime result chars | input tokens (all turns, incl. cache) | output tokens | cost USD |')
print('|---|---|---|---|---|---|---|---|---|---|')
for c in cases:
    for a in arms:
        rs = [r for r in runs if r['case'] == c and r['arm'] == a]
        if not rs: continue
        row = dict(case=c, arm=a, runs=len(rs), correct=sum(1 for r in rs if r['pass']), graded=all(r['pass'] is not None for r in rs),
                   turns=avg([r['turns'] for r in rs]), calls=avg([len(rt_calls(r)) for r in rs]), chars=avg([rt_chars(r) for r in rs]),
                   input=avg([r['total_input'] for r in rs]), output=avg([r['usage'].get('output_tokens') for r in rs]), cost=avg([r['cost'] for r in rs]),
                   seconds=avg([r['seconds'] for r in rs]),
                   calls_detail=[[(t['tool'].split('__')[-1], t.get('result_chars', 0)) for t in rt_calls(r)] for r in rs])
        rows.append(row)
        corr = f"{row['correct']}/{row['runs']}" if row['graded'] else 'manual'
        print(f"| {c} | {a} | {row['runs']} | {corr} | {row['turns']:.1f} | {row['calls']:.1f} | {row['chars']:.0f} | {row['input']:.0f} | {row['output']:.0f} | {row['cost']:.3f} |")
print()
print('| arm | avg input tokens | avg output tokens | avg cost USD | avg realtime calls | avg realtime result chars | avg turns |')
print('|---|---|---|---|---|---|---|')
tot = {}
for a in arms:
    rs = [r for r in runs if r['arm'] == a]
    tot[a] = dict(input=avg([r['total_input'] for r in rs]), output=avg([r['usage'].get('output_tokens') for r in rs]), cost=avg([r['cost'] for r in rs]),
                  calls=avg([len(rt_calls(r)) for r in rs]), chars=avg([rt_chars(r) for r in rs]), turns=avg([r['turns'] for r in rs]), n=len(rs))
    t = tot[a]; print(f"| {a} | {t['input']:.0f} | {t['output']:.0f} | {t['cost']:.3f} | {t['calls']:.1f} | {t['chars']:.0f} | {t['turns']:.1f} |")
json.dump(dict(rows=rows, totals=tot, batches=batches), open(os.path.join(HERE, 'runs', 'aggregate.json'), 'w', encoding='utf-8'), indent=1)
