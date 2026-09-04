#!/usr/bin/env node
// realtime-lean: zero-dependency stdio MCP connector in front of the Cargonerds realtime MCP.
// Runs on the user's machine, talks straight to api.mcp.cargonerds.dev with the user's own key.
// 4 lean tools instead of 38, responses compacted, skill shipped as server instructions.
//
// Key lookup, per call: env RT_API_KEY, else the file ~/.realtime-lean/key (written by /realtime-lean:setup).
// Env: RT_BASE_URL (default https://api.mcp.cargonerds.dev)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REF = path.join(ROOT, "skills", "realtime-lean", "reference");
const BASE = (process.env.RT_BASE_URL || "https://api.mcp.cargonerds.dev").replace(/\/$/, "");
const KEY_FILE = path.join(os.homedir(), ".realtime-lean", "key");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;

const instructions = fs
  .readFileSync(path.join(ROOT, "skills", "realtime-lean", "SKILL.md"), "utf8")
  .replace(/^---[\s\S]*?---\s*/, "");

// Keys are 48 hex chars. Tolerate what shells do to a file: UTF-16 (PowerShell Out-File default), BOM, quotes, CRLF.
function extractKey(text) {
  const m = text.match(/[0-9a-fA-F]{32,64}/);
  return m ? m[0] : text.replace(/^[\s"']+|[\s"']+$/g, "");
}
let keySource = "none";
function apiKey() {
  if (process.env.RT_API_KEY) { keySource = "env RT_API_KEY"; return extractKey(process.env.RT_API_KEY); }
  try {
    const buf = fs.readFileSync(KEY_FILE);
    const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
    keySource = KEY_FILE;
    return extractKey(text);
  } catch { keySource = "none"; return ""; }
}

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
// one at a time succeeds. Serialise, so an agent may still issue rt_* calls in parallel.
let chain = Promise.resolve();
function upstream(name, args) {
  const run = chain.then(() => upstreamNow(name, args));
  chain = run.catch(() => {});
  return run;
}

async function upstreamNow(name, args) {
  const key = apiKey();
  if (!key) throw new Error("no API key. Run /realtime-lean:setup <key> (creates ~/.realtime-lean/key) or set RT_API_KEY. Keys: https://admin.mcp.cargonerds.dev/api-keys");
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Api-Key": key },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  if (res.status === 401) throw new Error(`upstream 401: the API key was rejected. Key read from ${keySource}, ${key.length} chars, starts ${key.slice(0, 4)}. Expected 48 hex chars from https://admin.mcp.cargonerds.dev/api-keys; re-run /realtime-lean:setup <key>.`);
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
async function call(name, a = {}) {
  switch (name) {
    case "rt_ref":
      return ref(a.q, a.file);
    case "rt_query": {
      if (!a.select) throw new Error("select is required: name the properties you will read");
      const bad = preflight(a);
      if (bad) throw new Error(bad);
      const r = await upstream("query_odata", a);
      return r.isError ? hint(r.text) : compact(r.text);
    }
    case "rt_call": {
      const r = await upstream("call_endpoint", a);
      return r.isError ? hint(r.text) : compact(r.text);
    }
    case "rt_describe": {
      const r = a.endpoint
        ? await upstream("describe_endpoint", { id: a.endpoint })
        : await upstream("describe_odata_entity_set", { entitySet: a.entitySet });
      return r.isError ? r.text : compact(r.text);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---- JSON-RPC over stdio ---------------------------------------------------------
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id: req.id, error: { code, message } });
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
          const text = await call(req.params.name, req.params.arguments);
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
    fail(-32603, String(e.message || e));
  }
});
