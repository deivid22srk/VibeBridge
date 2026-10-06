// SPDX-License-Identifier: GPL-3.0-or-later
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai", "meta.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

function render(s) {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const list = s.servers || [];
  const isOc = s.mode === "opencode";
  document.body.classList.toggle("mode-opencode", isOc);
  document.getElementById("executor").value = isOc ? "opencode" : "vscode";
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const studioOff = mcpOk && s.studio === false; // MCP up but no Studio attached
  const ok = mcpOk && !studioOff;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.textContent = isOc
    ? (s.connected
        ? "Connected · OpenCode ready"
        : `OpenCode offline${s.ocError ? " · " + s.ocError : ""}`)
    : (s.connected
        ? (ok ? "Connected · VSCode ready"
            : studioOff ? "VSCode not connected · start its MCP server (Cmd+Shift+P)"
            : "Bridge OK · open VSCode")
        : "Bridge offline");
  tools.textContent = s.connected ? `${s.tools || 0} tools available` : (isOc ? "Start the OpenCode server" : "Run bridge.py");
  servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
document.getElementById("restart").addEventListener("click", (e) => {
  e.target.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    e.target.textContent = "⟳ Restart VSCode server";
    setTimeout(refresh, 600);
  });
});
document.getElementById("settings").addEventListener("click", () => {
  // Tries the in-page panel on an already-open supported AI tab first, so
  // opening it doesn't require a conversation to already be started there.
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    if (anySupported) {
      chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
      chrome.tabs.update(anySupported.id, { active: true });
    } else {
      chrome.tabs.create({ url: DEFAULT_AI_URL });
    }
  });
});

// OpenCode provider: opens the dedicated control panel (extension page) that
// talks straight to a running `opencode serve` instance. No bridge needed.
document.getElementById("opencode").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("opencode.html") });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "zs-status") render(msg);
});

// ── Agent backend settings (site-driven mode) ─────────────────────────────
// Persisted in chrome.storage.local; the background worker refreshes its cache
// via storage.onChanged, and the content scripts key their prompt/feedback off
// the zs-status `mode` the worker broadcasts. Saving takes effect immediately,
// no reload needed (the NEXT command/prompt uses the new backend).
const execSel = document.getElementById("executor");
const ocUrl = document.getElementById("ocUrl");
const ocPass = document.getElementById("ocPass");

chrome.storage.local.get(["zsToolExecutor", "zsOpenCodeUrl", "zsOpenCodePassword"], (r) => {
  execSel.value = r && r.zsToolExecutor === "opencode" ? "opencode" : "vscode";
  document.body.classList.toggle("mode-opencode", execSel.value === "opencode");
  ocUrl.value = (r && r.zsOpenCodeUrl) || "http://127.0.0.1:4096";
  ocPass.value = (r && r.zsOpenCodePassword) || "";
});

function saveExecutor() {
  const mode = execSel.value === "opencode" ? "opencode" : "vscode";
  document.body.classList.toggle("mode-opencode", mode === "opencode");
  chrome.storage.local.set({
    zsToolExecutor: mode,
    zsOpenCodeUrl: ocUrl.value.trim() || "http://127.0.0.1:4096",
    zsOpenCodePassword: ocPass.value,
  });
}
execSel.addEventListener("change", saveExecutor);
ocUrl.addEventListener("change", saveExecutor);
ocPass.addEventListener("change", saveExecutor);

refresh();
setInterval(refresh, 2000);
