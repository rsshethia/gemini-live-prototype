// One-shot Live API probe: opens the same WebSocket + setup the browser uses
// and prints exactly what Google does. Run: `node scripts/probe-live.mjs`
// Reads GEMINI_API_KEY / LIVE_MODEL from .env. Never prints the key.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })
);
const key = env.GEMINI_API_KEY || "";
const model = env.LIVE_MODEL || "models/gemini-3.8-live";
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

if (!key) { console.error("No GEMINI_API_KEY in .env"); process.exit(2); }
console.log(`${at()} model=${model} keyLen=${key.length}`);

const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
const ws = new WebSocket(url);

const setup = {
  setup: {
    model,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
    },
    systemInstruction: { parts: [{ text: "Say hello in five words." }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
};

ws.onopen = () => {
  console.log(`${at()} ws.open`);
  ws.send(JSON.stringify(setup));
  console.log(`${at()} setup.sent (${JSON.stringify(setup).length} bytes)`);
};
ws.onmessage = async (ev) => {
  let s;
  const d = ev.data;
  if (typeof d === "string") s = d;
  else if (d && typeof d.text === "function") s = await d.text();
  else if (d instanceof ArrayBuffer) s = new TextDecoder().decode(d);
  else s = `<unknown frame type: ${Object.prototype.toString.call(d)}>`;
  console.log(`${at()} msg (${s.length} chars): ${s.slice(0, 600)}`);
  if (s.includes("setupComplete")) {
    console.log(`${at()} SESSION OK: setup confirmed`);
    try { ws.close(); } catch { /* noop */ }
    setTimeout(() => process.exit(0), 500);
  }
};
ws.onerror = () => console.log(`${at()} ws.error_event`);
ws.onclose = (ev) => {
  console.log(`${at()} ws.close code=${ev.code} reason=${ev.reason || "(none)"} wasClean=${ev.wasClean}`);
  process.exit(0);
};

setTimeout(() => {
  console.log(`${at()} TIMEOUT: no setupComplete in 15s (readyState=${ws.readyState})`);
  try { ws.close(); } catch { /* noop */ }
  setTimeout(() => process.exit(3), 1500);
}, 15000).unref?.();
