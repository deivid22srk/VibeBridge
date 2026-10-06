// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-agent-tools.js - the OpenCode tool backend for the SITE-driven
// agent mode ("chat on DeepSeek etc., tools run on OpenCode"). PURE logic,
// zero chrome.* APIs: loaded by background.js via importScripts and by the
// node tests directly, so both exercise the exact same code.
//
// The catalogue below mirrors the tool schemas of the opencode-termux fork
// (packages/opencode/src/tool/{shell,read,write,edit,glob,grep}.ts) and is
// shaped like an MCP tool list ({name, description, inputSchema}) so the
// agentic loop's list_commands renderer works unchanged.
//
// Execution goes to the fork's direct tool API (see the fork's CHANGES.md):
//   GET  /global/health   -> liveness
//   GET  /tool            -> server-side catalogue (informational)
//   POST /tool/:name      {"arguments": {...}} -> {title, output, metadata}
// The endpoint is opt-in server-side (OPENCODE_TOOL_API=1) and auto-approves
// permissions; this module maps every failure to the loop's result contract:
//   {ok:true, text, title} | {ok:false, kind:"disconnected"|"timeout"|"error", error}
// eslint-disable-next-line no-unused-vars
const ZSOpenCodeTools = (() => {
  "use strict";

  const DEFAULT_BASE = "http://127.0.0.1:4096";
  const DEFAULT_TIMEOUT_MS = 120000;

  // ── Tool catalogue (mirrors the fork's tool schemas) ──────────────────────
  const TOOLS = [
    {
      name: "bash",
      description:
        "Run a shell command in the project directory and return its combined output. " +
        "Short-lived commands only (build, lint, tests, git status); never start servers or watchers.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          timeout: { type: "integer", description: "Optional timeout in milliseconds" },
          workdir: { type: "string", description: "Optional working directory RELATIVE to the project root - use this instead of 'cd'" },
        },
        required: ["command"],
      },
    },
    {
      name: "read",
      description:
        "Read a file (or directory listing) with line numbers. Page through big files with offset/limit instead of reading everything.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file, relative to the project root (absolute paths inside the project also work)" },
          offset: { type: "integer", description: "1-indexed line number to start reading from" },
          limit: { type: "integer", description: "Maximum number of lines to read (default 2000)" },
        },
        required: ["filePath"],
      },
    },
    {
      name: "write",
      description:
        "Create or OVERWRITE a file with the full content. It rewrites the whole file - there is no partial write; use edit for small changes.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file, relative to the project root" },
          content: { type: "string", description: "The complete new file content" },
        },
        required: ["filePath", "content"],
      },
    },
    {
      name: "edit",
      description:
        "Replace an exact string in a file with a new string (surgical change). oldString must match EXACTLY one location unless replaceAll is true - read the file first.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file, relative to the project root" },
          oldString: { type: "string", description: "The exact text to replace (must appear verbatim in the file)" },
          newString: { type: "string", description: "The replacement text (must differ from oldString)" },
          replaceAll: { type: "boolean", description: "Replace every occurrence (default false)" },
        },
        required: ["filePath", "oldString", "newString"],
      },
    },
    {
      name: "glob",
      description: "Find files by glob pattern, e.g. '**/*.py' or 'src/*.{ts,tsx}'.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern relative to the project root" },
          path: { type: "string", description: "Optional directory to search in (relative to the project root)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description:
        "Search file CONTENTS with a regex (ripgrep-backed). Escape dots/brackets you mean literally; use include to limit file types.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The regex pattern to search for" },
          path: { type: "string", description: "Optional file or directory to search in" },
          include: { type: "string", description: 'Optional file pattern filter, e.g. "*.js"' },
        },
        required: ["pattern"],
      },
    },
  ];

  function catalog() {
    return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  // ── URL / auth helpers ─────────────────────────────────────────────────────
  function normalizeBase(url) {
    let base = (url || "").trim() || DEFAULT_BASE;
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return base.replace(/\/+$/, "");
  }

  function basicAuthHeader(username, password) {
    // OpenCode server password mode: `Authorization: Basic user:pass`, where the
    // user is "opencode" unless OPENCODE_SERVER_USERNAME was set server-side.
    const raw = `${username || "opencode"}:${password || ""}`;
    return "Basic " + btoa(raw);
  }

  function headers(password, username) {
    const h = { "content-type": "application/json" };
    if (password) h["authorization"] = basicAuthHeader(username, password);
    return h;
  }

  // Extract {_tag, message} (NamedError.toObject) or {name/message/data} error bodies.
  function errorMessage(body, fallback) {
    if (body && typeof body === "object") {
      if (typeof body.message === "string" && body.message) return body.message;
      if (body.data && typeof body.data.message === "string") return body.data.message;
    }
    return fallback;
  }

  function friendlyNetworkError(err) {
    const msg = String((err && err.message) || err);
    if (/abort/i.test(msg)) return "request timed out";
    if (/failed to fetch|networkerror|load failed/i.test(msg))
      return `cannot reach the OpenCode server - is it running? Start it with: OPENCODE_TOOL_API=1 opencode serve --port 4096`;
    return msg;
  }

  // ── Health probe ───────────────────────────────────────────────────────────
  async function probe(base, opts = {}) {
    const impl = opts.fetchImpl || fetch;
    try {
      const r = await impl(`${normalizeBase(base)}/global/health`, {
        method: "GET",
        headers: headers(opts.password, opts.username),
        signal: AbortSignal.timeout(opts.probeTimeoutMs || 6000),
      });
      if (!r.ok) return { ok: false, error: `health check failed with HTTP ${r.status}` };
      const body = await r.json().catch(() => ({}));
      return { ok: true, version: body && body.version };
    } catch (err) {
      return { ok: false, error: friendlyNetworkError(err) };
    }
  }

  // ── Tool execution ─────────────────────────────────────────────────────────
  async function exec(name, args, opts = {}) {
    const impl = opts.fetchImpl || fetch;
    const base = normalizeBase(opts.base);
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    try {
      const r = await impl(`${base}/tool/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: headers(opts.password, opts.username),
        body: JSON.stringify({ arguments: args || {} }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        return { ok: true, text: typeof body.output === "string" ? body.output : "", title: body.title || "" };
      }
      const body = await r.json().catch(() => null);
      if (r.status === 403) {
        return {
          ok: false,
          kind: "error",
          error:
            (errorMessage(body, "the OpenCode server refused the tool API") || "") +
            " - start the server with OPENCODE_TOOL_API=1 to enable it",
        };
      }
      if (r.status === 404) {
        return { ok: false, kind: "error", error: errorMessage(body, `unknown tool "${name}"`) };
      }
      return { ok: false, kind: "error", error: errorMessage(body, `HTTP ${r.status}`) };
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/abort|timed out/i.test(msg)) return { ok: false, kind: "timeout", error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      return { ok: false, kind: "disconnected", error: friendlyNetworkError(err) };
    }
  }

  return {
    DEFAULT_BASE,
    DEFAULT_TIMEOUT_MS,
    catalog,
    normalizeBase,
    basicAuthHeader,
    probe,
    exec,
  };
})();

// Node test harness support (background.js consumes the global via importScripts).
if (typeof module !== "undefined" && module.exports) module.exports = ZSOpenCodeTools;
