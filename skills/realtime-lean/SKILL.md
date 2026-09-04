---
name: realtime-lean
description: Use when answering a question or making a change through the Cargonerds realtime MCP (shipments, containers, tracking, orders, ports, tags, identity, any hub or cargonerds endpoint) - before the first tool call, and whenever tempted to call search_endpoints, describe_endpoint or describe_odata_entity_set.
---

# realtime-lean

Every realtime call costs a full round trip of context. Discovery calls cost 0.5-7k tokens each and are almost never needed: `reference/` already holds the whole catalog offline.

## Procedure: one question = one call

1. **Names from the reference, not the network.** `rt_ref q=<Entity|endpoint-id|property>` (proxy) or grep `reference/odata.txt`, `reference/catalog.txt`, `reference/dtos.txt`. Each file is blocks: header line + indented detail lines, so grep anchored (`^Shipment `, `^hub/tag/`, `^CreateUpdateTagDto:`) and take the block with `-A 26` (the largest block; most are under 10 lines). Unanchored `port` matches export/report/import. No hit in catalog.txt means it is an OData set: look in odata.txt. Call `rt_describe` / `describe_*` only when the reference has no entry.
2. **Data question:** `rt_query` (= `query_odata`) with `where` (model-checked) + `select` of only the fields you will report + `top`. Count only: `count:true, top:0`. Relations: `expand: nav($select=a,b)`.
3. **Action or non-OData route:** `rt_call` (= `call_endpoint`) with `fields` on every GET, `body` from dtos.txt on writes. Confirm writes with the user before sending.
4. **Answer from the response.** No confirming second call, no probe with a guessed id type.

## Tool map

| proxy (plugin) | raw realtime server | local |
|---|---|---|
| rt_ref | search_endpoints, describe_endpoint, describe_odata_entity_set, list_odata_entity_sets | grep reference/*.txt |
| rt_query | query_odata | |
| rt_call | call_endpoint, hub_*, cargonerds_* | |
| rt_describe | describe_* (only when rt_ref has no entry) | |

## Verified recipes

| Need | Call |
|---|---|
| Shipment by number | Shipment `where cargonerdsNumber eq X` `select cargonerdsNumber,state,estimatedArrival,actualArrival` |
| Count | Shipment `where state eq Booked` `select id` `count true` `top 0` -> `@odata.count` |
| Count + first N in one call | same with `top 10` `orderBy creationTime desc` `select cargonerdsNumber,creationTime` |
| Containers of a shipment | `expand containers($select=containerNumber)` |
| Shipment milestones with labels (one call) | `expand events($select=actualDate,expectedDate,locationUnlocode;$expand=code($select=code,actualLabel))` |
| Live container tracking (AIS legs) | TrackingContainer `where containerReference eq X` `select containerReference,lastEventDateTime` `expand trackingLegs($select=eventDateTime,location;$expand=eventClassifierCode($select=code))` |
| Tracking per shipment (non-OData) | `hub/shipment/get-tracking-new` `path.id=<shipment guid>` `fields [containerReference,lastEventDateTime,trackingLegs.eventDateTime,trackingLegs.location]` |
| Which shipments a container is on | TrackingContainer `where containerReference eq X` `select containerReference` `expand shipments($select=cargonerdsNumber,state)` |
| Create a tag | `hub/tag/create` body per dtos.txt `CreateUpdateTagDto` |

## Gotchas

- `api/app/shipment/{id}` takes a GUID, not an S-number. Business keys go through `query_odata where`.
- A set marked `!NOT-QUERYABLE` in odata.txt (or one the server answers "not found") has no OData controller: use the catalog.txt route instead (`identity/.../organization-unit-lookup` for org units). `fields` names for `rt_call` come from the `->Response` DTO in dtos.txt.
- `Event` is not an entity set: reach it via Shipment `expand events(...)`. Nested types are listed in odata.txt as `(nested; reach via expand)`.
- `trackingContainers: []` means the shipment has no live (AIS/carrier) tracking subscription. The `events` collection is then the complete history. Report that; do not probe other tracking routes.
- A wrong property name inside a nested `$select` is dropped silently, not reported. Take nested names from odata.txt.
- `$expand` depth is capped at 2: from Shipment you can reach `trackingContainers($expand=trackingLegs(...))` but not the legs' `eventClassifierCode`. Need level 3? Start from the middle entity (TrackingContainer) instead.
- Server bugs (500) to avoid: `isMilestone` inside a nested `$select`; `$orderby`/`$top` inside `expand(...)`. Order at the top level instead.
- Enum-like lookups (`state`, `orderStatus`...) are either an enum property with members listed in odata.txt `{A|B}` or a navigation (`orderStatusId` + `expand orderStatus($select=name)`). Check which before filtering.
- No `select` = every column = 3-9x the tokens.
- Proxy responses drop null-valued fields and `@odata.` prefixes: a selected key that is absent from a row is null (e.g. no ETA yet); `@odata.count` arrives as `count`.

## Red flags - stop

- "Describe first, to be safe." The `where` clause is model-checked: a wrong name comes back with the right names. odata.txt already has them.
- A parallel "probe" call with a guessed id. One correct call beats two guesses plus a turn to reconcile.
- Expanding without `$select` "to see what is there."

| Excuse | Reality |
|---|---|
| "describe confirms the property names" | odata.txt has them; `where` corrects them. 7k tokens for nothing. |
| "an extra parallel call is free" | It is another full-context round plus turns to reconcile two answers. |
| "expand everything, filter later" | 3-9x payload. Select from odata.txt, once. |
| "search_endpoints is quick" | 1-5k tokens per page. `rt_ref`/grep is 0 network, ~100 tokens. |
