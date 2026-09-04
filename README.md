# realtime-lean

Token-lean access to the Cargonerds **realtime** MCP (`api.mcp.cargonerds.dev`) for any AI agent.

Local, unpublished. Test first.

## Why

| Cost centre in the stock MCP | Stock | realtime-lean |
|---|---|---|
| Tool schemas per session | 38 tools, ~10k tokens | 4 tools, ~0.7k tokens |
| Finding an endpoint | `search_endpoints` 1-5k tokens/page, network | `rt_ref` grep of a bundled catalog, ~100 tokens, offline |
| Property names | `describe_odata_entity_set` ~2k tokens | in `reference/odata.txt` |
| Unselected record | 3-9x the needed payload | `select`/`fields` enforced by the skill; `rt_query` refuses a call without `select` |
| Response noise | `@odata.context`, nulls, `concurrencyStamp` | stripped |
| Skill delivery | none | `skills/realtime-lean/SKILL.md`, also served as MCP `instructions` and a prompt |

## Layout

```
.claude-plugin/plugin.json      Claude Code plugin manifest (+ mcpServers -> mcp/server.mjs)
.claude-plugin/marketplace.json local marketplace so the plugin installs from this folder
skills/realtime-lean/SKILL.md   the operating skill (procedure, recipes, gotchas, red flags)
skills/realtime-lean/reference/ odata.txt (entity sets + nested types), catalog.txt (727 non-OData endpoints), dtos.txt (request bodies)
mcp/server.mjs                  zero-dependency stdio MCP proxy, Node >= 18
scripts/build-reference.py      regenerates reference/ from the live MCP + swagger
tests/e2e.mjs                   proxy smoke test (live network)
tests/bench/                    before/after token benchmark (analyze.py + scenarios.md)
AGENTS.md, gemini-extension.json  context for Codex/Gemini/OpenCode style runtimes
```

## Install (Claude Code, local)

```
setx RT_API_KEY <your realtime api key>        # new shells only; or set it in the shell you start claude from
claude plugin marketplace add C:\Users\IdrisPresswala\realtime-lean
claude plugin install realtime-lean@realtime-lean-local
```

Then remove (or disable) the stock `realtime` entry in `~/.claude.json` `mcpServers`, otherwise both servers load and the 38 stock tools come back. Restart Claude Code.

## Hosted endpoint (any MCP client, no install)

The same proxy runs as a streamable-HTTP MCP server on the aisolutions VM. Each client sends its own realtime API key; the host stores none.

```
URL     https://aisolutions.cargonerds.dev/lean/mcp
Header  X-Api-Key: <your key from admin.mcp.cargonerds.dev/api-keys>   (or Authorization: Bearer <key>)
Health  https://aisolutions.cargonerds.dev/lean/healthz
```

Claude Code: `claude mcp add --transport http realtime https://aisolutions.cargonerds.dev/lean/mcp --header "X-Api-Key: <key>"`

Claude Desktop, Cursor, Codex, custom agents: add an HTTP MCP server with that URL and header. The `initialize` response carries the skill as `instructions`; clients that ignore instructions can pull the `realtime-lean` prompt.

Operations: service `realtime-lean` in `~/n8n-compose/docker-compose.yml` on the VM (block in `deploy/docker-compose.realtime-lean.yml`, image from `Dockerfile`, 256 MB limit, Traefik strips `/lean`). Redeploy after a change:

```
tar --exclude=.git --exclude=tests/bench/runs --exclude=scripts/.cache -czf - . | ssh azureuser@aisolutions.cargonerds.dev 'tar -xzf - -C ~/n8n-compose/realtime-lean'
ssh azureuser@aisolutions.cargonerds.dev 'cd ~/n8n-compose && docker compose up -d --build realtime-lean'
```

## Local stdio (any MCP client that spawns processes)

```json
{ "mcpServers": { "realtime": {
    "command": "node",
    "args": ["C:/Users/IdrisPresswala/realtime-lean/mcp/server.mjs"],
    "env": { "RT_API_KEY": "<key>" } } } }
```

For runtimes that read a context file, point them at `AGENTS.md`.

## Tools

| tool | does |
|---|---|
| `rt_ref {q, file?}` | grep the bundled reference. Entity name returns the whole block; property name returns owning entities; endpoint id part returns catalog lines. Offline. |
| `rt_query {entitySet, select!, where?, filter?, expand?, orderBy?, top?, skip?, count?}` | `query_odata` passthrough, `select` mandatory, response compacted |
| `rt_call {id, path?, query?, body?, fields?}` | `call_endpoint` passthrough, response compacted |
| `rt_describe {endpoint? \| entitySet?}` | live describe, fallback when the reference is stale |

## Maintenance

```
set RT_API_KEY=...
python scripts/build-reference.py --refresh    # ~2 min: 10 catalog pages, 62 entity sets, 52 MB swagger
node tests/e2e.mjs
claude plugin update realtime-lean             # the install is a snapshot; re-snapshot after edits
```

Raw downloads are cached in `%TEMP%\realtime-lean-cache` (override with `RT_CACHE`), outside the plugin so the install snapshot stays small.
Regenerate when the API adds endpoints or properties. `rt_describe` covers the gap in between.

## Benchmark

See `tests/bench/scenarios.md` for the four scenarios, the baseline (stock MCP, no skill) and the with-skill numbers.
