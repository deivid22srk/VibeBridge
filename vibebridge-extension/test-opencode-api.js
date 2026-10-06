// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Node smoke test for opencode-api.js (run: node test-opencode-api.js).
// Pure helpers are always tested; a LIVE OpenCode server is exercised only when
// OPENCODE_LIVE_URL is set (e.g. OPENCODE_LIVE_URL=http://127.0.0.1:4096).
const fs = require("fs");
const ZSApi = new Function(
  fs.readFileSync(__dirname + "/opencode-api.js", "utf8") + "; return ZSOpenCodeApi;"
)();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

// ── normalizeBaseUrl ─────────────────────────────────────────────────────────
ok("normalize adds scheme", ZSApi.normalizeBaseUrl("127.0.0.1:4096") === "http://127.0.0.1:4096");
ok("normalize keeps https", ZSApi.normalizeBaseUrl("https://host.example/") === "https://host.example");
ok("normalize strips trailing slashes", ZSApi.normalizeBaseUrl("http://h:1///") === "http://h:1");
ok("normalize default", ZSApi.normalizeBaseUrl("") === "http://127.0.0.1:4096");
ok("normalize default on undefined", ZSApi.normalizeBaseUrl(undefined) === "http://127.0.0.1:4096");

// ── basic auth (OPENCODE_SERVER_PASSWORD support) ────────────────────────────
ok("basic auth header", ZSApi.basicAuthHeader("opencode", "secret") ===
  "Basic " + Buffer.from("opencode:secret").toString("base64"));
ok("basic auth default username", ZSApi.basicAuthHeader("", "pw") ===
  "Basic " + Buffer.from("opencode:pw").toString("base64"));

// ── SSE parser ───────────────────────────────────────────────────────────────
{
  const p = ZSApi.createSseParser();
  const evs = p.parse('event: message\ndata: {"type":"server.connected"}\n\n');
  ok("sse single frame", evs.length === 1 && evs[0].event === "message" &&
    JSON.parse(evs[0].data).type === "server.connected");
}
{
  // Frame split across two chunks (mid-JSON).
  const p = ZSApi.createSseParser();
  const a = p.parse('data: {"type":"message.par');
  const b = p.parse('t.delta"}\n\n');
  ok("sse split frame", a.length === 0 && b.length === 1 && JSON.parse(b[0].data).type === "message.part.delta");
}
{
  const p = ZSApi.createSseParser();
  const evs = p.parse(': heartbeat\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\n');
  ok("sse comment ignored + multi frames", evs.length === 3 && evs[0].data === "1" && evs[2].data === "3");
}
{
  const p = ZSApi.createSseParser();
  const evs = p.parse('event: message\r\ndata: {"a":1}\r\n\r\n');
  ok("sse CRLF tolerated", evs.length === 1 && JSON.parse(evs[0].data).a === 1);
}
{
  const p = ZSApi.createSseParser();
  const evs = p.parse('data: {"a":\ndata: 1}\n\n');
  ok("sse multiline data joined", evs.length === 1 && evs[0].data === '{"a":\n1}');
}

// ── buildPromptBody ──────────────────────────────────────────────────────────
{
  const b = ZSApi.buildPromptBody("hello", null, null, "");
  ok("prompt text only", b.parts.length === 1 && b.parts[0].type === "text" && b.parts[0].text === "hello" &&
    b.model === undefined && b.agent === undefined);
}
{
  const b = ZSApi.buildPromptBody("look", [{ mime: "text/plain", filename: "a.txt", url: "data:text/plain,hi" }],
    { providerID: "anthropic", modelID: "claude-x" }, "build");
  ok("prompt with file+model+agent", b.parts.length === 2 && b.parts[0].type === "file" &&
    b.parts[0].filename === "a.txt" && b.parts[1].type === "text" &&
    b.model.providerID === "anthropic" && b.model.modelID === "claude-x" && b.agent === "build");
}

// ── toolSummary ──────────────────────────────────────────────────────────────
{
  const s = ZSApi.toolSummary({ type: "tool", tool: "bash", state: { status: "pending", input: { command: "ls -la" }, raw: "" } });
  ok("tool pending", s.status === "pending" && s.tool === "bash" && s.detail === "ls -la");
}
{
  const s = ZSApi.toolSummary({ type: "tool", tool: "bash", state: { status: "running", input: { command: "npm test" }, title: "Running tests" } });
  ok("tool running title", s.status === "running" && s.label === "Running tests");
}
{
  const s = ZSApi.toolSummary({ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/a.js" }, output: "file body", title: "src/a.js" } });
  ok("tool completed output", s.status === "completed" && s.output === "file body" && s.detail === "file body");
}
{
  const s = ZSApi.toolSummary({ type: "tool", tool: "edit", state: { status: "error", input: {}, error: "boom" } });
  ok("tool error", s.status === "error" && s.output === "boom");
}
ok("input summary picks command", ZSApi.inputSummary({ command: "echo hi\nmore" }) === "echo hi");

// ── describeErrorPayload ─────────────────────────────────────────────────────
ok("error from v1 shape", ZSApi.describeErrorPayload(400, '{"name":"BadRequest","data":{"message":"bad input"}}',
  { name: "BadRequest", data: { message: "bad input" } }) === "bad input");
ok("error from text", ZSApi.describeErrorPayload(500, "boom", null) === "boom");
ok("error html fallback", ZSApi.describeErrorPayload(502, "<html>gateway</html>", null) === "HTTP 502");

// ── live server (optional) ───────────────────────────────────────────────────
async function live() {
  const base = process.env.OPENCODE_LIVE_URL;
  if (!base) return;
  const dir = process.env.OPENCODE_LIVE_DIR;
  const c = new ZSApi.Client({ baseUrl: base, directory: dir, timeout: 8000 });
  const h = await c.health();
  ok("live health", h && h.healthy === true && typeof h.version === "string");

  const before = await c.sessions();
  const s = await c.createSession({ title: "vibebridge-smoke" });
  ok("live session create", s && typeof s.id === "string" && s.id.startsWith("ses_"));
  const after = await c.sessions();
  ok("live session listed", after.some((x) => x.id === s.id || (x.info && x.info.id === s.id)));

  // catalogs
  const pv = await c.providers();
  ok("live providers shape", pv && Array.isArray(pv.providers));
  const ag = await c.agents();
  ok("live agents shape", Array.isArray(ag) && ag.every((a) => typeof a.name === "string"));

  // permissions/questions lists must be arrays
  ok("live permissions list", Array.isArray(await c.permissions()));
  ok("live questions list", Array.isArray(await c.questions()));

  // SSE: expect server.connected within 5s
  const got = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    const stream = c.connectEvents({
      onEvent: (ev) => { if (ev.type === "server.connected" || ev.type === "server.heartbeat") { clearTimeout(t); resolve(true); } },
    });
    setTimeout(() => stream.stop(), 5100);
  });
  ok("live sse connects", got);

  ok("live session delete", (await c.deleteSession(s.id)) === true);
  const afterDel = await c.sessions();
  ok("live session gone", !afterDel.some((x) => (x.id || (x.info && x.info.id)) === s.id));
}
live().catch((e) => { console.log("FAIL  live block: " + e.message); process.exitCode = 1; });
