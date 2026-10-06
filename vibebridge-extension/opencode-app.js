// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-app.js - UI controller for the VibeBridge × OpenCode panel
// (extension page opencode.html). Turns the panel into a full client for a
// running OpenCode server: sessions (create/list/resume/delete), streaming
// prompts, tool-call chips, permission/question dialogs, model/agent/commands,
// MCP status, abort and auto-reconnect. Everything OpenCode can do is driven
// from here through ZSOpenCodeApi (opencode-api.js).
//
// Unlike the in-page providers (providers/*.js), this panel does NOT use the
// VibeBridge agent loop: OpenCode executes its own tools in its own workspace,
// so the panel only sends prompts and renders what the server reports.
(() => {
  "use strict";

  const Api = ZSOpenCodeApi;
  const $ = (id) => document.getElementById(id);

  // ── state ───────────────────────────────────────────────────────────────
  const S = {
    client: null,
    stream: null,
    connected: false,
    connecting: false,
    version: "",
    sessions: [],
    current: null, // sessionID
    messages: [], // [{ info, parts }] for the current session
    busy: false,
    providers: [],
    agents: [],
    commands: [],
    model: null, // { providerID, modelID } | null
    agent: "", // "" = session default
    attachments: [], // { mime, filename, url(data:) }
    permissions: [], // pending Permission.Request (current session)
    questions: [], // pending Question.Request (current session)
    settings: {
      baseUrl: Api.DEFAULT_BASE_URL,
      directory: "",
      username: Api.DEFAULT_USERNAME,
      password: "",
    },
  };

  const els = {
    dot: $("oc-dot"), ver: $("oc-ver"),
    settings: $("oc-settings"), setUrl: $("oc-set-url"), setDir: $("oc-set-dir"),
    setUser: $("oc-set-user"), setPass: $("oc-set-pass"),
    banner: $("oc-banner"), messages: $("oc-messages"), alerts: $("oc-alerts"),
    sessions: $("oc-session-list"), mcp: $("oc-mcp"),
    model: $("oc-model"), agent: $("oc-agent"),
    input: $("oc-input"), send: $("oc-btn-send"), stop: $("oc-btn-stop"),
    attach: $("oc-btn-attach"), file: $("oc-file"), attachList: $("oc-attach-list"),
    cmd: $("oc-cmd"), cmdArgs: $("oc-cmd-args"), cmdRun: $("oc-btn-cmd"),
    toast: $("oc-toast"),
  };

  const log = (...a) => console.log("[oc-panel]", ...a);

  function extVersion() {
    try { return "ext v" + chrome.runtime.getManifest().version; } catch { return ""; }
  }

  // Session list items come back flat (Session.Info[]); some event payloads
  // wrap them. Normalize both shapes here.
  function sid(s) { return (s && (s.id || (s.info && s.info.id))) || ""; }

  // ── small utils ─────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function relTime(ts) {
    if (!ts) return "";
    const d = Date.now() - ts;
    if (d < 60e3) return "just now";
    if (d < 3600e3) return Math.floor(d / 60e3) + "m ago";
    if (d < 86400e3) return Math.floor(d / 3600e3) + "h ago";
    return new Date(ts).toLocaleDateString();
  }

  let toastTimer = null;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.style.borderColor = isError === false ? "var(--oc-green)" : "";
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 6000);
  }

  function banner(html, cls) {
    if (!html) {
      els.banner.className = "";
      els.banner.innerHTML = "";
      return;
    }
    els.banner.className = "show" + (cls ? " " + cls : "");
    els.banner.innerHTML = html;
  }

  function nearBottom() {
    return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 90;
  }
  function scrollBottom(force) {
    if (force || nearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function setDot(state) {
    els.dot.className = "oc-dot" + (state ? " " + state : "");
  }

  function storeSet(obj) {
    try { chrome.storage.local.set(obj); } catch (e) { log("storage.set failed", e); }
  }

  // ── settings ────────────────────────────────────────────────────────────
  function openSettings() {
    els.setUrl.value = S.settings.baseUrl;
    els.setDir.value = S.settings.directory;
    els.setUser.value = S.settings.username;
    els.setPass.value = S.settings.password;
    els.settings.classList.add("open");
  }

  async function saveSettings() {
    S.settings.baseUrl = Api.normalizeBaseUrl(els.setUrl.value);
    S.settings.directory = els.setDir.value.trim();
    S.settings.username = els.setUser.value.trim() || Api.DEFAULT_USERNAME;
    S.settings.password = els.setPass.value;
    storeSet({ oc_settings: S.settings });
    els.settings.classList.remove("open");

    // A non-local server needs an explicit host permission grant (MV3). The
    // localhost/127.0.0.1 origins are static host_permissions, everything else
    // is optional and requested on demand. NOTE: match patterns cannot carry a
    // port, so we grant scheme://host/* — that covers every port on the host.
    try {
      const u = new URL(S.settings.baseUrl);
      const isLocal = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname);
      if (!isLocal && chrome.permissions && chrome.permissions.request) {
        const granted = await chrome.permissions.request({ origins: [u.protocol + "//" + u.hostname + "/*"] });
        if (!granted) toast("Permission to reach " + u.origin + " was not granted — requests will likely fail.");
      }
    } catch (e) { log("permission check failed", e); }

    connect(true);
  }

  // ── connection ──────────────────────────────────────────────────────────
  async function connect(isReconnect) {
    if (S.connecting) return;
    S.connecting = true;
    if (S.stream) { S.stream.stop(); S.stream = null; }
    S.connected = false;
    setDot("");
    S.client = new Api.Client({
      baseUrl: S.settings.baseUrl,
      directory: S.settings.directory,
      username: S.settings.username,
      password: S.settings.password,
    });
    banner("Connecting to OpenCode at <b>" + esc(S.settings.baseUrl) + "</b>…");
    try {
      const h = await S.client.health();
      S.version = (h && h.version) || "";
      S.connected = true;
      banner(null);
      setDot("on");
      els.ver.textContent = (S.version ? "server " + S.version + " · " : "") + extVersion();
      log("connected", S.settings.baseUrl, S.version);
      await Promise.all([refreshSessions(), loadCatalogs(), refreshAlerts(), refreshMcp()]);
      // Restore the last open session if it still exists.
      const last = S.sessions.find((x) => sid(x) === S.current);
      if (last) openSession(S.current, { silent: true, force: true });
      else if (!S.current) renderMessages();
    } catch (e) {
      S.connected = false;
      setDot("");
      els.ver.textContent = extVersion();
      banner(
        "<b>OpenCode server offline at " + esc(S.settings.baseUrl) + "</b><br>" +
        esc(e.message || String(e)) +
        "<br>Start it with <code>opencode serve --port 4096</code> (on Termux, see the " +
        "opencode-termux README install command), then click ↻ Reconnect. " +
        "Check the URL and password under ⚙ Server.", "error");
      renderMessages();
    } finally {
      S.connecting = false;
    }
    if (S.stream) S.stream.stop();
    S.stream = S.client.connectEvents({
      onEvent: handleEvent,
      onOpen: onStreamOpen,
      onDown: onStreamDown,
    });
  }

  async function onStreamOpen() {
    const wasDown = !S.connected;
    S.connected = true;
    setDot("on");
    banner(null);
    if (wasDown) {
      log("stream re-opened — resyncing");
      await Promise.all([refreshSessions(), loadCatalogs(), refreshAlerts(), refreshMcp()]);
      if (S.current) await loadMessages(S.current);
    }
  }

  function onStreamDown() {
    // Only announce a LOSS we actually experienced (transition from connected).
    // Failed attempts while still offline keep the original instructions banner.
    if (!S.connected) return;
    S.connected = false;
    setDot("warn");
    banner("Connection lost — reconnecting to OpenCode…");
  }

  // ── catalogs (providers/models, agents, commands) ───────────────────────
  async function loadCatalogs() {
    try {
      const [pv, ag, cm] = await Promise.all([
        S.client.providers(), S.client.agents(), S.client.commands(),
      ]);
      S.providers = (pv && pv.providers) || [];
      S.agents = (Array.isArray(ag) ? ag : []).filter(
        (a) => a && a.mode !== "subagent" && !a.hidden);
      S.commands = Array.isArray(cm) ? cm : [];
    } catch (e) {
      log("catalog load failed", e);
      return;
    }
    renderModelSelect();
    renderAgentSelect();
    renderCommandSelect();
  }

  function renderModelSelect() {
    const sel = els.model;
    sel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "(session default model)";
    sel.appendChild(def);
    for (const p of S.providers) {
      const models = Object.keys((p && p.models) || {});
      if (!models.length) continue;
      const g = document.createElement("optgroup");
      g.label = p.name || p.id;
      for (const m of models) {
        const o = document.createElement("option");
        o.value = p.id + "|" + m;
        o.textContent = m;
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
    if (S.model) sel.value = S.model.providerID + "|" + S.model.modelID;
    if (sel.selectedIndex === -1) { sel.value = ""; S.model = null; }
  }

  function renderAgentSelect() {
    const sel = els.agent;
    sel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "(session default agent)";
    sel.appendChild(def);
    for (const a of S.agents) {
      const o = document.createElement("option");
      o.value = a.name;
      o.textContent = a.name + (a.description ? " — " + a.description.split("\n")[0].slice(0, 40) : "");
      sel.appendChild(o);
    }
    if (S.agent) sel.value = S.agent;
    if (sel.selectedIndex === -1) { sel.value = ""; S.agent = ""; }
  }

  function renderCommandSelect() {
    const sel = els.cmd;
    sel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = S.commands.length ? "(custom commands)" : "(no custom commands)";
    sel.appendChild(def);
    for (const c of S.commands) {
      const o = document.createElement("option");
      o.value = c.name;
      o.textContent = c.name + (c.description ? " — " + c.description.split("\n")[0].slice(0, 40) : "");
      sel.appendChild(o);
    }
  }

  async function refreshMcp() {
    try {
      const st = await S.client.mcpStatus();
      const lines = Object.entries(st || {}).map(([name, v]) => {
        const s = (v && v.status) || "unknown";
        const mark = s === "connected" ? "●" : s === "disabled" ? "○" : "△";
        return `${mark} ${name} — ${s}`;
      });
      els.mcp.textContent = lines.length ? "MCP:\n" + lines.join("\n") : "";
    } catch {
      els.mcp.textContent = "";
    }
  }

  // ── sessions ────────────────────────────────────────────────────────────
  async function refreshSessions() {
    if (!S.connected) return;
    try {
      const list = await S.client.sessions();
      S.sessions = (list || []).sort(
        (a, b) => ((b.time && (b.time.updated || b.time.created)) || 0) -
                  ((a.time && (a.time.updated || a.time.created)) || 0));
    } catch (e) {
      log("sessions refresh failed", e);
      return;
    }
    renderSessions();
  }

  function renderSessions() {
    els.sessions.innerHTML = "";
    if (!S.sessions.length) {
      els.sessions.innerHTML = '<div class="oc-empty" style="margin-top:20px;font-size:11.5px">No sessions yet.<br>Click <b>＋ New</b>.</div>';
      return;
    }
    for (const s of S.sessions) {
      const info = s.info || s;
      const div = document.createElement("div");
      div.className = "oc-session" + (info.id === S.current ? " active" : "");
      const when = relTime(info.time && (info.time.updated || info.time.created));
      const model = info.model ? `${info.model.providerID}/${info.model.id || info.model.modelID}` : "";
      div.innerHTML =
        `<div class="oc-s-title">${esc(info.title || "(untitled)")}</div>` +
        `<div class="oc-s-meta">${esc(when)}${model ? " · " + esc(model) : ""}</div>` +
        `<button class="oc-s-del" title="Delete session">✕</button>`;
      div.addEventListener("click", () => openSession(info.id));
      div.querySelector(".oc-s-del").addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (confirm("Delete session \"" + (info.title || info.id) + "\"?")) {
          S.client.deleteSession(info.id)
            .then(() => {
              if (S.current === info.id) { S.current = null; S.messages = []; renderMessages(); renderAlerts(); }
              refreshSessions();
            })
            .catch((e) => toast("Delete failed: " + e.message));
        }
      });
      els.sessions.appendChild(div);
    }
  }

  async function newSession() {
    if (!S.connected) { toast("Not connected to OpenCode.", true); return; }
    try {
      const body = {};
      if (S.model) body.model = { providerID: S.model.providerID, modelID: S.model.modelID };
      if (S.agent) body.agent = S.agent;
      const s = await S.client.createSession(body);
      await refreshSessions();
      openSession(s.id);
      els.input.focus();
    } catch (e) {
      toast("Could not create session: " + e.message, true);
    }
  }

  async function openSession(sessionID, opts) {
    if (S.current === sessionID && !opts?.force) return;
    S.current = sessionID;
    S.busy = false;
    S.permissions = [];
    S.questions = [];
    storeSet({ oc_last_session: sessionID });
    renderSessions();
    renderMessages();
    renderAlerts();
    updateComposer();
    await loadMessages(sessionID);
    if (!opts?.silent) scrollBottom(true);
    refreshAlerts();
  }

  async function loadMessages(sessionID) {
    if (!S.connected || !sessionID) return;
    if (S.loadingMessages) return; // one fetch in flight; races re-run later
    S.loadingMessages = true;
    try {
      const list = await S.client.messages(sessionID, 200);
      S.messages = (list || [])
        .filter((m) => m && m.info)
        .sort((a, b) => ((a.info.time && a.info.time.created) || 0) - ((b.info.time && b.info.time.created) || 0));
      if (S.current === sessionID) { renderMessages(); scrollBottom(true); }
    } catch (e) {
      log("messages load failed", e);
    } finally {
      S.loadingMessages = false;
    }
  }

  // ── message rendering ───────────────────────────────────────────────────
  function renderMessages() {
    els.messages.innerHTML = "";
    if (!S.connected && !S.messages.length) {
      els.messages.innerHTML =
        `<div class="oc-empty"><b>Not connected.</b><br><br>` +
        `Run <code>opencode serve --port 4096</code> on the machine with your project,<br>` +
        `set the URL under ⚙ Server and click <b>↻ Reconnect</b>.</div>`;
      return;
    }
    if (!S.current) {
      els.messages.innerHTML =
        `<div class="oc-empty">Create a new session (<b>＋ New</b>) or pick one on the left.<br>` +
        `The OpenCode agent works inside the project directory configured under ⚙ Server.</div>`;
      return;
    }
    for (const m of S.messages) els.messages.appendChild(renderMessage(m));
    updateComposer();
  }

  function renderMessage(m) {
    const div = document.createElement("div");
    div.className = "oc-msg " + (m.info.role === "user" ? "user" : "assistant");
    div.dataset.msg = m.info.id;
    const who = document.createElement("div");
    who.className = "oc-who";
    const modelTag = m.info.role === "assistant" && m.info.modelID
      ? ` · ${m.info.providerID || ""}/${m.info.modelID}` : "";
    who.textContent = m.info.role + modelTag;
    div.appendChild(who);
    const body = document.createElement("div");
    body.className = "oc-body";
    for (const part of m.parts || []) body.appendChild(renderPart(part));
    div.appendChild(body);
    return div;
  }

  function renderPart(part) {
    if (!part || !part.type) return document.createDocumentFragment();
    if (part.type === "text") {
      const el = document.createElement("div");
      el.className = "oc-text";
      el.dataset.part = part.id;
      el.textContent = part.text || "";
      if (!part.time || !part.time.end) {
        if (part.id && String(part.id).indexOf("prt_") === 0) {
          const c = document.createElement("span");
          c.className = "oc-cursor";
          el.appendChild(c);
        }
      }
      return el;
    }
    if (part.type === "reasoning") {
      const el = document.createElement("div");
      el.className = "oc-reasoning";
      el.dataset.part = part.id;
      el.textContent = part.text || "";
      return el;
    }
    if (part.type === "tool") return renderToolChip(part);
    if (part.type === "patch") {
      const el = document.createElement("div");
      el.className = "oc-patch";
      el.dataset.part = part.id;
      el.textContent = "⎘ files changed: " + (part.files || []).join(", ");
      return el;
    }
    if (part.type === "file") {
      const el = document.createElement("div");
      el.className = "oc-patch";
      el.dataset.part = part.id;
      el.textContent = "📎 " + (part.filename || part.url || "file");
      return el;
    }
    return document.createDocumentFragment(); // step-start/finish, agent, snapshot… hidden
  }

  function renderToolChip(part) {
    const frag = document.createDocumentFragment();
    const sum = Api.toolSummary(part);
    const chip = document.createElement("span");
    chip.className = "oc-chip";
    chip.dataset.part = part.id;
    chip.dataset.status = sum.status;
    const ico = document.createElement("span");
    if (sum.status === "running" || sum.status === "pending") ico.className = "oc-chip-spin";
    else ico.className = "oc-chip-ico";
    const label = document.createElement("span");
    label.className = "oc-chip-label";
    label.textContent = sum.label;
    chip.appendChild(ico);
    chip.appendChild(label);
    if (sum.detail) {
      const det = document.createElement("span");
      det.className = "oc-chip-detail";
      det.textContent = sum.detail;
      chip.appendChild(det);
    }
    const pre = document.createElement("div");
    pre.className = "oc-chip-pre";
    pre.dataset.pre = part.id;
    if (sum.input !== undefined || sum.output !== undefined) {
      const h = document.createElement("div");
      h.className = "oc-pre-h";
      h.textContent = sum.tool + " · " + sum.status;
      pre.appendChild(h);
      const body = document.createElement("div");
      if (sum.input !== undefined) {
        const inLabel = document.createElement("div");
        inLabel.className = "oc-pre-h";
        inLabel.textContent = "input";
        const inPre = document.createElement("div");
        try { inPre.textContent = JSON.stringify(sum.input, null, 2); } catch { inPre.textContent = String(sum.input); }
        pre.appendChild(inLabel);
        pre.appendChild(inPre);
      }
      if (sum.output !== undefined && sum.output !== null && sum.output !== "") {
        const outLabel = document.createElement("div");
        outLabel.className = "oc-pre-h";
        outLabel.textContent = sum.status === "error" ? "error" : "output";
        body.textContent = String(sum.output);
        pre.appendChild(outLabel);
        pre.appendChild(body);
      }
    }
    chip.addEventListener("click", () => pre.classList.toggle("show"));
    frag.appendChild(chip);
    frag.appendChild(pre);
    return frag;
  }

  // Incremental updates driven by SSE. Full re-render is too heavy during
  // streaming; we patch the affected message/part nodes in place.
  function messageNode(messageID, create) {
    let el = els.messages.querySelector(`[data-msg="${CSS.escape(messageID)}"]`);
    if (!el && create) {
      const m = S.messages.find((x) => x.info.id === messageID);
      if (!m) return null;
      el = renderMessage(m);
      els.messages.appendChild(el);
      scrollBottom();
    }
    return el;
  }

  function upsertPart(sessionID, part) {
    if (sessionID !== S.current || !part || !part.id) return;
    const m = S.messages.find((x) => x.info.id === part.messageID);
    if (!m) {
      // A part for a message we have not seen yet: pull history once.
      loadMessages(sessionID);
      return;
    }
    const idx = (m.parts || []).findIndex((p) => p.id === part.id);
    if (idx >= 0) m.parts[idx] = part;
    else if (!m.parts) m.parts = [part];
    else m.parts.push(part);

    const node = messageNode(part.messageID, true);
    if (!node) return;
    const body = node.querySelector(".oc-body");
    if (part.type === "tool") {
      // Tool parts render a chip + a detail block; patch them separately and
      // keep the expanded/collapsed state of the open detail block.
      const oldChip = body.querySelector(`[data-part="${CSS.escape(part.id)}"]`);
      const oldPre = body.querySelector(`[data-pre="${CSS.escape(part.id)}"]`);
      const wasOpen = !!(oldPre && oldPre.classList.contains("show"));
      const fresh = renderPart(part); // fragment: [chip, pre]
      const newChip = fresh.querySelector ? fresh.querySelector(`[data-part="${CSS.escape(part.id)}"]`) : null;
      const newPre = fresh.querySelector ? fresh.querySelector(`[data-pre="${CSS.escape(part.id)}"]`) : null;
      // renderPart returns a DocumentFragment; querySelector on a fragment
      // works while its children are still detached.
      if (oldChip && newChip) body.replaceChild(newChip, oldChip);
      else if (!oldChip) body.appendChild(newChip || document.createDocumentFragment());
      if (newPre) {
        if (wasOpen) newPre.classList.add("show");
        if (oldPre) body.replaceChild(newPre, oldPre);
        else body.appendChild(newPre);
      } else if (oldPre) {
        oldPre.remove();
      }
    } else {
      const existing = body.querySelector(`[data-part="${CSS.escape(part.id)}"]`);
      const fresh = renderPart(part);
      if (existing && fresh.nodeType === 1) body.replaceChild(fresh, existing);
      else if (!existing) {
        body.appendChild(fresh);
        scrollBottom();
      }
    }
  }

  function applyDelta(sessionID, d) {
    if (sessionID !== S.current || !d || !d.partID) return;
    if (d.field !== "text" && d.field !== "reasoning") return;
    const m = S.messages.find((x) => x.info.id === d.messageID);
    if (!m) { loadMessages(sessionID); return; }
    const part = (m.parts || []).find((p) => p.id === d.partID);
    if (!part) {
      // First delta before any part.updated raced us: create the shell part.
      const shell = { id: d.partID, messageID: d.messageID, sessionID: sessionID, type: d.field === "reasoning" ? "reasoning" : "text", text: "" };
      m.parts = m.parts || [];
      m.parts.push(shell);
      upsertPart(sessionID, shell);
      return;
    }
    part.text = (part.text || "") + d.delta;
    const node = messageNode(d.messageID, true);
    if (!node) return;
    const el = node.querySelector(`[data-part="${CSS.escape(d.partID)}"]`);
    if (el) {
      el.textContent = part.text;
      const c = document.createElement("span");
      c.className = "oc-cursor";
      el.appendChild(c);
      scrollBottom();
    }
  }

  // ── SSE event dispatch ──────────────────────────────────────────────────
  let sessionRefreshTimer = null;
  function scheduleSessionRefresh() {
    clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = setTimeout(refreshSessions, 350);
  }

  function handleEvent(env) {
    const type = env.type;
    const p = env.properties || {};
    switch (type) {
      case "message.part.updated":
        upsertPart(p.sessionID, p.part);
        break;
      case "message.part.delta":
        applyDelta(p.sessionID, p);
        break;
      case "message.updated":
        if (p.sessionID === S.current && p.info && p.info.role === "user" &&
            !S.messages.some((m) => m.info.id === p.info.id)) {
          loadMessages(S.current); // real user message landed: drop optimistic copy
        }
        break;
      case "session.status":
        if (p.sessionID === S.current) {
          S.busy = !!(p.status && p.status.type === "busy");
          if (p.status && p.status.type === "retry") {
            banner(`Provider retry (attempt ${p.status.attempt}): ${esc(p.status.message || "")}`);
          } else if (p.status && p.status.type === "idle") {
            banner(null);
            loadMessages(S.current);
          }
          updateComposer();
        }
        scheduleSessionRefresh();
        break;
      case "session.error": {
        if (p.sessionID && p.sessionID !== S.current) break;
        const err = p.error || {};
        const msg = (err.data && err.data.message) || err.message || JSON.stringify(err).slice(0, 200);
        if (err.name === "MessageAbortedError") banner("Execution stopped (abort).");
        else banner(`<b>${esc(err.name || "Error")}</b>: ${esc(msg)}`, "error");
        if (p.sessionID === S.current) loadMessages(S.current);
        break;
      }
      case "permission.asked":
        if (p.sessionID === S.current && !S.permissions.some((x) => x.id === p.id)) {
          S.permissions.push(p);
          renderAlerts();
        }
        break;
      case "permission.replied":
        S.permissions = S.permissions.filter((x) => x.id !== p.requestID);
        renderAlerts();
        break;
      case "question.asked":
        if (p.sessionID === S.current && !S.questions.some((x) => x.id === p.id)) {
          S.questions.push(p);
          renderAlerts();
        }
        break;
      case "question.replied":
      case "question.rejected":
        S.questions = S.questions.filter((x) => x.id !== p.requestID);
        renderAlerts();
        break;
      case "session.created":
      case "session.updated":
      case "session.deleted":
        scheduleSessionRefresh();
        break;
      case "mcp.tools.changed":
        refreshMcp();
        break;
      default:
        break; // server.connected/heartbeat, file.*, pty.*, todo… not needed
    }
  }

  // ── alerts: permissions + questions ─────────────────────────────────────
  async function refreshAlerts() {
    if (!S.connected || !S.current) { renderAlerts(); return; }
    try {
      const [perms, qs] = await Promise.all([S.client.permissions(), S.client.questions()]);
      S.permissions = (perms || []).filter((x) => x.sessionID === S.current);
      S.questions = (qs || []).filter((x) => x.sessionID === S.current);
    } catch (e) {
      log("alert reconcile failed", e);
    }
    renderAlerts();
  }

  function renderAlerts() {
    els.alerts.innerHTML = "";
    for (const req of S.permissions) els.alerts.appendChild(renderPermission(req));
    for (const req of S.questions) els.alerts.appendChild(renderQuestion(req));
    updateComposer();
  }

  function renderPermission(req) {
    const card = document.createElement("div");
    card.className = "oc-alert";
    const patterns = (req.patterns || []).join(", ");
    let meta = "";
    try { meta = JSON.stringify(req.metadata || {}, null, 1); } catch { meta = ""; }
    card.innerHTML =
      `<h3><span class="oc-dot warn"></span> Permission required: ${esc(req.permission)}</h3>` +
      `<div class="oc-alert-body">OpenCode asks permission for:<br><b>${esc(patterns || "(pattern not shown)")}</b></div>` +
      (meta && meta !== "{}" ? `<div class="oc-alert-meta">${esc(meta.slice(0, 600))}</div>` : "");
    const actions = document.createElement("div");
    actions.className = "oc-alert-actions";
    const mk = (label, reply, primary) => {
      const b = document.createElement("button");
      b.className = "oc-btn" + (primary ? " primary" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        S.client.permissionReply(req.id, reply)
          .then(() => { S.permissions = S.permissions.filter((x) => x.id !== req.id); renderAlerts(); })
          .catch((e) => toast("Permission reply failed: " + e.message, true));
      });
      return b;
    };
    actions.appendChild(mk("Allow once", "once", true));
    actions.appendChild(mk("Always allow", "always"));
    actions.appendChild(mk("Deny", "reject"));
    card.appendChild(actions);
    return card;
  }

  function renderQuestion(req) {
    const card = document.createElement("div");
    card.className = "oc-alert deny-ish";
    card.innerHTML = `<h3><span class="oc-dot warn"></span> OpenCode asks</h3>`;

    const answers = [];
    (req.questions || []).forEach((q, qi) => {
      const wrap = document.createElement("div");
      wrap.className = "oc-alert-body";
      wrap.style.marginTop = qi ? "10px" : "0";
      wrap.innerHTML = `<b>${esc(q.header || "Question")}</b><br>${esc(q.question)}`;
      const chosen = { labels: [] };
      answers.push(chosen);
      (q.options || []).forEach((opt, oi) => {
        const lab = document.createElement("label");
        lab.className = "oc-opt";
        const input = document.createElement("input");
        input.type = q.multiple ? "checkbox" : "radio";
        input.name = req.id + "-" + qi;
        input.value = String(oi);
        input.addEventListener("change", () => {
          const boxes = Array.from(wrap.querySelectorAll("input[type=checkbox]:checked, input[type=radio]:checked"));
          chosen.labels = boxes.map((b) => (q.options[Number(b.value)] || {}).label).filter(Boolean);
        });
        lab.appendChild(input);
        const span = document.createElement("span");
        span.innerHTML = `${esc(opt.label)} <small>— ${esc(opt.description || "")}</small>`;
        lab.appendChild(span);
        wrap.appendChild(lab);
      });
      if (q.custom !== false) {
        const custom = document.createElement("input");
        custom.type = "text";
        custom.placeholder = "Custom answer…";
        custom.addEventListener("input", () => {
          chosen.labels = custom.value.trim() ? [custom.value.trim()] : chosen.labels.filter((l) => !(q.options || []).some((o) => o.label === l));
        });
        wrap.appendChild(custom);
      }
      card.appendChild(wrap);
    });

    const actions = document.createElement("div");
    actions.className = "oc-alert-actions";
    const answer = document.createElement("button");
    answer.className = "oc-btn primary";
    answer.textContent = "Answer";
    answer.addEventListener("click", () => {
      const missing = answers.findIndex((a) => !a.labels || !a.labels.length);
      if (missing !== -1) { toast("Answer every question before submitting.", true); return; }
      S.client.questionReply(req.id, answers.map((a) => a.labels))
        .then(() => { S.questions = S.questions.filter((x) => x.id !== req.id); renderAlerts(); })
        .catch((e) => toast("Answer failed: " + e.message, true));
    });
    const reject = document.createElement("button");
    reject.className = "oc-btn";
    reject.textContent = "Dismiss";
    reject.addEventListener("click", () => {
      S.client.questionReject(req.id)
        .then(() => { S.questions = S.questions.filter((x) => x.id !== req.id); renderAlerts(); })
        .catch((e) => toast("Dismiss failed: " + e.message, true));
    });
    actions.appendChild(answer);
    actions.appendChild(reject);
    card.appendChild(actions);
    return card;
  }

  // ── composer ────────────────────────────────────────────────────────────
  function updateComposer() {
    const hasSession = !!S.current;
    els.input.disabled = !hasSession || S.busy;
    els.send.style.display = S.busy ? "none" : "";
    els.stop.style.display = S.busy ? "" : "none";
    els.send.disabled = !hasSession || S.busy;
    els.cmdRun.disabled = !hasSession || S.busy || !els.cmd.value;
  }

  function renderAttachments() {
    els.attachList.innerHTML = "";
    S.attachments.forEach((f, i) => {
      const chip = document.createElement("span");
      chip.className = "oc-attach-chip";
      chip.innerHTML = `📎 ${esc(f.filename || "file")} <button title="Remove">✕</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        S.attachments.splice(i, 1);
        renderAttachments();
      });
      els.attachList.appendChild(chip);
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(file);
    });
  }

  async function sendPrompt() {
    if (!S.connected) { toast("Not connected to OpenCode.", true); return; }
    if (!S.current) { toast("Create or open a session first.", true); return; }
    if (S.busy) return;
    const text = els.input.value;
    if (!text.trim() && !S.attachments.length) return;
    const body = Api.buildPromptBody(text, S.attachments, S.model, S.agent);
    try {
      // Optimistic user bubble; replaced by the real one when the server
      // publishes message.updated for it.
      const local = {
        info: { id: "local_" + Date.now(), role: "user", time: { created: Date.now() } },
        parts: [{ id: "local_part_" + Date.now(), type: "text", text: text }],
      };
      S.messages.push(local);
      const node = renderMessage(local);
      els.messages.appendChild(node);
      scrollBottom(true);
      await S.client.promptAsync(S.current, body);
      els.input.value = "";
      S.attachments = [];
      renderAttachments();
      autoGrow();
      updateComposer();
    } catch (e) {
      S.messages = S.messages.filter((m) => !String(m.info.id).startsWith("local_"));
      renderMessages();
      toast("Prompt failed: " + e.message, true);
      if (e.status === 0) banner("OpenCode seems offline — check the server and click ↻ Reconnect.", "error");
    }
  }

  function autoGrow() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 180) + "px";
  }

  async function stopRun() {
    if (!S.current) return;
    try {
      await S.client.abort(S.current);
      toast("Abort requested…", false);
    } catch (e) {
      toast("Abort failed: " + e.message, true);
    }
  }

  async function runCommand() {
    if (!S.current || !els.cmd.value) return;
    try {
      await S.client.runCommand(S.current, els.cmd.value, els.cmdArgs.value);
      els.cmdArgs.value = "";
    } catch (e) {
      toast("Command failed: " + e.message, true);
    }
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  els.send.addEventListener("click", sendPrompt);
  els.stop.addEventListener("click", stopRun);
  els.input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendPrompt(); }
  });
  els.input.addEventListener("input", autoGrow);
  els.attach.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", async () => {
    for (const f of Array.from(els.file.files || [])) {
      try {
        S.attachments.push({ mime: f.type || "application/octet-stream", filename: f.name, url: await readFileAsDataUrl(f) });
      } catch (e) {
        toast("Could not read " + f.name, true);
      }
    }
    els.file.value = "";
    renderAttachments();
  });
  els.cmd.addEventListener("change", updateComposer);
  els.cmdRun.addEventListener("click", runCommand);
  els.model.addEventListener("change", () => {
    const v = els.model.value;
    S.model = v ? (([providerID, modelID]) => ({ providerID, modelID }))(v.split("|")) : null;
    storeSet({ oc_model: S.model });
  });
  els.agent.addEventListener("change", () => {
    S.agent = els.agent.value;
    storeSet({ oc_agent: S.agent });
  });
  $("oc-btn-new").addEventListener("click", newSession);
  $("oc-btn-settings").addEventListener("click", openSettings);
  $("oc-btn-close").addEventListener("click", () => els.settings.classList.remove("open"));
  $("oc-btn-save").addEventListener("click", saveSettings);
  $("oc-btn-reconnect").addEventListener("click", () => connect(true));

  // ── boot ────────────────────────────────────────────────────────────────
  function boot() {
    els.ver.textContent = extVersion();
    try {
      chrome.storage.local.get(["oc_settings", "oc_last_session", "oc_model", "oc_agent"], (d) => {
        if (d.oc_settings) S.settings = Object.assign(S.settings, d.oc_settings);
        if (d.oc_last_session) S.current = d.oc_last_session;
        if (d.oc_model) S.model = d.oc_model;
        if (d.oc_agent) S.agent = d.oc_agent;
        connect();
      });
    } catch {
      connect();
    }
  }

  boot();
})();
