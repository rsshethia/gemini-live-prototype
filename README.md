# Gemini Live interview prototype

Local voice harness: **the AI leads the conversation, you answer by voice**, and the
full transcript builds live on the right and saves as `.txt`.

> New here? Open **`study-guide.html`** in Chrome and print it to PDF —
> a 3-page A4 visual guide (system diagram → repo mindmap → build ideas).

## Setup

```bash
cd gemini-live-prototype
npm install
cp .env.example .env   # then put GEMINI_API_KEY=... inside (see below)
npm run dev
```

Open http://localhost:3000 in Chrome. Allow the microphone.

## Your `.env` file — the only config you need

All settings live in one file: `.env` (never committed to git — it's in `.gitignore`).
Start from the template:

```bash
cp .env.example .env
```

Then edit `.env` with these values:

| Variable         | Required | What it is / where to get it |
|-----------------|----------|------------------------------|
| `GEMINI_API_KEY` | **Yes** | Your key from **Google AI Studio** → https://aistudio.google.com → *Get API key*. Paste it after the `=`, no quotes, no spaces: `GEMINI_API_KEY=AIza...` |
| `LIVE_MODEL`     | No  | Defaults to `models/gemini-3.8-live`. Only change this if your key's console lists a different live model. Check what your key supports at `GET /api/models` (see below). |
| `VOICE`          | No  | Defaults to `Kore`. Options: `Puck`, `Charon`, `Fenrir`, `Aoede`. The post-diagnosis template overrides this with `Aoede`. |
| `PORT`           | No  | Defaults to `3000`. |

**Checklist after editing `.env`:**

1. The file is named exactly `.env` (not `.env.txt` — disable "hide extensions" on Windows to check).
2. `GEMINI_API_KEY=` has your full key pasted after it, with nothing else on the line.
3. Restart the server (`npm run dev`) after every `.env` change — values load at boot.
4. On boot you should see `Key loaded: yes (len ...)`. If it says `NO - set GEMINI_API_KEY in .env`, re-check steps 1–2.
5. Watch for the `Model check: OK` line. If it warns your model isn't in the live list, visit http://localhost:3000/api/models in your browser, pick a name from the `live` array, and set it as `LIVE_MODEL`.

> 🔒 **Keep your key private.** `.env` is git-ignored so it never leaves your machine.
> Never paste your key into chat, screenshots, issues, or code. If a key leaks,
> revoke it in AI Studio and generate a new one.

## Use

1. Pick a focus (General intake or the post-diagnosis support call).
2. Optionally edit the system instruction.
3. Press **Start talking**. The AI speaks first.
4. Answer by voice. Tick expected fields as they land.
5. Press **Save .txt** — downloads a file and keeps a server copy in `transcripts/`.

## If a call drops

- Read the **Diagnostics** card at the bottom of the left rail: every step is
  logged (`ws.open` → `setup.sent` → `setup.complete`).
- The same trail is uploaded to `logs/client.log` on the server on every
  error/stop, and the server prints each request with timing.
- **Copy diagnostics** puts the trail + environment (model, key length — never
  the key, close code/reason) on the clipboard for analysis.
- Common close codes: `1006` = handshake/network or instant reject (check model
  name + key); key-worded reasons = invalid/restricted key; `1011` = try
  `LIVE_MODEL=models/gemini-3.8-live` (current default).

## How it works

- `server.js` — Express static host + `/api/config` (key + model from `.env`),
  `/api/templates` (file-backed, future DB seam), `/api/transcripts` (server copy).
- `public/live-client.js` — Live API transport only: raw WebSocket, 16 kHz PCM
  mic capture via AudioWorklet, 24 kHz playback queue, input/output transcriptions.
- `public/app.js` — UI state, template selection, transcript store, `.txt` export.
- `public/pcm-processor.js` — AudioWorklet passthrough for mic frames.

Setup message requests `responseModalities: ["AUDIO"]` plus
`inputAudioTranscription` + `outputAudioTranscription`, so every turn has text.
An initial `clientContent` nudge makes the AI open the call.

## Future seams (not in v1)

- `/api/token` stub → mint ephemeral tokens server-side instead of shipping the key.
- Function calling in the setup message → auto-tick the field checklist.
- `POST /api/transcripts` already persists; add a list view later.
