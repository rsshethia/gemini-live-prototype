import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname);
const PUBLIC = path.join(__dirname, "public");
const TRANSCRIPTS = path.join(__dirname, "transcripts");
const LOGS = path.join(__dirname, "logs");

const PORT = Number(process.env.PORT || 3000);
const LIVE_MODEL = process.env.LIVE_MODEL || "models/gemini-3.8-live";
const VOICE = process.env.VOICE || "Kore";
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 10);

const app = express();
app.use(express.json({ limit: "2mb" }));

function ts() { return new Date().toISOString(); }

// Request log: method, path, status, ms. Never logs the API key.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    console.log(`[${ts()}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

// Serve frontend
app.use(express.static(PUBLIC));

// Config for the browser client. Localhost prototype: key is served to the
// page so it can open a direct WebSocket to Google (lowest latency, simplest).
// Future: replace `apiKey` with a short-lived ephemeral token minted here.
app.get("/api/config", (_req, res) => {
  res.json({
    hasKey: HAS_KEY,
    model: LIVE_MODEL,
    voice: VOICE,
    apiKey: process.env.GEMINI_API_KEY || "",
    wsUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  });
});

// Interview templates (selectable before Talk). File-backed so v2 can use a DB.
app.get("/api/templates", (_req, res) => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, "server", "templates.json"), "utf-8");
    res.type("application/json").send(raw);
  } catch (err) {
    res.status(500).json({ error: "templates.json missing", detail: String(err) });
  }
});

// Save a server-side copy of the transcript (frontend download is primary).
app.post("/api/transcripts", (req, res) => {
  try {
    const { filename, content } = req.body || {};
    if (typeof content !== "string" || content.length === 0) {
      return res.status(400).json({ error: "content is required" });
    }
    const safe = String(filename || `transcript-${Date.now()}.txt`).replace(/[^a-zA-Z0-9._-]/g, "_");
    fs.mkdirSync(TRANSCRIPTS, { recursive: true });
    fs.writeFileSync(path.join(TRANSCRIPTS, safe), content, "utf-8");
    res.json({ ok: true, file: safe });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Browser diagnostics: the page POSTs its session log here on error/stop so a
// failure can be analysed from `logs/client.log` without opening devtools.
app.post("/api/client-log", (req, res) => {
  try {
    const { lines, summary } = req.body || {};
    if (!Array.isArray(lines)) return res.status(400).json({ error: "lines[] is required" });
    fs.mkdirSync(LOGS, { recursive: true });
    const entry = [
      `\n===== ${ts()} =====`,
      `summary: ${JSON.stringify(summary || {})}`,
      ...lines.map((l) => String(l).replace(process.env.GEMINI_API_KEY || "NO_KEY_SET_EVER", "[key]")),
    ].join("\n") + "\n";
    fs.appendFileSync(path.join(LOGS, "client.log"), entry, "utf-8");
    console.log(`[${ts()}] client-log saved (${lines.length} lines)`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${ts()}] client-log failed: ${String(err)}`);
    res.status(500).json({ error: String(err) });
  }
});
// List models visible to this key (server-side, key never leaves .env).
// Used to pick a model id that supports bidiGenerateContent.
app.get("/api/models", async (_req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY || "";
    if (!key) return res.status(400).json({ error: "no key in .env" });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`);
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: "list failed", detail: body.slice(0, 500) });
    const data = JSON.parse(body);
    const models = (data.models || []).map((m) => ({
      name: m.name,
      displayName: m.displayName,
      methods: m.supportedGenerationMethods || [],
    }));
    const live = models.filter((m) => (m.methods || []).includes("bidiGenerateContent"));
    console.log(`[${ts()}] /api/models: ${models.length} visible, ${live.length} support bidiGenerateContent`);
    res.json({ live, all: models.map((m) => m.name) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/token", (_req, res) => {
  res.status(501).json({ error: "Ephemeral tokens not wired in v1. Using direct key on localhost." });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, hasKey: HAS_KEY, model: LIVE_MODEL }));

app.listen(PORT, () => {
  const key = process.env.GEMINI_API_KEY || "";
  console.log(`\n  Live interview prototype on http://localhost:${PORT}`);
  console.log(`  Model: ${LIVE_MODEL}   Key loaded: ${HAS_KEY ? `yes (len ${key.length})` : "NO - set GEMINI_API_KEY in .env"}`);
  console.log(`  Client session logs -> ${path.join(LOGS, "client.log")}`);
  // Self-check: confirm the configured model actually supports Live API for
  // this key, so a stale id fails here at boot instead of mid-call.
  if (HAS_KEY) {
    fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`models list -> ${r.status}`))))
      .then((data) => {
        const live = (data.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("bidiGenerateContent"))
          .map((m) => m.name);
        if (live.includes(LIVE_MODEL)) {
          console.log(`  Model check: OK — ${LIVE_MODEL} supports bidiGenerateContent (${live.length} live models visible)\n`);
        } else {
          console.warn(`  Model check: WARN — ${LIVE_MODEL} NOT in live list for this key.`);
          console.warn(`  Pick one of: ${live.join(", ")}\n`);
        }
      })
      .catch((err) => console.warn(`  Model check skipped: ${String(err).slice(0, 120)}\n`));
  } else {
    console.log("");
  }
});
