# Gemini Live interview prototype

Local voice harness: the AI leads the conversation, you answer by voice, the
full transcript builds live on the right and saves as `.txt`.

## Setup

```bash
cd gemini-live-prototype
npm install
cp .env.example .env   # then put GEMINI_API_KEY=... inside
npm run dev
```

Open http://localhost:3000 in Chrome. Allow the microphone.

If your AI Studio console lists a newer live model than the default,
set it in `.env`:

```
LIVE_MODEL=models/gemini-3.1-flash-live-preview
```

Check `GET /api/models` for the model ids your key supports.

## Use

1. Pick a focus (General intake or the post-diagnosis support call).
2. Optionally edit the system instruction.
3. Press **Start talking**. The AI speaks first.
4. Answer by voice. Tick expected fields as they land.
5. Press **Save .txt** — downloads a file and keeps a server copy in `transcripts/`.

## If a call drops

- Read the **Diagnostics** card at the bottom of the left rail: every step is
  logged (`ws.open` → `setup.sent` → `setup.complete` → mic/audio counters).
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
