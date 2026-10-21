import { LiveVoiceSession } from "./live-client.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  templates: [],
  activeTemplate: null,
  session: null,
  entries: [], // { speaker: "you" | "ai" | "system", text, time: Date }
  pendingUser: "",
  pendingAI: "",
  startTime: null,
  timerId: null,
  checkedFields: new Set(),
  wrapUpArmed: false,
  endTimer: null,
  wrapDeadline: null,
  speaking: false,
  logs: [], // { t: string, level: string, msg: string }
};

function nowIso() { return new Date().toISOString(); }

// Diagnostic trail, rendered in the on-page log and uploaded to the server
// on error/stop. Never pass the API key into addLog.
function addLog(msg, level = "info") {
  state.logs.push({ t: nowIso(), level, msg: String(msg).slice(0, 500) });
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  renderLog();
}

function renderLog() {
  const box = $("#log-panel");
  if (!box) return;
  const frag = document.createElement("div");
  for (const l of state.logs.slice(-120)) {
    const div = document.createElement("div");
    div.className = `log-line ${l.level}`;
    const time = document.createElement("span");
    time.className = "log-t";
    time.textContent = l.t.slice(11, 19);
    const text = document.createElement("span");
    text.textContent = l.msg;
    div.append(time, text);
    frag.appendChild(div);
  }
  box.replaceChildren(frag);
  box.scrollTop = box.scrollHeight;
  const count = $("#log-count");
  if (count) count.textContent = `${state.logs.length} events`;
}

async function uploadLogs(reason) {
  try {
    const stats = state.session ? state.session.getStats() : {};
    await fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: {
          reason,
          url: location.href,
          userAgent: navigator.userAgent,
          secureContext: window.isSecureContext,
          hasAudioContext: ("AudioContext" in window),
          hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
          model: state.config?.model,
          voice: $("#voice-select")?.value,
          template: state.activeTemplate?.id,
          keyLen: (state.config?.apiKey || "").length, // length only, never the key
          entries: state.entries.length,
          ...stats,
        },
        lines: state.logs.map((l) => `[${l.t}] ${l.level} ${l.msg}`),
      }),
    });
    addLog(`diagnostics uploaded to server logs/client.log (${reason})`);
  } catch (err) {
    addLog(`diagnostics upload failed: ${String(err).slice(0, 120)}`, "err");
  }
}

async function copyDiagnostics() {
  const stats = state.session ? state.session.getStats() : {};
  const text = [
    `userAgent: ${navigator.userAgent}`,
    `secureContext: ${window.isSecureContext}`,
    `model: ${state.config?.model} | voice: ${$("#voice-select")?.value} | template: ${state.activeTemplate?.id}`,
    `keyLen: ${(state.config?.apiKey || "").length} (length only)`,
    `stats: ${JSON.stringify(stats)}`,
    `--- last ${Math.min(state.logs.length, 60)} log lines ---`,
    ...state.logs.slice(-60).map((l) => `[${l.t}] ${l.level} ${l.msg}`),
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    addLog("diagnostics copied to clipboard");
  } catch {
    showError("Clipboard blocked — select the log text manually.");
  }
}

init();

async function init() {
  setStatus("idle");
  try {
    const [cfg, tpl] = await Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/templates").then((r) => r.json()),
    ]);
    state.config = cfg;
    state.templates = Array.isArray(tpl) ? tpl : [];
    state.activeTemplate = state.templates[0] || null;
    renderConnection();
    renderTemplates();
    renderSystemPreview();
    addLog(`boot ok: hasKey=${!!cfg.hasKey} keyLen=${(cfg.apiKey || "").length} model=${cfg.model} secure=${window.isSecureContext} mic=${!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)}`);
  } catch (err) {
    addLog(`boot failed: could not reach local server (${String(err).slice(0, 120)})`, "err");
    showError("Could not reach the local server. Run `npm run dev` first.");
  }
  wireButtons();
}

function wireButtons() {
  $("#btn-talk").addEventListener("click", toggleTalk);
  $("#btn-wrap").addEventListener("click", wrapUp);
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = (e.key || "").toLowerCase();
    if (k === "t") { e.preventDefault(); void toggleTalk(); }
    else if (k === "w") { e.preventDefault(); if (state.session) wrapUp(); }
  });
  $("#btn-save").addEventListener("click", saveTranscript);
  $("#btn-clear").addEventListener("click", clearTranscript);
  $("#btn-diag").addEventListener("click", copyDiagnostics);
  $("#system-text").addEventListener("input", (e) => {
    if (state.activeTemplate) state.activeTemplate.systemInstruction = e.target.value;
  });
  $("#voice-select").addEventListener("change", (e) => {
    if (state.config) state.config.voice = e.target.value;
  });
}

function renderConnection() {
  const cfg = state.config || {};
  $("#key-state").textContent = cfg.hasKey ? "API key loaded from .env" : "API key missing — add GEMINI_API_KEY to .env";
  $("#key-state").classList.toggle("bad", !cfg.hasKey);
  $("#model-name").textContent = (cfg.model || "").replace("models/", "");
  if (cfg.voice) $("#voice-select").value = cfg.voice;
}

function renderTemplates() {
  const wrap = $("#template-list");
  wrap.innerHTML = "";
  for (const t of state.templates) {
    const label = document.createElement("label");
    label.className = "template" + (state.activeTemplate && state.activeTemplate.id === t.id ? " selected" : "");
    label.innerHTML = `
      <input type="radio" name="template" value="${t.id}" ${state.activeTemplate && state.activeTemplate.id === t.id ? "checked" : ""} />
      <span class="template-body">
        <span class="template-name">${escapeHtml(t.name)}</span>
        <span class="template-desc">${escapeHtml(t.description)}</span>
      </span>`;
    label.querySelector("input").addEventListener("change", () => {
      state.activeTemplate = t;
      state.checkedFields = new Set();
      if (t.voice && state.config) {
        state.config.voice = t.voice;
        const sel = $("#voice-select");
        if ([...sel.options].some((o) => o.value === t.voice)) sel.value = t.voice;
        addLog(`voice set to ${t.voice} (suggested by template)`);
      }
      renderTemplates();
      renderSystemPreview();
      pushSystemEntry(`Interview focus set to “${t.name}”. Press Start talking when ready.`);
    });
    wrap.appendChild(label);
  }
}

function renderSystemPreview() {
  const t = state.activeTemplate;
  if (!t) return;
  $("#system-text").value = t.systemInstruction || "";
  $("#opening-line").textContent = `AI opens with: “${t.openingLine}”`;
  const list = $("#field-list");
  list.innerHTML = "";
  (t.fields || []).forEach((f, i) => {
    const li = document.createElement("li");
    const id = `field-${t.id}-${i}`;
    li.innerHTML = `<input type="checkbox" id="${id}" /><label for="${id}">${escapeHtml(f)}</label>`;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.checkedFields.add(f); else state.checkedFields.delete(f);
      updateFieldProgress();
    });
    list.appendChild(li);
  });
  updateFieldProgress();
}

function updateFieldProgress() {
  const total = (state.activeTemplate?.fields || []).length;
  $("#field-progress").textContent = `${state.checkedFields.size}/${total} collected`;
}

// Conversational ending: nudge the AI to close gracefully, then end the
// call visually once the goodbye has finished playing.
function wrapUp() {
  if (!state.session || state.wrapUpArmed) return;
  const prompt = state.activeTemplate?.wrapPrompt || "Please wrap up now with a brief summary and a warm goodbye.";
  if (!state.session.sendWrapUp(prompt)) {
    showError("Could not send the wrap-up — the session is not ready.");
    return;
  }
  state.wrapUpArmed = true;
  const btn = $("#btn-wrap");
  btn.disabled = true;
  btn.textContent = "Wrapping up…";
  addLog("call.wrapup_armed");
  pushSystemEntry("Wrapping up — the AI will close the conversation, then the call ends.");
  // Safety net: never leave a wrap-up hanging longer than 45s.
  state.wrapDeadline = setTimeout(() => {
    if (state.wrapUpArmed) {
      addLog("call.wrapup_deadline_reached", "err");
      void finishWrappedCall();
    }
  }, 45000);
}

function scheduleWrappedEnd() {
  if (!state.wrapUpArmed || state.endTimer) return;
  state.endTimer = setTimeout(() => {
    state.endTimer = null;
    void finishWrappedCall();
  }, 3500);
}

async function finishWrappedCall() {
  if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
  if (state.speaking) { scheduleWrappedEnd(); return; } // goodbye still playing — wait
  if (state.wrapDeadline) { clearTimeout(state.wrapDeadline); state.wrapDeadline = null; }
  state.wrapUpArmed = false;
  await stopTalk(false, true);
}

async function toggleTalk() {
  if (state.session) { await stopTalk(); return; }
  await startTalk();
}

async function startTalk() {
  hideError();
  const cfg = state.config;
  if (!cfg || !cfg.hasKey) { showError("Add your GEMINI_API_KEY to .env and restart `npm run dev`."); return; }
  if (!state.activeTemplate) { showError("Pick an interview focus first."); return; }
  if (!("AudioContext" in window) || !navigator.mediaDevices) {
    showError("This browser cannot capture audio. Use Chrome on localhost.");
    return;
  }
  const btn = $("#btn-talk");
  btn.disabled = true;
  btn.querySelector("span").textContent = "Connecting…";

  state.session = new LiveVoiceSession({
    wsUrl: cfg.wsUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    voice: $("#voice-select").value || cfg.voice,
    systemInstruction: $("#system-text").value.trim() || state.activeTemplate.systemInstruction,
    trigger: `${state.activeTemplate.trigger} Your opening line is: \"${state.activeTemplate.openingLine}\"`,
    onEvent: handleSessionEvent,
  });

  pushSystemEntry(`Started “${state.activeTemplate.name}” with ${cfg.model.replace("models/", "")}. AI speaks first.`);
  state.startTime = new Date();
  state.wrapUpArmed = false;
  $("#system-text").disabled = true;
  $("#voice-select").disabled = true;
  const brief = $("#brief-details");
  if (brief) brief.open = false;
  if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
  if (state.wrapDeadline) { clearTimeout(state.wrapDeadline); state.wrapDeadline = null; }
  startTimer();
  addLog(`call.start template=${state.activeTemplate.id} model=${cfg.model} voice=${$("#voice-select").value || cfg.voice}`);
  await state.session.connect();
  btn.disabled = false;
  refreshTalkButton();
}

async function stopTalk(manual = true, wrapped = false) {
  if (state.session) {
    const stats = state.session.getStats();
    addLog(`call.stop manual=${manual} wrapped=${wrapped} sent=${stats.audioChunksSent} received=${stats.audioChunksReceived} msgs=${stats.messagesReceived}`);
    await state.session.disconnect(manual ? "user" : (wrapped ? "wrap-up" : "auto"));
    state.session = null;
  }
  if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
  if (state.wrapDeadline) { clearTimeout(state.wrapDeadline); state.wrapDeadline = null; }
  state.wrapUpArmed = false;
  state.speaking = false;
  document.body.dataset.speaking = "false";
  $("#system-text").disabled = false;
  $("#voice-select").disabled = false;
  const brief = $("#brief-details");
  if (brief) brief.open = true;
  setStatus("idle");
  stopTimer();
  refreshTalkButton();
  setInterim("", "");
  $("#mic-fill").style.transform = "scaleX(0)";
  $("#speak-dot").classList.remove("on");
  $("#speak-label").textContent = "Ready";
  const dur = state.startTime
    ? `${String(Math.floor((Date.now() - state.startTime.getTime()) / 60000)).padStart(2, "0")}:${String(Math.floor(((Date.now() - state.startTime.getTime()) / 1000) % 60)).padStart(2, "0")}`
    : "00:00";
  const turns = state.entries.filter((e) => e.speaker !== "system").length;
  const fields = `${state.checkedFields.size}/${(state.activeTemplate?.fields || []).length}`;
  pushSystemEntry(wrapped
    ? `Call ended gracefully after ${dur} — ${turns} turns, ${fields} items noted. Transcript saved with Save .txt if you need it.`
    : `Call ended. It ran ${dur} with ${turns} turns. Review the transcript and save it as .txt if useful.`);
  if (!manual) void uploadLogs(wrapped ? "wrap-up" : "auto-close");
  else void uploadLogs("manual-stop");
}

function handleSessionEvent(ev) {
  switch (ev.type) {
    case "status":
      if (ev.state === "live") { setStatus("live"); refreshTalkButton(); }
      else if (ev.state === "connecting") setStatus("connecting");
      else if (ev.state === "error") {
        showError(ev.message || "Connection error.");
        setStatus("error");
        addLog(`status.error: ${(ev.message || "").slice(0, 200)}`, "err");
        void uploadLogs("error");
      }
      else if (ev.state === "closed") {
        if (state.session) {
          const code = ev.code ?? "?";
          const reason = (ev.reason || "").slice(0, 200);
          const clean = code === 1000 || code === 1005;
          addLog(`ws.closed code=${code} reason=${reason || "(none)"}`, clean ? "info" : "err");
          state.session = null;
          setStatus(clean ? "idle" : "error");
          stopTimer();
          refreshTalkButton();
          if (!clean) {
            showError(`Connection closed (code ${code}${reason ? `: ${reason}` : ""}). ` +
              hintForClose(code, reason));
            pushSystemEntry(`Call dropped unexpectedly (code ${code}). The full trail is in Diagnostics below and server logs/client.log.`);
            void uploadLogs(`abnormal-close-${code}`);
          }
        }
      }
      break;
    case "log":
      addLog(ev.msg + (ev.data ? ` ${JSON.stringify(ev.data).slice(0, 200)}` : ""), ev.level || "info");
      break;
    case "userPartial":
      state.pendingUser = ev.text; renderInterim(); break;
    case "aiPartial":
      state.pendingAI = ev.text; renderInterim(); break;
    case "userFinal":
      pushEntry("you", ev.text); state.pendingUser = ""; renderInterim(); break;
    case "aiFinal":
      pushEntry("ai", ev.text); state.pendingAI = ""; renderInterim();
      if (state.wrapUpArmed) scheduleWrappedEnd();
      break;
    case "interrupted":
      state.pendingUser = ""; state.pendingAI = ""; renderInterim(); break;
    case "speaking":
      state.speaking = !!ev.active;
      document.body.dataset.speaking = String(!!ev.active);
      $("#speak-dot").classList.toggle("on", !!ev.active);
      $("#speak-label").textContent = ev.active ? "AI speaking" : "Listening";
      if (state.wrapUpArmed) {
        if (ev.active) {
          if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
        } else {
          scheduleWrappedEnd();
        }
      }
      break;
    case "level":
      $("#mic-fill").style.transform = `scaleX(${ev.value.toFixed(3)})`;
      paintEq(ev.value);
      break;
    default: break;
  }
}

// ---- transcript ----

function pushEntry(speaker, text) {
  state.entries.push({ speaker, text, time: new Date() });
  appendBubble(speaker, text, new Date());
  updateCount();
}

function pushSystemEntry(text) {
  state.entries.push({ speaker: "system", text, time: new Date() });
  appendBubble("system", text, new Date());
  updateCount();
}

function appendBubble(speaker, text, time) {
  $("#empty-state")?.remove();
  const feed = $("#feed");
  const div = document.createElement("div");
  div.className = `bubble ${speaker}`;
  div.innerHTML = `
    <div class="bubble-meta"><span class="who">${speaker === "ai" ? "AI" : speaker === "you" ? "You" : "Session"}</span><span class="when">${formatTime(time)}</span></div>
    <p></p>`;
  div.querySelector("p").textContent = text;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

function renderInterim() {
  setInterim(state.pendingUser, state.pendingAI);
}

function setInterim(user, ai) {
  const box = $("#interim");
  const has = (user && user.trim()) || (ai && ai.trim());
  box.hidden = !has;
  $("#interim-you").textContent = user && user.trim() ? user : "";
  $("#interim-you-wrap").hidden = !(user && user.trim());
  $("#interim-ai").textContent = ai && ai.trim() ? ai : "";
  $("#interim-ai-wrap").hidden = !(ai && ai.trim());
  if (has) { const feed = $("#feed"); feed.scrollTop = feed.scrollHeight; }
}

function clearTranscript() {
  if (state.entries.length > 0 && !confirm("Clear the transcript? Unsaved turns will be lost.")) return;
  state.entries = [];
  state.pendingUser = ""; state.pendingAI = "";
  setInterim("", "");
  $("#feed").innerHTML = `<div class="empty" id="empty-state"><p>No turns yet.</p><p class="empty-sub">Press Start talking, then answer by voice. The AI leads.</p></div>`;
  updateCount();
}

function buildTxt() {
  const t = state.activeTemplate;
  const lines = [
    "Live interview transcript",
    `Focus: ${t ? t.name : "-"}`,
    `Date: ${new Date().toLocaleString()}`,
    `Model: ${(state.config?.model || "").replace("models/", "")}`,
    `Fields: ${(t?.fields || []).join(" | ")}`,
    "---",
  ];
  for (const e of state.entries) {
    const who = e.speaker === "ai" ? "AI" : e.speaker === "you" ? "You" : "—";
    lines.push(`[${formatTime(e.time)}] ${who}: ${e.text}`);
  }
  return lines.join("\n");
}

async function saveTranscript() {
  if (state.entries.length === 0) { showError("Nothing to save yet — start a call first."); return; }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const filename = `transcript-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  const content = buildTxt();
  const blob = new Blob([content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  try {
    await fetch("/api/transcripts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, content }),
    });
  } catch { /* download is primary; server copy is best-effort */ }
}

// ---- chrome ----

function refreshTalkButton() {
  const btn = $("#btn-talk");
  const live = !!state.session;
  document.body.dataset.call = live ? "live" : "idle";
  btn.classList.toggle("stop", live);
  btn.querySelector("span").textContent = live ? "Stop" : "Start talking";
  btn.setAttribute("aria-pressed", String(live));
  const wrap = $("#btn-wrap");
  if (wrap && !state.wrapUpArmed) {
    wrap.disabled = !live;
    wrap.textContent = "Wrap up";
  }
}

function setStatus(s) {
  const pill = $("#status-pill");
  pill.dataset.state = s;
  pill.querySelector("span").textContent =
    s === "live" ? "Live" : s === "connecting" ? "Connecting…" : s === "error" ? "Error" : "Idle";
}

function startTimer() {
  stopTimer();
  const el = $("#timer");
  state.timerId = setInterval(() => {
    if (!state.startTime) return;
    const s = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
  if (!state.session) $("#timer").textContent = "00:00";
}

function updateCount() {
  const n = state.entries.filter((e) => e.speaker !== "system").length;
  $("#turn-count").textContent = `${n} turn${n === 1 ? "" : "s"}`;
  $("#btn-save").disabled = state.entries.length === 0;
}

let eqBars = null;
function paintEq(v) {
  if (!eqBars) eqBars = [...document.querySelectorAll(".eq i")];
  if (eqBars.length === 0) return;
  const weights = [1, 0.65, 0.85, 0.5, 0.75];
  eqBars.forEach((bar, i) => {
    const h = Math.max(0.12, Math.min(1, v * (weights[i % weights.length] || 1)));
    bar.style.transform = `scaleY(${h.toFixed(3)})`;
  });
}

function showError(msg) {
  const box = $("#error-bar");
  box.textContent = msg;
  box.hidden = false;
}

function hideError() { $("#error-bar").hidden = true; }

// Most likely causes per close code, so the next retry is guided.
function hintForClose(code, reason) {
  const r = (reason || "").toLowerCase();
  if (r.includes("not found for api version") || r.includes("not supported for bidigeneratecontent"))
    return "That model id does not exist for Live API on your key. GET /api/models lists the ones that do — the default is now gemini-3.8-live, or set LIVE_MODEL in .env.";
  if (code === 1006) return "No close frame arrived (network drop or rejected handshake). If this is instant, the model name or key is usually wrong — check Diagnostics.";
  if (code === 1008 || r.includes("key") || r.includes("api key") || r.includes("permission") || r.includes("denied"))
    return "This smells like a key problem (invalid, restricted, or billing off). Verify the key in AI Studio and .env.";
  if (code === 1011 || r.includes("model")) return "Server-side failure — often an unknown model id. Try LIVE_MODEL=models/gemini-2.0-flash-live-001 in .env.";
  return "See the Diagnostics log for the last server message before the drop.";
}

function formatTime(d) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
