// SPDX-License-Identifier: GPL-3.0-or-later
// test-opencode-agent-tools.js - node tests for the OpenCode tool backend
// (site-driven agent mode). Pure-node, zero dependencies:
//   node test-opencode-agent-tools.js
// Exit code 0 = all pass.
"use strict";

const path = require("path");
const T = require(path.join(__dirname, "opencode-agent-tools.js"));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} ${JSON.stringify(a) === JSON.stringify(b) ? "" : `\n      got: ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`}`); }

const main = async () => {
// ── 1. Catalogue: MCP-shaped, mirrors the fork's tool schemas ─────────────
console.log("catalogue");
const cat = T.catalog();
eq(cat.map((t) => t.name), ["bash", "read", "write", "edit", "glob", "grep"], "tool ids match the fork's registry");
for (const t of cat) {
  ok(t.name && typeof t.description === "string" && t.description.length > 10, `${t.name}: description present`);
  ok(t.inputSchema && t.inputSchema.type === "object" && t.inputSchema.properties, `${t.name}: inputSchema object`);
}
eq(Object.keys(cat.find((t) => t.name === "bash").inputSchema.properties), ["command", "timeout", "workdir"], "bash params match fork (command, timeout?, workdir?)");
eq(cat.find((t) => t.name === "bash").inputSchema.required, ["command"], "bash required");
eq(Object.keys(cat.find((t) => t.name === "read").inputSchema.properties), ["filePath", "offset", "limit"], "read params match fork");
eq(cat.find((t) => t.name === "read").inputSchema.required, ["filePath"], "read required");
eq(Object.keys(cat.find((t) => t.name === "write").inputSchema.properties), ["filePath", "content"], "write params match fork");
eq(Object.keys(cat.find((t) => t.name === "edit").inputSchema.properties), ["filePath", "oldString", "newString", "replaceAll"], "edit params match fork");
eq(cat.find((t) => t.name === "edit").inputSchema.required, ["filePath", "oldString", "newString"], "edit required");
eq(Object.keys(cat.find((t) => t.name === "glob").inputSchema.properties), ["pattern", "path"], "glob params match fork");
eq(Object.keys(cat.find((t) => t.name === "grep").inputSchema.properties), ["pattern", "path", "include"], "grep params match fork");

// ── 2. normalizeBase / auth header ─────────────────────────────────────────
console.log("url & auth");
eq(T.normalizeBase(""), T.DEFAULT_BASE, "empty -> default base");
eq(T.normalizeBase("host:4096"), "http://host:4096", "scheme added");
eq(T.normalizeBase("http://host:4096/"), "http://host:4096", "trailing slash stripped");
ok(T.basicAuthHeader("", "").startsWith("Basic "), "auth header Basic prefix");
ok(T.basicAuthHeader("", "pw").includes(Buffer.from("opencode:pw").toString("base64")), "auth header encodes opencode:password");

// ── 3. exec() mapping against a mocked fetch ───────────────────────────────
console.log("exec mapping");
function mockFetch(status, body) {
  return async (url, opts) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  });
}

{
  const calls = [];
  const r = await T.exec("read", { filePath: "a.txt" }, {
    base: "http://127.0.0.1:4096",
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return mockFetch(200, { title: "a.txt", output: "hi" })(url, opts); },
  });
  ok(r.ok && r.text === "hi" && r.title === "a.txt", "200 -> ok with output");
  eq(calls[0].url, "http://127.0.0.1:4096/tool/read", "POST URL /tool/:name");
  eq(calls[0].opts.method, "POST", "method POST");
  eq(JSON.parse(calls[0].opts.body), { arguments: { filePath: "a.txt" } }, "body wraps arguments");
}
{
  const r = await T.exec("bash", { command: "ls" }, {
    base: "http://x", password: "s3cret",
    fetchImpl: mockFetch(403, { _tag: "ToolApiDisabled", message: "disabled" }),
  });
  ok(!r.ok && r.kind === "error", "403 -> kind error");
  ok(/OPENCODE_TOOL_API=1/.test(r.error), "403 message tells the user the flag");
}
{
  const r = await T.exec("nope", {}, { base: "http://x", fetchImpl: mockFetch(404, { _tag: "ToolNotFound", message: 'Unknown tool "nope".' }) });
  ok(!r.ok && r.kind === "error" && /Unknown tool/.test(r.error), "404 -> clean unknown-tool error");
}
{
  const r = await T.exec("read", { filePath: "x" }, { base: "http://x", fetchImpl: mockFetch(400, { _tag: "ToolExecutionFailed", message: "File not found: x" }) });
  ok(!r.ok && r.kind === "error" && /File not found/.test(r.error), "400 tool failure -> message surfaced");
}
{
  const r = await T.exec("bash", { command: "sleep 100" }, {
    base: "http://x", timeoutMs: 50,
    fetchImpl: async (url, opts) => {
      // Simulate AbortSignal.timeout firing: the mock rejects with an AbortError.
      return new Promise((_, rej) => {
        const e = new Error("The operation was aborted");
        e.name = "AbortError";
        setTimeout(() => rej(e), 10);
      });
    },
  });
  ok(!r.ok && r.kind === "timeout", "abort -> kind timeout");
}
{
  const r = await T.exec("read", {}, { base: "http://x", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  ok(!r.ok && r.kind === "disconnected", "network failure -> kind disconnected");
  ok(/OPENCODE_TOOL_API=1 opencode serve/.test(r.error), "disconnected message points at the serve command");
}

// ── 4. probe() mapping ─────────────────────────────────────────────────────
console.log("probe");
{
  const r = await T.probe("http://x", { fetchImpl: mockFetch(200, { healthy: true, version: "local" }) });
  ok(r.ok && r.version === "local", "probe 200 -> ok");
}
{
  const r = await T.probe("http://x", { fetchImpl: async () => { throw new Error("nope"); } });
  ok(!r.ok && r.error, "probe failure -> ok:false with error");
}

// ── 5. Live smoke against the real fork server (if running) ────────────────
console.log("live (optional)");
{
  const base = process.env.OC_TEST_URL || "http://127.0.0.1:4123";
  const health = await T.probe(base).catch(() => ({ ok: false }));
  if (health.ok) {
    console.log(`  (server at ${base} is up - running live checks)`);
    const list = await fetch(`${base}/tool`).then((r) => r.json());
    ok(Array.isArray(list.tools) && list.tools.some((t) => t.id === "bash"), "live: GET /tool lists bash");
    const r = await T.exec("bash", { command: "echo live-ok" }, { base });
    ok(r.ok && /live-ok/.test(r.text), "live: bash echo via exec()");
  } else {
    console.log("  (no live server on 4123 - skipping live checks)");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

};
main().catch((e) => { console.error(e); process.exit(1); });
