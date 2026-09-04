#!/usr/bin/env node
// Smallest check that fails if the proxy breaks: spawn server.mjs, drive it over stdio, assert shapes.
// Run: RT_API_KEY=... node tests/e2e.mjs   (network calls hit the live realtime MCP)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");
const reqs = [
  { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } },
  { id: 2, method: "tools/list" },
  { id: 3, method: "tools/call", params: { name: "rt_ref", arguments: { q: "hub/tag/create" } } },
  { id: 4, method: "tools/call", params: { name: "rt_ref", arguments: { q: "Shipment", file: "odata" } } },
  { id: 5, method: "tools/call", params: { name: "rt_query", arguments: { entitySet: "Shipment", where: [{ field: "state", operator: "eq", value: "Booked" }] } } },
  { id: 6, method: "tools/call", params: { name: "rt_query", arguments: { entitySet: "Shipment", select: "id", top: 0, count: true } } },
  { id: 7, method: "tools/call", params: { name: "rt_call", arguments: { id: "hub/tag/get-visible-tags-queryable", fields: ["name"] } } },
  { id: 8, method: "nope/nope" },
];

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
let buf = "";
const out = {};
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { const m = JSON.parse(line); out[m.id] = m; }
  }
});
for (const r of reqs) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
child.stdin.end();
await new Promise((res) => child.on("close", res));

const text = (id) => out[id].result.content[0].text;
assert.equal(out[1].result.serverInfo.name, "realtime-lean");
assert.ok(out[1].result.instructions.includes("one question = one call"), "instructions carry the skill");
assert.deepEqual(out[2].result.tools.map((t) => t.name), ["rt_ref", "rt_query", "rt_call", "rt_describe"]);
assert.ok(JSON.stringify(out[2].result.tools).length < 4000, "tool schemas stay under ~1k tokens");
assert.match(text(3), /^\[catalog\] hub\/tag\/create POST api\/app\/tag\n  body:CreateUpdateTagDto ->TagDto$/, "exact id returns only that block");
assert.match(text(4), /\[odata\] Shipment key=id\n  actualArrival:dt/);
assert.equal(out[5].result.isError, true, "rt_query without select is refused locally");
const count = JSON.parse(text(6));
assert.ok(Number.isInteger(count.count) && count.value.length === 0, "count-only query compacts @odata.count -> count");
assert.ok(!text(6).includes("@odata.context"), "odata.context stripped");
assert.ok(Array.isArray(JSON.parse(text(7))), "rt_call with fields returns compact array");
assert.equal(out[8].error.code, -32601);
console.log("e2e ok:", Object.keys(out).length, "responses");
