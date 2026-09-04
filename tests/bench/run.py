#!/usr/bin/env python3
"""A/B token benchmark: realtime-lean plugin vs the stock realtime MCP.

Runs every evals/<case>/prompt.md through headless `claude -p --output-format stream-json`
in a fresh CLAUDE_CONFIG_DIR (credentials copied in, nothing else), once per arm:
  lean  : --plugin-dir <repo>           (proxy + skill)        allowed: mcp__plugin_realtime-lean_realtime
  stock : --mcp-config stock.json       (38 tools, no skill)   allowed: mcp__realtime
Grades each run with the case's regex graders, records exact usage from the API
(input, cache write, cache read, output tokens, cost, turns), every tool call and
the size of every tool result. Writes tests/bench/runs/<stamp>/results.json + report.md.

Usage: python tests/bench/run.py [--runs 2] [--case name] [--arm lean|stock] [--model id]
Requires: RT_API_KEY in env, `claude` on PATH, ~/.claude/.credentials.json
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time, glob

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EVALS = os.path.join(ROOT, 'evals')
STOCK_MCP = os.path.join(ROOT, 'tests', 'stock-plugin', '.mcp.json')
# --strict-mcp-config would also drop the plugin's own MCP server, so the lean arm relies on the fresh
# config dir + neutral cwd having no other servers. File tools are disallowed in both arms so neither
# can read the plugin's reference files from disk: lean must go through rt_ref, stock through the server.
NO_FILES = ['--disallowedTools', 'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent']
WORKDIR = os.path.join(tempfile.gettempdir(), 'rt-bench-workdir')  # empty cwd: no project .mcp.json, no repo files
os.makedirs(WORKDIR, exist_ok=True)
# Both arms strict so the account's claude.ai connectors stay out of context. The lean arm therefore gets the
# proxy as a plain --mcp-config server (same command the plugin's .mcp.json runs) plus --plugin-dir for the skill.
LEAN_MCP = os.path.join(WORKDIR, 'lean-mcp.json')
json.dump({"mcpServers": {"realtime": {"command": "node", "args": [os.path.join(ROOT, 'mcp', 'server.mjs').replace('\\', '/')],
                                        "env": {"RT_API_KEY": os.environ.get('RT_API_KEY', '')}}}},
          open(LEAN_MCP, 'w'), indent=1)
ARMS = {
    'lean': dict(flags=['--plugin-dir', ROOT, '--mcp-config', LEAN_MCP, '--strict-mcp-config', *NO_FILES], allow='mcp__realtime'),
    'stock': dict(flags=['--mcp-config', STOCK_MCP, '--strict-mcp-config', *NO_FILES], allow='mcp__realtime'),
}
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ap = argparse.ArgumentParser()
ap.add_argument('--runs', type=int, default=2)
ap.add_argument('--case')
ap.add_argument('--arm', choices=list(ARMS))
ap.add_argument('--model')
ap.add_argument('--max-turns', type=int, default=12)
args = ap.parse_args()


def frontmatter(md):
    m = re.match(r'---\n(.*?)\n---\n(.*)', md, re.S)
    meta = {}
    for line in (m.group(1) if m else '').splitlines():
        if ':' in line:
            k, v = line.split(':', 1); meta[k.strip()] = v.strip().strip('"')
    return meta, (m.group(2) if m else md).strip()


def load_cases():
    out = []
    for d in sorted(glob.glob(os.path.join(EVALS, '*'))):
        p = os.path.join(d, 'prompt.md')
        if not os.path.exists(p):
            continue
        meta, prompt = frontmatter(open(p, encoding='utf-8').read())
        graders = []
        for g in sorted(glob.glob(os.path.join(d, 'graders', '*.md'))):
            gm, _ = frontmatter(open(g, encoding='utf-8').read())
            if gm.get('type') == 'regex':
                graders.append((os.path.basename(g)[:-3], gm['pattern']))
        out.append(dict(name=os.path.basename(d), prompt=prompt, graders=graders))
    return out


def fresh_config(arm):
    cfg = os.path.join(tempfile.gettempdir(), f'rt-bench-cfg-{arm}')
    shutil.rmtree(cfg, ignore_errors=True); os.makedirs(cfg)
    src = os.path.join(os.path.expanduser('~'), '.claude', '.credentials.json')
    if os.path.exists(src):
        shutil.copy(src, cfg)
    return cfg


def run_once(arm, case, cfg):
    a = ARMS[arm]
    # prompt goes in via stdin: as a shell argument, parentheses and slashes in the prompt broke cmd.exe parsing
    cmd = ['claude', '-p', '--output-format', 'stream-json', '--verbose',
           '--max-turns', str(args.max_turns), '--allowedTools', a['allow'], 'Skill', *a['flags']]
    if args.model:
        cmd += ['--model', args.model]
    env = dict(os.environ, CLAUDE_CONFIG_DIR=cfg)
    t0 = time.time()
    proc = subprocess.run(cmd, input=case['prompt'], capture_output=True, text=True, encoding='utf-8', errors='replace',
                          env=env, cwd=WORKDIR, shell=(os.name == 'nt'), timeout=900)
    rec = dict(arm=arm, case=case['name'], seconds=round(time.time() - t0, 1), tool_calls=[],
               tool_result_chars=0, turns=0, tools_offered=None, mcp_servers=None, result='', usage={}, cost=None,
               returncode=proc.returncode, stderr=proc.stderr[-800:])
    ids = {}
    for line in proc.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        t = m.get('type')
        if t == 'system' and m.get('subtype') == 'init':
            rec['tools_offered'] = [x for x in m.get('tools', []) if x.startswith('mcp__')]
            rec['mcp_servers'] = m.get('mcp_servers')
        elif t == 'assistant':
            rec['turns'] += 1
            for c in m['message'].get('content', []):
                if c.get('type') == 'tool_use':
                    ids[c['id']] = c['name']
                    rec['tool_calls'].append(dict(tool=c['name'], input=json.dumps(c.get('input', {}))[:300]))
        elif t == 'user':
            for c in m['message'].get('content', []) if isinstance(m['message'].get('content'), list) else []:
                if c.get('type') == 'tool_result':
                    cc = c.get('content')
                    txt = ''.join(x.get('text', '') for x in cc if isinstance(x, dict)) if isinstance(cc, list) else str(cc or '')
                    rec['tool_result_chars'] += len(txt)
                    for tc in rec['tool_calls']:
                        if tc['tool'] == ids.get(c['tool_use_id']) and 'result_chars' not in tc:
                            tc['result_chars'] = len(txt); break
        elif t == 'result':
            rec['result'] = m.get('result', '') or ''
            rec['usage'] = {k: m.get('usage', {}).get(k) for k in
                            ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens')}
            rec['cost'] = m.get('total_cost_usd'); rec['num_turns'] = m.get('num_turns'); rec['is_error'] = m.get('is_error')
    u = rec['usage']
    rec['total_input'] = sum(v or 0 for k, v in u.items() if k != 'output_tokens')
    rec['graders'] = {}
    for n, p in case['graders']:
        try:
            rec['graders'][n] = bool(re.search(p, rec['result']))
        except re.error as e:
            rec['graders'][n] = False; rec.setdefault('grader_errors', []).append(f'{n}: {e}')
    rec['pass'] = all(rec['graders'].values()) if rec['graders'] else None
    return rec


cases = [c for c in load_cases() if not args.case or c['name'] == args.case]
arms = [args.arm] if args.arm else list(ARMS)
stamp = time.strftime('%Y%m%d-%H%M%S')
outdir = os.path.join(ROOT, 'tests', 'bench', 'runs', stamp); os.makedirs(outdir)
results = []
for arm in arms:
    cfg = fresh_config(arm)
    for case in cases:
        for i in range(args.runs):
            r = run_once(arm, case, cfg); r['run'] = i + 1; results.append(r)
            print(f"{arm:5} {case['name']:22} run{i+1} turns={r['turns']:2} calls={len(r['tool_calls']):2} "
                  f"result_chars={r['tool_result_chars']:6} in={r['total_input']:7} out={r['usage'].get('output_tokens')} "
                  f"cost=${r['cost'] or 0:.3f} pass={r['pass']} {r['stderr'][-120:] if r['stderr'] else ''}", flush=True)
            json.dump(results, open(os.path.join(outdir, 'results.json'), 'w', encoding='utf-8'), indent=1)

# ---- report ------------------------------------------------------------------
def avg(xs): xs = [x for x in xs if x is not None]; return sum(xs) / len(xs) if xs else 0
lines = [f"# realtime-lean vs stock realtime MCP - {stamp}", "",
         f"runs per case per arm: {args.runs}; model: {args.model or 'account default'}; max turns {args.max_turns}", "",
         "| case | arm | pass | turns | realtime calls | tool result chars | input tokens (incl. cache) | output tokens | cost USD |",
         "|---|---|---|---|---|---|---|---|---|"]
for case in cases:
    for arm in arms:
        rs = [r for r in results if r['case'] == case['name'] and r['arm'] == arm]
        lines.append(f"| {case['name']} | {arm} | {sum(1 for r in rs if r['pass'])}/{len(rs)} | {avg([r['turns'] for r in rs]):.1f} | "
                     f"{avg([len(r['tool_calls']) for r in rs]):.1f} | {avg([r['tool_result_chars'] for r in rs]):.0f} | "
                     f"{avg([r['total_input'] for r in rs]):.0f} | {avg([r['usage'].get('output_tokens') for r in rs]):.0f} | {avg([r['cost'] for r in rs]):.3f} |")
lines += ["", "## Totals per arm", "", "| arm | pass | avg input tokens | avg output tokens | avg cost | avg calls | avg result chars | tools offered |", "|---|---|---|---|---|---|---|---|"]
for arm in arms:
    rs = [r for r in results if r['arm'] == arm]
    lines.append(f"| {arm} | {sum(1 for r in rs if r['pass'])}/{len(rs)} | {avg([r['total_input'] for r in rs]):.0f} | "
                 f"{avg([r['usage'].get('output_tokens') for r in rs]):.0f} | {avg([r['cost'] for r in rs]):.3f} | {avg([len(r['tool_calls']) for r in rs]):.1f} | "
                 f"{avg([r['tool_result_chars'] for r in rs]):.0f} | {len(rs[0]['tools_offered'] or []) if rs else 0} |")
open(os.path.join(outdir, 'report.md'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('\n'.join(lines)); print('written', outdir)
