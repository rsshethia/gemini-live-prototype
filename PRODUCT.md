# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Node.js + Express backend serving static frontend, vanilla HTML/CSS/JS in `public/`. No build step. API key in local `.env`, never hardcoded. Delegated: plain static frontend chosen for lowest friction with Live API WebSocket audio.

## Users

Solo tester (you) running localhost to validate an AI-led voice interview before building further. Speaks into mic, watches live transcript.

## Product Purpose

Prove that Gemini Live API can hold a real-time voice conversation where the AI leads, follows pre-given context, and the full transcript is visible live and savable as `.txt`. Success = press Talk, AI opens, conversation flows, transcript appears line by line, Save downloads a file.

## Positioning

Thin local harness over the Live API, not a framework: raw WebSocket + PCM audio + transcription flags, with interview templates selectable per run.

## Operating Context

Runs on `http://localhost:3000` in Chrome with mic + speakers. Audio-only sessions (~15 min limit). Key from AI Studio in `.env`.

## Capabilities and Constraints

- Two selectable focuses (general intake, post-diagnosis support call), each with system instruction + opening line + expected fields. The support-call template is feelings-first intake only: no medical advice, no prognosis, patient sets the pace.
- Voice in / voice out, live side transcript (input + output transcriptions), manual field checklist, `.txt` download + server copy in `transcripts/`.
- Undecided: auto field extraction via function calling (future), ephemeral tokens for sharing (future, stubbed as `/api/token`).
- Constraint: localhost only for v1; API key is served to browser on loopback. Not for production sharing.

## Brand Commitments

None. Clean, neutral lab tool.

## Evidence on Hand

Gemini Live API docs (Oct 2026): WebSocket endpoint, `setup` with `responseModalities: ["AUDIO"]`, `input_audio_transcription` + `output_audio_transcription`, PCM 16kHz in / 24kHz out. No synthetic claims.

## Product Principles

1. Seamless first: one `npm run dev`, one button to talk.
2. Transcript is the record: every turn timestamped and savable.
3. Template-driven: context is chosen before Talk, never typed mid-call.
4. Extensible seams: transport, templates, and transcript store are separate modules.

## Accessibility & Inclusion

Desktop Chrome + keyboard-operable Start/Stop/Save, visible focus, live region for transcript, status text not color-only.
