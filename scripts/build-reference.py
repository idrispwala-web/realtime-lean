#!/usr/bin/env python3
"""Regenerate skills/realtime-lean/reference/*.txt from the live realtime MCP + swagger.

Usage: RT_API_KEY=... python scripts/build-reference.py [--refresh]
Raw downloads are cached in scripts/.cache (gitignored); --refresh refetches them.
"""
import json, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# outside the plugin: `claude plugin install` snapshots the whole folder and swagger.json alone is 52 MB
CACHE = os.environ.get('RT_CACHE', os.path.join(tempfile.gettempdir(), 'realtime-lean-cache'))
WRAP = 110  # chars per line; the Claude Code Grep tool elides long lines as "[Omitted long line]"


def wrap(head, tokens, indent='  '):
    """head on its own line, then tokens packed into indented lines of <= WRAP chars."""
    lines, cur = [head], indent
    for t in tokens:
        if len(cur) + len(t) + 1 > WRAP and cur.strip():
            lines.append(cur.rstrip())
            cur = indent
        cur += t + ' '
    if cur.strip():
        lines.append(cur.rstrip())
    return '\n'.join(lines)


def write(name, header, blocks):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8', newline='\n') as f:
        f.write(header + '\n' + '\n'.join(blocks) + '\n')
OUT = os.path.join(ROOT, 'skills', 'realtime-lean', 'reference')
BASE = os.environ.get('RT_BASE_URL', 'https://api.mcp.cargonerds.dev')
KEY = os.environ.get('RT_API_KEY', '')
REFRESH = '--refresh' in sys.argv
os.makedirs(os.path.join(CACHE, 'odata'), exist_ok=True)
os.makedirs(OUT, exist_ok=True)


def mcp(name, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": args}}).encode()
    req = urllib.request.Request(BASE + '/mcp', data=body, headers={
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
        'X-Api-Key': KEY})
    raw = urllib.request.urlopen(req, timeout=180).read().decode()
    data = ''.join(l[6:] for l in raw.splitlines() if l.startswith('data: ')) or raw
    return json.loads(json.loads(data)['result']['content'][0]['text'])


def unwrap(d):
    """Older caches hold the raw JSON-RPC envelope; newer ones hold the inner object."""
    if isinstance(d, dict) and 'result' in d:
        return json.loads(d['result']['content'][0]['text'])
    return d


def cached(path, fetch):
    if os.path.exists(path) and not REFRESH:
        return unwrap(json.load(open(path, encoding='utf-8')))
    if not KEY:
        sys.exit('RT_API_KEY required to fetch ' + path)
    data = fetch()
    json.dump(data, open(path, 'w', encoding='utf-8'))
    return data


# --- raw inputs -------------------------------------------------------------
def fetch_catalog():
    out, off = [], 0
    while True:
        page = mcp('search_endpoints', {"query": "", "limit": 100, "offset": off})
        out += page['endpoints']
        off += page['limit']
        if off >= page['totalMatches']:
            return out


catalog = cached(os.path.join(CACHE, 'catalog.json'), fetch_catalog)
sets = cached(os.path.join(CACHE, 'odata_sets.json'), lambda: mcp('list_odata_entity_sets', {}))
sets = sets['entitySets'] if isinstance(sets, dict) else sets

with ThreadPoolExecutor(8) as ex:
    entities = list(ex.map(lambda n: cached(os.path.join(CACHE, 'odata', n + '.json'),
                                            lambda: mcp('describe_odata_entity_set', {"entitySet": n})), sets))


def probe(c):
    """A set can be in $metadata yet have no controller (OrganizationUnit): record the server's answer."""
    def fetch():
        try:
            r = mcp('query_odata', {"entitySet": c['name'], "select": ','.join(c['keyProperties']), "top": 1})
            return {"ok": 'value' in r or 'error' not in r}
        except Exception as e:  # tool-level failure text arrives as a non-JSON content string
            msg = str(e)
            return {"ok": False, "error": msg[:120]}
    return cached(os.path.join(CACHE, 'odata', c['name'] + '.probe.json'), fetch)


with ThreadPoolExecutor(8) as ex:
    probes = dict(zip([c['name'] for c in entities], ex.map(probe, entities)))

swp = os.path.join(CACHE, 'swagger.json')
if not os.path.exists(swp) or REFRESH:
    urllib.request.urlretrieve(BASE + '/swagger/v1/swagger.json', swp)
sw = json.load(open(swp, encoding='utf-8'))

# --- type shortening --------------------------------------------------------
PRIM = {'DateTimeOffset': 'dt', 'String': 'str', 'Guid': 'guid', 'Boolean': 'bool', 'Decimal': 'dec',
        'Int32': 'int', 'Int64': 'long', 'Double': 'dbl', 'Date': 'date', 'Single': 'flt',
        'Int16': 'short', 'Byte': 'byte', 'TimeSpan': 'span', 'TimeOfDay': 'time'}


def oty(t):
    m = re.match(r'Collection\((.+)\)', t)
    if m:
        return oty(m.group(1)) + '[]'
    return PRIM.get(t, t.split('.')[-1])


def sname(n):
    """Hub.Dtos.PagedResultDto`1[[Hub.Dtos.TagDto, ...]] -> Paged<TagDto>"""
    n = n.split('/')[-1]
    m = re.match(r'(.+?)`\d+\[\[(.+?),', n)
    if m:
        outer = m.group(1).split('.')[-1].replace('Dto', '').replace('WithFilters', '+F')
        return f"{outer}<{sname(m.group(2))}>"
    return n.split('.')[-1]


def sty(s):
    if not isinstance(s, dict):
        return '?'
    if '$ref' in s:
        return sname(s['$ref'])
    t, f = s.get('type'), s.get('format')
    if t == 'array':
        return sty(s.get('items', {})) + '[]'
    if f == 'uuid':
        return 'guid'
    if f == 'date-time':
        return 'dt'
    if t == 'integer':
        return 'int'
    if t == 'number':
        return 'num'
    if t == 'boolean':
        return 'bool'
    if t == 'string' and 'enum' in s:
        return 'enum'
    return t or '?'


# --- odata.txt --------------------------------------------------------------
schemas = sw['components']['schemas']
NOISE = {'extraProperties', 'concurrencyStamp', 'creatorId', 'lastModifierId', 'cargonerdsCustomerId'}
BROKEN = {('Event', 'isMilestone'): '!500-in-nested-select'}  # verified server bugs, flagged inline so agents avoid them


def nested_types(entities):
    """Expand targets that are not top-level sets (Event, ShipmentLeg, ...) -> lines from swagger Hub.Entities.*"""
    top = {c['name'] for c in entities}
    targets = set()
    for c in entities:
        for r in c.get('relations', []):
            targets.add(oty(r['target']))
    out = []
    for t in sorted(targets - top):
        key = next((k for k in schemas if k.endswith('.' + t) and k.split('.')[0] in ('Hub', 'Cargonerds')), None)
        if not key:
            continue
        props, rels = [], []
        for k, v in schemas[key].get('properties', {}).items():
            if k in NOISE:
                continue
            ty = sty(v) + BROKEN.get((t, k), '')
            base = ty.rstrip('[]')
            if base in top or base in targets:
                rels.append(f"{k}:{ty}")
            else:
                props.append(f"{k}:{ty}")
        line = wrap(f"{t} (nested; reach via expand)", props)
        if rels:
            line += '\n' + wrap('  expand:', rels, indent='    ')
        out.append(line)
    return out


lines = []
for c in entities:
    props = []
    for p in c['properties']:
        s = p['name'] + ':' + oty(p['type'])
        if p.get('enumMembers'):
            s += '{' + '|'.join(p['enumMembers']) + '}'
        props.append(s)
    rel = [f"{r['name']}:{oty(r['target'])}{'[]' if r.get('isCollection') else ''}"
           for r in c.get('relations', [])]
    dead = '' if probes.get(c['name'], {}).get('ok', True) else ' !NOT-QUERYABLE (server rejects query_odata; use a catalog.txt route)'
    line = wrap(f"{c['name']} key={','.join(c['keyProperties'])}{dead}", props)
    if rel:
        line += '\n' + wrap('  expand:', rel, indent='    ')
    lines.append(line)
lines += nested_types(entities)
write('odata.txt',
      "# OData entity sets for query_odata. Block per set: `Name key=..` then indented prop:type{enum|members} lines,\n"
      "# then `expand: nav:Target[]`. Types: dt=DateTimeOffset str guid bool dec int. Props lowerCamelCase, sets PascalCase.\n"
      "# '(nested; reach via expand)' types are not queryable directly: expand them from a parent, e.g. events($select=actualDate).\n"
      "# Grep anchored: `^Shipment ` for a block header, `^  .*containerNumber` for a property.\n",
      lines)

# --- catalog.txt (non-OData endpoints) ---------------------------------------
byroute = {}
for p, v in sw['paths'].items():
    for m, o in v.items():
        if m in ('get', 'post', 'put', 'delete', 'patch'):
            byroute[(m.upper(), p.lstrip('/'))] = o
rows, dtos_needed = [], set()
for e in catalog:
    if e['route'].startswith('odata/'):
        continue  # covered by odata.txt via query_odata
    o = byroute.get((e['httpMethod'], e['route']), {})
    q = [p['name'] + ':' + sty(p.get('schema', {})) for p in o.get('parameters', [])
         if p.get('in') in ('query', 'path') and not p['name'].startswith('FacetBuilderOptions.')]
    if any(p['name'].startswith('FacetBuilderOptions.') for p in o.get('parameters', [])):
        q.append('FacetBuilderOptions.*')
    rb = o.get('requestBody', {}).get('content', {})
    body = sty(next(iter(rb.values())).get('schema')) if rb else None
    rs = o.get('responses', {}).get('200', {}).get('content', {})
    resp = sty(next(iter(rs.values())).get('schema', {})) if rs else None
    tail = ['?' + x for x in q]
    if body:
        tail.append('body:' + body)
        dtos_needed.add(body.rstrip('[]'))
    if resp:
        tail.append('->' + resp)
        inner = re.search(r'<(.+)>', resp)  # Paged<XDto> -> XDto
        dtos_needed.add((inner.group(1) if inner else resp).rstrip('[]'))
    if not e['isCallable']:
        tail.append('!NOTCALLABLE')
    rows.append(wrap(f"{e['id']} {e['httpMethod']} {e['route']}", tail))
write('catalog.txt',
      "# Non-OData endpoints for call_endpoint. Block: `id METHOD route` then indented ?param:type (query or route) body:Dto ->Response\n"
      "# odata/X routes are NOT listed: use query_odata + odata.txt. Body DTO fields: dtos.txt.\n"
      "# Grep anchored: `^hub/tag/` for a controller, `^[a-z-]+/[a-z-]+/create` for an action. No hit? The thing is an OData set: odata.txt.\n",
      rows)

# --- dtos.txt (request bodies, depth 1, plus nested DTOs they reference) ------
schemas = sw['components']['schemas']
byshort = {}
for k in schemas:
    byshort.setdefault(sname(k), k)
done, out = set(), []


def emit(short):
    if short in done or short not in byshort:
        return
    done.add(short)
    fields = []
    for k, v in schemas[byshort[short]].get('properties', {}).items():
        t = sty(v)
        fields.append(k + ':' + t)
        base = t.rstrip('[]')
        if base in byshort and base not in done and base != short:
            emit(base)
    out.append(wrap(f"{short}:", fields))


for d in sorted(dtos_needed):
    emit(d)
write('dtos.txt',
      "# Request-body and response DTOs for call_endpoint (body:X and ->X in catalog.txt). Block: `Dto:` then indented field:type lines.\n"
      "# Use response fields for `fields`. Grep anchored: `^CreateUpdateTagDto:`\n",
      out)

for f in ('odata.txt', 'catalog.txt', 'dtos.txt'):
    n = os.path.getsize(os.path.join(OUT, f))
    print(f'{f}: {n} chars ~{n // 4} tok')
