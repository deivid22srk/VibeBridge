// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-api.js - HTTP + SSE client for an OpenCode server (from `opencode serve`).
// The OpenCode provider (popup -> opencode.html -> opencode-app.js) talks to a
// running OpenCode instance with this client: sessions, streaming prompts, tool
// calls, permission/question requests, models/agents/commands, MCP status.
//
// API surface used (validated against the OpenCode source, v1 routes):
//   GET  /global/health                        -> { healthy, version }
//   GET  /session?directory=...                -> Session.Info[]
//   POST /session                              -> Session.Info
//   DELETE /session/:id                        -> boolean
//   GET  /session/:id/message?limit=N          -> [{ info, parts }]
//   POST /session/:id/prompt_async             -> 204 (streams via /event)
//   POST /session/:id/abort                    -> boolean
//   POST /session/:id/command                  -> { info, parts }
//   GET  /config/providers                     -> { providers[], default }
//   GET  /agent | /command | /mcp | /permission | /question
//   POST /permission/:requestID/reply          { reply: "once"|"always"|"reject" }
//   POST /question/:requestID/reply            { answers: string[][] }
//   POST /question/:requestID/reject           -> boolean
//   GET  /event?directory=...                  -> SSE { id, type, properties }
//
// Auth: if OPENCODE_SERVER_PASSWORD is set on the server, every request needs
// `Authorization: Basic base64(user:pass)` (user defaults to "opencode"). We use
// fetch-streaming (NOT EventSource) so headers always work, even for SSE.
//
// This file must stay DOM-free so it can be unit-tested in Node (test-opencode-api.js).
// eslint-disable-next-line no-unused-vars
const ZSOpenCodeApi = (() => {
  "use strict";

  const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
  const DEFAULT_USERNAME = "opencode";
  const REQUEST_TIMEOUT = 15000;
  const SSE_MAX_BACKOFF = 15000;

  // ── pure helpers (exported for tests) ───────────────────────────────────

  // Accepts "127.0.0.1:4096", "http://host:4096/", "host" ... -> clean origin.
  function normalizeBaseUrl(url) {
    let u = String(url || "").trim() || DEFAULT_BASE_URL;
    if (!/^https?:\/\//i.test(u)) u = "http://" + u;
    return u.replace(/\/+$/, "");
  }

  // UTF-8-safe base64 (works in browser and Node >= 16, both expose btoa).
  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function basicAuthHeader(username, password) {
    return "Basic " + b64(`${username || DEFAULT_USERNAME}:${password || ""}`);
  }

  // Incremental SSE parser. Feed it decoded chunks as they arrive; it returns
  // the complete events found in the chunk. The OpenCode server sends
  // `event: message\ndata: <json>\n\n` frames (LF), but CRLF is tolerated.
  // The trailing `rest` is kept inside the parser for the next chunk.
  function createSseParser() {
    let buf = "";
    function parse(chunk) {
      buf += chunk.replace(/\r\n/g, "\n");
      const events = [];
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) events.push(ev);
      }
      return events;
    }
    function parseFrame(frame) {
      let event;
      const data = [];
      for (const line of frame.split("\n")) {
        if (!line || line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) return null;
      return { event: event || "message", data: data.join("\n") };
    }
    return { parse };
  }

  // Prompt body for POST /session/:id/prompt_async. `files` is an array of
  // {mime, filename, url} already read client-side (url may be a data: URL).
  function buildPromptBody(text, files, model, agent) {
    const parts = [];
    for (const f of files || []) {
      parts.push({ type: "file", mime: f.mime, filename: f.filename, url: f.url });
    }
    if (text && text.trim()) parts.push({ type: "text", text: text });
    const body = { parts: parts };
    if (model && model.providerID && model.modelID) {
      body.model = { providerID: model.providerID, modelID: model.modelID };
    }
    if (agent) body.agent = agent;
    return body;
  }

  // Short human summary of a tool call's input for the chip label.
  function inputSummary(input) {
    const inp = input || {};
    const val = inp.command || inp.filePath || inp.path || inp.pattern || inp.query || inp.url ||
      (typeof inp.content === "string" ? `(${inp.content.length} chars)` : undefined);
    if (typeof val === "string" && val) return val.split("\n")[0].slice(0, 80);
    if (val !== undefined) return String(val).slice(0, 80);
    const keys = Object.keys(inp);
    return keys.length ? keys.slice(0, 3).join(", ") : "";
  }

  // One-line plain-text preview for chip details (strips the read tool's
  // <path>/<line> XML markup and collapses whitespace so chips stay readable).
  function previewText(s, max) {
    const line = String(s == null ? "" : s).replace(/<[^>\n]+>/g, " ").replace(/\s+/g, " ").trim();
    return line.slice(0, max || 120);
  }

  // UI-facing summary of a tool part: { tool, status, label, detail, expanded }.
  function toolSummary(part) {
    const st = part.state || {};
    const tool = part.tool || "tool";
    const input = inputSummary(st.input);
    if (st.status === "pending") {
      return { tool, status: "pending", label: tool, detail: input };
    }
    if (st.status === "running") {
      return { tool, status: "running", label: st.title || tool, detail: input };
    }
    if (st.status === "error") {
      return { tool, status: "error", label: st.title || tool, detail: previewText(st.error, 160), input, output: st.error };
    }
    return { tool, status: "completed", label: st.title || tool, detail: previewText(st.output, 160), input, output: st.output };
  }

  // Best-effort human message from an OpenCode error response. Shapes seen:
  //  { name: "...", data: { message } } (v1 errors) | plain text | HTML.
  function describeErrorPayload(status, text, json) {
    const fromJson = json && (json.data?.message || json.message || json.error?.data?.message ||
      (typeof json.error === "string" ? json.error : null));
    if (fromJson) return String(fromJson);
    if (text && !/^\s*</.test(text)) return text.slice(0, 300);
    return `HTTP ${status || "?"}`;
  }

  // ── client ───────────────────────────────────────────────────────────────

  class Client {
    constructor(opts = {}) {
      this.baseUrl = normalizeBaseUrl(opts.baseUrl);
      this.username = opts.username || DEFAULT_USERNAME;
      this.password = opts.password || "";
      // Absolute project path on the machine running OpenCode (instance routing).
      this.directory = String(opts.directory || "").trim();
      this.timeout = opts.timeout || REQUEST_TIMEOUT;
    }

    _headers(extra) {
      const h = Object.assign({ "content-type": "application/json" }, extra || {});
      if (this.password) h["authorization"] = basicAuthHeader(this.username, this.password);
      return h;
    }

    _url(path, query) {
      const u = new URL(this.baseUrl + path);
      const q = Object.assign({}, query || {});
      if (this.directory) q.directory = this.directory;
      for (const [k, v] of Object.entries(q)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, v);
      }
      return u.toString();
    }

    // One JSON request with a hard timeout. Throws Error with .status on HTTP
    // errors and on timeout (status 0). Never hangs the caller.
    async request(path, opts = {}) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeout || this.timeout);
      try {
        const res = await fetch(this._url(path, opts.query), {
          method: opts.method || "GET",
          headers: this._headers(),
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: ctl.signal,
          credentials: "omit",
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!res.ok) {
          const err = new Error(describeErrorPayload(res.status, text, json));
          err.status = res.status;
          throw err;
        }
        return json;
      } catch (e) {
        if (e && e.name === "AbortError") {
          const err = new Error(`OpenCode did not answer in ${opts.timeout || this.timeout}ms`);
          err.status = 0;
          throw err;
        }
        if (e instanceof TypeError) {
          // fetch() network failure: server offline, refused connection, CORS...
          const err = new Error("OpenCode server unreachable (offline or wrong URL)");
          err.status = 0;
          err.cause = e;
          throw err;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }

    // ── global (no instance routing) ──
    health() { return this.request("/global/health", { query: {}, timeout: 6000 }); }

    // ── sessions ──
    sessions() { return this.request("/session"); }
    createSession(body) { return this.request("/session", { method: "POST", body: body || {} }); }
    deleteSession(sessionID) { return this.request(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" }); }
    messages(sessionID, limit) {
      return this.request(`/session/${encodeURIComponent(sessionID)}/message`, {
        query: limit ? { limit: String(limit) } : undefined,
        timeout: 30000,
      });
    }
    promptAsync(sessionID, body) {
      return this.request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, { method: "POST", body: body, timeout: 20000 });
    }
    abort(sessionID) { return this.request(`/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" }); }
    runCommand(sessionID, command, args) {
      return this.request(`/session/${encodeURIComponent(sessionID)}/command`, {
        method: "POST", body: { command: command, arguments: args || "" }, timeout: 60000,
      });
    }

    // ── catalogs ──
    providers() { return this.request("/config/providers"); }
    agents() { return this.request("/agent"); }
    commands() { return this.request("/command"); }
    mcpStatus() { return this.request("/mcp"); }

    // ── permissions & questions ──
    permissions() { return this.request("/permission"); }
    permissionReply(requestID, reply, message) {
      const body = { reply: reply };
      if (message) body.message = message;
      return this.request(`/permission/${encodeURIComponent(requestID)}/reply`, { method: "POST", body: body });
    }
    questions() { return this.request("/question"); }
    questionReply(requestID, answers) {
      return this.request(`/question/${encodeURIComponent(requestID)}/reply`, { method: "POST", body: { answers: answers } });
    }
    questionReject(requestID) {
      return this.request(`/question/${encodeURIComponent(requestID)}/reject`, { method: "POST" });
    }

    // ── SSE with automatic reconnect (exponential backoff, capped) ──
    // Returns { stop() }. Callbacks: onEvent(jsonEnvelope), onOpen(), onDown().
    // Missed events while down are healed by the caller: onOpen it refetches
    // the open session's messages and the pending permission/question lists.
    connectEvents(handlers) {
      const onEvent = handlers && handlers.onEvent;
      const onOpen = handlers && handlers.onOpen;
      const onDown = handlers && handlers.onDown;
      let stopped = false;
      let attempt = 0;
      let ctl = null;
      const self = this;

      async function loop() {
        while (!stopped) {
          ctl = new AbortController();
          try {
            const res = await fetch(self._url("/event"), {
              headers: self._headers({ accept: "text/event-stream" }),
              signal: ctl.signal,
              credentials: "omit",
            });
            if (!res.ok) {
              const err = new Error(`event stream failed (HTTP ${res.status})`);
              err.status = res.status;
              throw err;
            }
            attempt = 0;
            if (onOpen) { try { onOpen(); } catch {} }
            const parser = createSseParser();
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const text = dec.decode(chunk.value, { stream: true });
              for (const ev of parser.parse(text)) {
                let json = null;
                try { json = JSON.parse(ev.data); } catch { json = null; }
                if (!json) continue;
                if (onEvent) { try { onEvent(json); } catch (e) { console.error("[oc-api] event handler error", e); } }
                if (json.type === "server.instance.disposed") throw new Error("instance disposed");
              }
            }
          } catch (e) {
            if (stopped) break;
            console.log("[oc-api] stream dropped:", e && e.message);
          }
          ctl = null;
          if (stopped) break;
          if (onDown) { try { onDown(); } catch {} }
          const wait = Math.min(SSE_MAX_BACKOFF, 1000 * Math.pow(2, attempt++));
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      loop();
      return {
        stop() {
          stopped = true;
          try { if (ctl) ctl.abort(); } catch {}
        },
      };
    }
  }

  return {
    DEFAULT_BASE_URL,
    DEFAULT_USERNAME,
    Client,
    normalizeBaseUrl,
    basicAuthHeader,
    createSseParser,
    buildPromptBody,
    toolSummary,
    inputSummary,
    describeErrorPayload,
  };
})();
