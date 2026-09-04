# Benchmark: stock realtime MCP vs realtime-lean skill

Method: one fresh general-purpose subagent per scenario in Claude Code, same prompt, same live data (2026-09-04).
Baseline = stock MCP tools, no skill. With skill = agent told to read SKILL.md first and grep `reference/`.
Numbers from the subagent transcripts (`analyze.py <agent-*.jsonl>`): realtime tool calls and the characters
those calls returned into context. Subagent total tokens are dominated by the harness and barely move; the
saving is in round trips and tool-result payload.

## Scenarios

| # | Prompt |
|---|---|
| S1 | For shipment cargonerdsNumber S240201013756, what are estimatedArrival, actualArrival and state? |
| S2 | Which containers belong to shipment S240201013756, and what tracking events with timestamps exist for them? |
| S3 | How many shipments are in state Booked? Count plus first 10 cargonerdsNumbers by creationTime desc. |
| S4 | Which endpoint creates a Tag in hub, with body fields? Which endpoint lists ports, with query params? (read-only) |
| S5 | Prepare (do not execute) the call creating Tag POC-Test #FF0000 for the org unit whose displayName contains Cargo. |
| S6 | How many Orders have orderDate in August 2026, split by order status name? |

## Results

| # | baseline realtime calls | baseline result chars | with skill calls | with skill result chars | notes |
|---|---|---|---|---|---|
| S1 | 2 (1 wasted probe with S-number on a GUID route) | 343 | 1 | 290 | recipe hit, no reference grep needed |
| S2 | 7 (describe x3, search, EventCode lookup, empty probe) | 23,143 | 2 (1 failed: expand depth 3); re-run after gotcha: 1 | 2,100 | one call returns containers + events + labels + tracking |
| S3 | 2 (describe Shipment 7.4k) | 8,589 | 1 | 1,100 | re-run after count+list recipe: 1 call, "zero friction" |
| S4 | 6 (search x2, describe x3) | 7,225 | 0 | 0 | answered from reference only |
| S5 | not run | | 2 (1 failed: OrganizationUnit listed in odata.txt but server has no OData controller) | 1,620 | no write performed; exposed two reference gaps, fixed: sets are now probed and marked `!NOT-QUERYABLE`, response DTOs added to dtos.txt |
| S6 | not run | | 1 | 420 | Order where orderDate ge/lt + expand orderStatus($select=code,description), count client-side |

Tool schema cost per session: stock 38 tools = 39,701 chars (~10k tokens); proxy 4 tools = 2,909 chars (~0.7k tokens).
Skill on-invoke cost: ~1.6k tokens (claude plugin details). Reference block via rt_ref: Shipment 2.2k chars, Port 0.5k, an endpoint 0.1k.

## Baseline rationalizations captured (RED)

- "Ran describe + query in parallel; the describe was belt-and-braces."
- Parallel probe of `api/app/shipment/{id}` with an S-number "returned empty (that endpoint likely wants a GUID)".
- Unscoped `search_endpoints "port"` returned 33 matches, "mostly noise".
- `$expand=events` without `$select` "returned all ~14 columns per event, about 3x the needed payload".

## With-skill temptations reported (GREEN)

- "The query_odata tool description itself says call describe first... the skill was clear enough to override it."
- "Was tempted to fire a parallel TrackingContainer probe; skipped per the red-flag rule."
- "Tempted to call search_endpoints 'port' after the catalog grep came back empty, but a tighter grep plus odata.txt settled it."
