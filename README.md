# realtime-lean

A token-efficient connector between the Cargonerds **realtime** MCP (`api.mcp.cargonerds.dev`) and any AI client.
Runs on your machine, talks straight to the API with your own key. Nothing is hosted, nothing changes on the server.

## Install

Requires Node 18+ and a realtime API key from https://admin.mcp.cargonerds.dev/api-keys (API Key Administration, New API Key).

Claude Code:

```
claude plugin marketplace add idrispwala-web/realtime-lean
claude plugin install realtime-lean@cargonerds
/realtime-lean:setup <your key>
```

The setup command stores the key in `~/.realtime-lean/key` and runs one test query. No restart needed.
If you still have the stock server configured, remove it so the 38 stock tools do not load next to the 4 lean ones:
`claude mcp remove realtime -s user`.

Other MCP clients (Claude Desktop, Cursor, Codex, custom agents): clone the repo and add a stdio server

```json
{ "mcpServers": { "realtime": {
    "command": "node",
    "args": ["<clone path>/mcp/server.mjs"],
    "env": { "RT_API_KEY": "<your key>" } } } }
```

The `initialize` response carries the skill as MCP `instructions`; clients that ignore instructions can pull the `realtime-lean` prompt. Runtimes that read a context file: point them at `AGENTS.md`.

## What it does

| stock MCP | realtime-lean |
|---|---|
| 38 tools, ~10k tokens of schema in clients that load every schema | 4 tools, ~0.7k tokens |
| `search_endpoints` 1-5k tokens per page, `describe_*` 0.5-7k, over the network | `rt_ref` grep of a bundled catalog, ~100 tokens, offline |
| unselected records, 3-9x the needed payload | `select` required; nulls, `@odata.context`, `concurrencyStamp` stripped |
| opaque "Reference 3ac2..." on server bugs | known-bad query shapes refused before the round trip, causes appended to other errors |
| concurrent calls fail upstream | calls serialised in the connector |
| no guidance | skill: one question = one call, verified recipes, gotchas |

Measured on 24 headless runs (`tests/bench/report.html`): input tokens per question 110k -> 53k, realtime calls 3.3 -> 1.2, tool payload 10.7k -> 0.9k chars, 12/12 correct in both arms.

## Tools

| tool | does |
|---|---|
| `rt_ref {q, file?}` | grep the bundled reference. Entity name returns the whole block; property name returns owning entities; endpoint id part returns catalog lines. Offline. |
| `rt_query {entitySet, select!, where?, filter?, expand?, orderBy?, top?, skip?, count?}` | `query_odata` passthrough, `select` mandatory, response compacted |
| `rt_call {id, path?, query?, body?, fields?}` | `call_endpoint` passthrough, response compacted |
| `rt_describe {endpoint? \| entitySet?}` | live describe, fallback when the reference is stale |

## Layout

```
.claude-plugin/plugin.json      plugin manifest
.claude-plugin/marketplace.json marketplace "cargonerds" (this repo installs as realtime-lean@cargonerds)
.mcp.json                       starts mcp/server.mjs for Claude Code
commands/setup.md               /realtime-lean:setup <key>
skills/realtime-lean/SKILL.md   the operating skill (procedure, recipes, gotchas, red flags)
skills/realtime-lean/reference/ odata.txt (entity sets + nested types), catalog.txt (727 non-OData endpoints), dtos.txt (request + response DTOs)
mcp/server.mjs                  zero-dependency stdio MCP connector, Node >= 18
scripts/build-reference.py      regenerates reference/ from the live MCP + swagger
tests/e2e.mjs                   connector smoke test (live network)
tests/bench/                    A/B benchmark harness, results and report
evals/                          eval cases (claude plugin eval layout)
```

## Key handling

The key is read on every call: env `RT_API_KEY` first, else `~/.realtime-lean/key`. It is never in the repo, never sent anywhere but `api.mcp.cargonerds.dev`, and a key's permissions are the portal user's permissions. Revoke a key in the portal to cut access.

## Maintenance

```
set RT_API_KEY=...
python scripts/build-reference.py --refresh    # ~2 min: 10 catalog pages, 62 entity sets, 52 MB swagger
node tests/e2e.mjs
```

Raw downloads cache in `%TEMP%\realtime-lean-cache` (override with `RT_CACHE`). Regenerate when the API adds endpoints or properties; `rt_describe` covers the gap in between.

Release: bump `version` in `.claude-plugin/plugin.json` and `marketplace.json`, commit, push. Users get it with `claude plugin update realtime-lean`. Unbumped versions do not propagate.
