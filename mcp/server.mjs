#!/usr/bin/env node
// realtime-lean: zero-dependency MCP proxy in front of the Cargonerds realtime MCP.
// 4 lean tools instead of 38, responses compacted, skill shipped as server instructions.
//
//   node mcp/server.mjs                 stdio transport; key from env RT_API_KEY
//   node mcp/server.mjs --http 8787     streamable-HTTP transport on POST /mcp; key from the caller's
//                                       X-Api-Key (or Authorization: Bearer) header, forwarded upstream.
//                                       The hosted proxy holds no credential of its own.
// Env: RT_BASE_URL (default https://api.mcp.cargonerds.dev), RT_API_KEY (stdio only)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REF = path.join(ROOT, "skills", "realtime-lean", "reference");
const BASE = (process.env.RT_BASE_URL || "https://api.mcp.cargonerds.dev").replace(/\/$/, "");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;

const instructions = fs
  .readFileSync(path.join(ROOT, "skills", "realtime-lean", "SKILL.md"), "utf8")
  .replace(/^---[\s\S]*?---\s*/, "");

const FIELDS_DESC = "Dot paths to keep from the response (e.g. id, consignee.name). REQUIRED for GET: a record carries every field its type declares.";
const TOOLS = [
  {
    name: "rt_ref",
    description: "Grep the bundled API reference (odata.txt entity sets + nested types, catalog.txt endpoints, dtos.txt request bodies). Zero network. Use BEFORE any query: it replaces search/describe calls.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Case-insensitive substring or /regex/. Entity name (Shipment), endpoint id part (hub/tag), DTO name, or a property name." },
        file: { type: "string", enum: ["odata", "catalog", "dtos"], description: "Restrict to one file. Omit to search all." },
      },
      required: ["q"],
    },
  },
  {
    name: "rt_query",
    description: "OData query (entity sets in odata.txt). select is REQUIRED. Use where (model-checked) over filter. count:true + top:0 gives a count only. expand supports nested $select: containers($select=containerNumber). Wrong nested names are dropped silently: take them from odata.txt. Never put isMilestone in a nested $select (server 500). Shipment milestones with labels: expand events($select=actualDate,expectedDate,locationUnlocode;$expand=code($select=code,actualLabel)). Null-valued fields are omitted from rows: a missing key means null, not a failed select.",
    inputSchema: {
      type: "object",
      properties: {
        entitySet: { type: "string" },
        select: { type: "string", description: "Comma-separated properties to return." },
        where: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              operator: { type: "string", enum: ["eq", "ne", "gt", "ge", "lt", "le", "in", "contains", "startswith", "endswith"] },
              value: {},
            },
            required: ["field", "operator", "value"],
          },
        },
        filter: { type: "string", description: "Raw $filter for what where cannot express." },
        expand: { type: "string", description: "e.g. containers($select=containerNumber),events($select=actualDate,codeId)" },
        orderBy: { type: "string", description: "e.g. creationTime desc" },
        top: { type: "integer" },
        skip: { type: "integer" },
        count: { type: "boolean" },
      },
      required: ["entitySet", "select"],
    },
  },
  {
    name: "rt_call",
    description: "Call a non-OData endpoint by id from catalog.txt (api/app/... routes). Writes need body per dtos.txt. Pass fields on every GET.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Endpoint id, e.g. hub/tag/create" },
        path: { type: "object", description: "Route params by name.", additionalProperties: true },
        query: { type: "object", description: "Query params by name.", additionalProperties: true },
        body: { description: "Request body for writes." },
        fields: { type: "array", items: { type: "string" }, description: FIELDS_DESC },
      },
      required: ["id"],
    },
  },
  {
    name: "rt_describe",
    description: "Fallback when rt_ref has no entry (reference stale): live describe of one endpoint id or one OData entity set. Costs 0.5-2k tokens; prefer rt_ref.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Endpoint id" },
        entitySet: { type: "string", description: "OData entity set name" },
      },
    },
  },
];

// ---- upstream -----------------------------------------------------------------
// The upstream host fails ("The request failed. Reference ...") when several calls hit it at once;
// one at a time succeeds. Serialise per API key, so one agent may still issue rt_* calls in parallel
// without one tenant queueing behind another.
const chains = new Map();
function upstream(name, args, key) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(() => upstreamNow(name, args, key));
  chains.set(key, run.catch(() => {}));
  return run;
}

async function upstreamNow(name, args, key) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Api-Key": key },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("") || raw;
  let msg;
  try { msg = JSON.parse(data); } catch { throw new Error(`upstream ${res.status}: ${raw.slice(0, 300)}`); }
  if (msg.error) throw new Error(`upstream: ${msg.error.message || JSON.stringify(msg.error)}`);
  const text = (msg.result?.content || []).map((c) => c.text ?? "").join("");
  return { text, isError: !!msg.result?.isError };
}

function compact(text) {
  let v;
  try { v = JSON.parse(text); } catch { return text; }
  const strip = (x) => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === "object") {
      const o = {};
      for (const [k, val] of Object.entries(x)) {
        if (val === null || k === "@odata.context" || k === "concurrencyStamp") continue;
        o[k.startsWith("@odata.") ? k.slice(7) : k] = strip(val);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(strip(v));
}

// ---- local reference grep ------------------------------------------------------
function ref(q, file) {
  const files = file ? [file] : ["odata", "catalog", "dtos"];
  q = q.trim().replace(/\s+key=.*$/, "").replace(/^\^([\w./-]+)\s*$/, "$1");  // "Event key=", "^Shipment " -> bare name
  const m = q.match(/^\/(.+)\/([a-z]*)$/) || (q.startsWith("^") ? [null, q, ""] : null);  // other ^anchors count as regex
  const re = m ? new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i") : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  // Every file is blocks: a header line (no indent) + indented detail lines.
  // 1) header whose first token equals q (or starts with q + "/"): return that block only.
  // 2) otherwise: header substring matches return the block; detail matches return "Header: matching tokens".
  const blocks = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(REF, f + ".txt"), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#") || lines[i].startsWith(" ") || !lines[i].trim()) continue;
      const b = { f, head: lines[i], body: [] };
      while (i + 1 < lines.length && lines[i + 1].startsWith(" ")) b.body.push(lines[++i]);
      blocks.push(b);
    }
  }
  const name = (b) => b.head.split(/[ :]/)[0];
  const exact = blocks.filter((b) => !m && (name(b).toLowerCase() === q.toLowerCase() || name(b).toLowerCase().startsWith(q.toLowerCase() + "/")));
  const fmt = (b) => [`[${b.f}] ${b.head}`, ...b.body].join("\n");
  if (exact.length) return exact.slice(0, 20).map(fmt).join("\n");
  const out = [];
  for (const b of blocks) {
    if (re.test(b.head)) out.push(fmt(b));
    else {
      const hits = b.body.flatMap((l) => l.trim().split(" ").filter((t) => re.test(t)));
      if (hits.length) out.push(`[${b.f}] ${name(b)}: ${hits.join(" ")}`);
    }
    if (out.length >= 40) { out.push("... truncated: narrow q, set file, or use the exact name"); break; }
  }
  return out.length ? out.join("\n") : `no match for ${q}. Use the bare entity or DTO name (Event, Shipment, CreateUpdateTagDto), an endpoint id part (hub/tag), or a property name; rt_describe as last resort.`;
}

// ---- known server bugs: refuse before the round trip, explain after a failure ------------------
const KNOWN = [
  [/isMilestone/i, "isMilestone inside a nested $select returns HTTP 500. Drop it: every row of events is returned anyway."],
  [/\$(orderby|top|skip)=/i, "$orderby/$top/$skip inside expand(...) fail on this server. Order or limit at the top level instead."],
];
function preflight(a) {
  for (const [re, msg] of KNOWN) if (re.test(a.expand || "")) return "refused before calling upstream: " + msg;
  if ((a.filter || "").split(/\s+or\s+/i).length > 2) return "refused before calling upstream: a raw filter with several 'or' terms fails upstream. One where per lookup, or at most one 'or'.";
  return null;
}
function hint(text) {
  if (!/server error|request failed/i.test(text)) return text;
  return text + "\nKnown causes on this server: a wrong nested property name inside $select/$expand (take names from rt_ref odata), " +
    "expand depth over 2, a set marked !NOT-QUERYABLE, or several calls in flight at once. Fix the shape and retry once; do not retry the same call.";
}

// ---- tool dispatch --------------------------------------------------------------
async function call(name, a = {}, key) {
  // the key is only validated upstream, but requiring one keeps the offline reference off the open internet
  if (!key) throw new Error("no API key: set RT_API_KEY (stdio) or send X-Api-Key / Authorization: Bearer (http)");
  switch (name) {
    case "rt_ref":
      return ref(a.q, a.file);
    case "rt_query": {
      if (!a.select) throw new Error("select is required: name the properties you will read");
      const bad = preflight(a);
      if (bad) throw new Error(bad);
      const r = await upstream("query_odata", a, key);
      return r.isError ? hint(r.text) : compact(r.text);
    }
    case "rt_call": {
      const r = await upstream("call_endpoint", a, key);
      return r.isError ? hint(r.text) : compact(r.text);
    }
    case "rt_describe": {
      const r = a.endpoint
        ? await upstream("describe_endpoint", { id: a.endpoint }, key)
        : await upstream("describe_odata_entity_set", { entitySet: a.entitySet }, key);
      return r.isError ? r.text : compact(r.text);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---- JSON-RPC dispatcher (transport independent) ----------------------------------
// Returns a response object, or null for notifications.
async function handle(req, key) {
  if (req.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });
  try {
    switch (req.method) {
      case "initialize":
        return reply({
          protocolVersion: req.params?.protocolVersion || "2025-03-26",
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "realtime-lean", version: VERSION },
          instructions,
        });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        try {
          const text = await call(req.params.name, req.params.arguments, key);
          return reply({ content: [{ type: "text", text }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
        }
      }
      case "prompts/list": return reply({ prompts: [{ name: "realtime-lean", description: "How to use the realtime API with minimal tokens" }] });
      case "prompts/get": return reply({ messages: [{ role: "user", content: { type: "text", text: instructions } }] });
      case "resources/list": return reply({ resources: [] });
      default: return fail(-32601, `method not found: ${req.method}`);
    }
  } catch (e) {
    return fail(-32603, String(e.message || e));
  }
}

// ---- transports -------------------------------------------------------------------
const httpIdx = process.argv.indexOf("--http");
if (httpIdx < 0) {
  // stdio: newline-delimited JSON-RPC, key from env
  const KEY = process.env.RT_API_KEY || "";
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const res = await handle(req, KEY);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
} else {
  // streamable HTTP (stateless): POST /mcp with JSON body, JSON response; GET /mcp is not a stream here.
  const port = Number(process.argv[httpIdx + 1] || process.env.PORT || 8787);
  const server = http.createServer(async (rq, rs) => {
    const url = new URL(rq.url, "http://x");
    const send = (code, body, type = "application/json") => { rs.writeHead(code, { "Content-Type": type }); rs.end(body); };
    if (url.pathname === "/healthz") return send(200, JSON.stringify({ ok: true, version: VERSION }));
    if (url.pathname !== "/mcp") return send(404, "not found", "text/plain");
    if (rq.method === "GET" || rq.method === "DELETE") return send(405, "stateless server: POST /mcp only", "text/plain");
    if (rq.method !== "POST") return send(405, "POST only", "text/plain");
    let body = "";
    for await (const chunk of rq) { body += chunk; if (body.length > 1e6) return send(413, "too large", "text/plain"); }
    let req;
    try { req = JSON.parse(body); } catch { return send(400, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })); }
    const auth = rq.headers["authorization"] || "";
    const key = rq.headers["x-api-key"] || (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "");
    const t0 = Date.now();
    const reqs = Array.isArray(req) ? req : [req];
    const out = (await Promise.all(reqs.map((r) => handle(r, key)))).filter(Boolean);
    for (const r of reqs) console.log(`${new Date().toISOString()} ${r.method}${r.params?.name ? " " + r.params.name : ""} key=${key.slice(0, 8) || "-"} ${Date.now() - t0}ms`);
    if (!out.length) return send(202, "");
    return send(200, JSON.stringify(Array.isArray(req) ? out : out[0]));
  });
  server.listen(port, () => console.log(`realtime-lean ${VERSION} listening on :${port} (POST /mcp, GET /healthz), upstream ${BASE}`));
}
