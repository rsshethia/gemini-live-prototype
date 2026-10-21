// Transport for the Gemini Live API over a raw WebSocket.
// Owns: socket lifecycle, mic capture (16kHz PCM), speaker playback (24kHz PCM),
// partial + final transcriptions. UI rendering lives in app.js.
//
// Every notable step emits { type: "log", level, msg } so the page can show
// and persist a diagnostic trail. Nothing sensitive is logged (no API key,
// no raw audio).

export class LiveVoiceSession {
  constructor({ wsUrl, apiKey, model, voice, systemInstruction, trigger, onEvent }) {
    this.wsUrl = wsUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.systemInstruction = systemInstruction;
    this.trigger = trigger;
    this.onEvent = onEvent || (() => {});
    this.ws = null;
    this.micStream = null;
    this.inCtx = null;
    this.workletNode = null;
    this.outCtx = null;
    this.outQueueTime = 0;
    this.activeSources = new Set();
    this.pendingUser = "";
    this.pendingAI = "";
    this.ready = false;
    this.setupTimer = null;
    this.stats = { audioChunksSent: 0, audioChunksReceived: 0, messagesReceived: 0, firstAudioAt: null };
  }

  emit(type, data = {}) {
    try { this.onEvent({ type, ...data }); } catch { /* no-op */ }
  }

  log(msg, data) {
    this.emit("log", { level: "info", msg, ...(data ? { data } : {}) });
  }

  getStats() { return { ...this.stats }; }

  async connect() {
    if (this.ws) await this.disconnect();
    const host = this.wsUrl.replace(/^wss?:\/\//, "").split("/")[0];
    this.log("ws.connect", { host, model: this.model, voice: this.voice });
    this.emit("status", { state: "connecting" });

    let ws;
    try {
      ws = new WebSocket(`${this.wsUrl}?key=${encodeURIComponent(this.apiKey)}`);
    } catch (err) {
      this.log("ws.construct_failed", { error: String(err) });
      this.emit("status", { state: "error", message: `Could not open WebSocket: ${String(err)}` });
      return;
    }
    this.ws = ws;
    this.ws.binaryType = "arraybuffer";

    // If Google never confirms setup, the call would sit silent — fail loudly.
    this.setupTimer = setTimeout(() => {
      if (!this.ready) {
        const states = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
        this.log("setup.timeout_after_10s", {
          readyState: this.ws ? states[this.ws.readyState] : "no-socket",
          buffered: this.ws ? this.ws.bufferedAmount : -1,
          msgsReceived: this.stats.messagesReceived,
        });
        this.emit("status", {
          state: "error",
          message: "Google did not confirm the session within 10s (socket " +
            (this.ws ? states[this.ws.readyState] : "gone") + `, ${this.stats.messagesReceived} message(s) received). ` +
            "Check the diagnostics log (often a model name or key problem).",
        });
      }
    }, 10000);

    this.ws.onopen = () => {
      this.log("ws.open");
      const setup = {
        setup: {
          model: this.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
          },
          systemInstruction: { parts: [{ text: this.systemInstruction }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };
      this.log("setup.sent", { responseModalities: ["AUDIO"], transcriptions: "in+out" });
      this.ws.send(JSON.stringify(setup));
    };

    this.ws.onmessage = (ev) => { void this.handleMessage(ev.data); };
    this.ws.onerror = () => {
      // Browsers hide WS error detail; the close frame (code/reason) carries it.
      this.log("ws.error_event");
      this.emit("status", { state: "error", message: "WebSocket error — see the close line in the log for code/reason." });
    };
    this.ws.onclose = (ev) => {
      this.log("ws.close", { code: ev.code, reason: ev.reason || "(none)", wasClean: ev.wasClean });
      if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null; }
      this.emit("status", { state: "closed", code: ev.code, reason: ev.reason || "" });
      this.stopAudioGraph();
      this.stopPlayback();
    };
  }

  async disconnect(reason = "user") {
    if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null; }
    this.log("session.disconnect", { reason });
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch { /* noop */ }
        this.ws.close();
      }
    } catch { /* noop */ }
    this.ws = null;
    this.ready = false;
    this.stopAudioGraph();
    this.stopPlayback();
  }

  // Ask the model to close the conversation gracefully. Sent as clientContent
  // (interrupts any in-progress turn) with turnComplete so it replies at once.
  sendWrapUp(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) {
      this.log("wrapup.skipped_not_ready");
      return false;
    }
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }));
    this.log("wrapup.sent");
    return true;
  }

  // Google sends frames as binary (Blob/ArrayBuffer in the browser), not text —
  // decode first, then parse. This was the +10s-timeout bug: JSON.parse on a
  // non-string frame threw on every message, so setupComplete was never seen.
  async handleMessage(raw) {
    let text;
    try {
      if (typeof raw === "string") {
        text = raw;
      } else if (typeof Blob !== "undefined" && raw instanceof Blob) {
        text = await raw.text();
      } else if (raw instanceof ArrayBuffer) {
        text = new TextDecoder().decode(raw);
      } else if (raw && raw.buffer instanceof ArrayBuffer) {
        text = new TextDecoder().decode(raw);
      } else {
        this.log("msg.unparseable", { kind: Object.prototype.toString.call(raw) });
        return;
      }
    } catch (err) {
      this.log("msg.decode_failed", { error: String(err).slice(0, 120) });
      return;
    }
    let msg;
    try { msg = JSON.parse(text); } catch (err) {
      this.log("msg.unparseable", { error: String(err).slice(0, 120) });
      return;
    }
    this.stats.messagesReceived += 1;

    // Server-side error payload — the most useful line when a call "just stops".
    if (msg.error) {
      this.log("msg.server_error", { error: msg.error });
      this.emit("status", { state: "error", message: `Google error: ${JSON.stringify(msg.error).slice(0, 300)}` });
      return;
    }

    if (msg.setupComplete) {
      if (this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null; }
      this.ready = true;
      this.log("setup.complete");
      this.emit("status", { state: "live" });
      this.startMic();
      // AI leads: nudge it to speak its opening line.
      if (this.trigger) {
        this.ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: this.trigger }] }],
            turnComplete: true,
          },
        }));
        this.log("trigger.sent");
      }
      this.emit("ready");
      return;
    }

    const sc = msg.serverContent;
    if (!sc) {
      const keys = Object.keys(msg).join(",");
      if (msg.toolCall) {
        this.log("msg.toolcall_ignored", { keys });
      } else if (msg.goAway) {
        this.log("msg.goaway", { goAway: msg.goAway });
      } else {
        this.log("msg.unknown", { keys: keys.slice(0, 200) });
      }
      return;
    }

    if (sc.interrupted) {
      this.log("turn.interrupted");
      this.stopPlayback();
      this.flushPending("interrupted");
      this.emit("interrupted");
    }

    if (sc.inputTranscription && typeof sc.inputTranscription.text === "string" && sc.inputTranscription.text) {
      this.pendingUser += sc.inputTranscription.text;
      this.emit("userPartial", { text: this.pendingUser });
    }
    if (sc.outputTranscription && typeof sc.outputTranscription.text === "string" && sc.outputTranscription.text) {
      this.pendingAI += sc.outputTranscription.text;
      this.emit("aiPartial", { text: this.pendingAI });
    }

    if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
      for (const part of sc.modelTurn.parts) {
        if (part && part.inlineData && part.inlineData.data) {
          this.stats.audioChunksReceived += 1;
          if (!this.stats.firstAudioAt) {
            this.stats.firstAudioAt = new Date().toISOString();
            this.log("audio.first_chunk_received");
          }
          this.queueAudio(part.inlineData.data);
        } else if (part && part.text) {
          this.log("msg.model_text_part", { chars: part.text.length });
        }
      }
    }

    if (sc.turnComplete) {
      this.log("turn.complete", {
        userChars: this.pendingUser.length,
        aiChars: this.pendingAI.length,
      });
      this.flushPending("turn");
    }
  }

  flushPending(_reason) {
    if (this.pendingUser.trim()) this.emit("userFinal", { text: this.pendingUser.trim() });
    if (this.pendingAI.trim()) this.emit("aiFinal", { text: this.pendingAI.trim() });
    this.pendingUser = "";
    this.pendingAI = "";
  }

  async startMic() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this.log("mic.denied", { name: err && err.name, message: err && err.message });
      this.emit("status", { state: "error", message: `Microphone blocked (${(err && err.name) || "error"}). Allow mic access and retry.` });
      return;
    }
    this.micStream = stream;
    this.log("mic.stream_ok", { tracks: stream.getAudioTracks().map((t) => t.label || "mic").join(",").slice(0, 80) });
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.inCtx = new Ctx({ sampleRate: 16000, latencyHint: "interactive" });
      if (this.inCtx.state === "suspended") await this.inCtx.resume();
      this.log("mic.audioctx", { sampleRate: this.inCtx.sampleRate, state: this.inCtx.state });
      await this.inCtx.audioWorklet.addModule("pcm-processor.js");
      const src = this.inCtx.createMediaStreamSource(this.micStream);
      this.workletNode = new AudioWorkletNode(this.inCtx, "pcm-processor");
      // Keep the graph alive without feedback: route through a zero-gain node.
      const sink = this.inCtx.createGain();
      sink.gain.value = 0;
      src.connect(this.workletNode);
      this.workletNode.connect(sink);
      sink.connect(this.inCtx.destination);
      this.log("mic.capture_started");
    } catch (err) {
      this.log("mic.graph_failed", { error: String(err) });
      this.emit("status", { state: "error", message: `Audio capture failed: ${String(err).slice(0, 200)}` });
      return;
    }

    this.workletNode.port.onmessage = (ev) => {
      const samples = ev.data;
      if (!samples || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return;
      let sum = 0;
      for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
      this.emit("level", { value: Math.min(1, Math.sqrt(sum / (samples.length / 4)) * 3) });
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.ws.send(JSON.stringify({
        realtimeInput: { audio: { data: b64encode(new Uint8Array(pcm.buffer)), mimeType: "audio/pcm;rate=16000" } },
      }));
      this.stats.audioChunksSent += 1;
      if (this.stats.audioChunksSent === 1) this.log("audio.first_chunk_sent");
    };
  }

  stopAudioGraph() {
    try { this.workletNode && this.workletNode.disconnect(); } catch { /* noop */ }
    try { this.inCtx && this.inCtx.close(); } catch { /* noop */ }
    try { this.micStream && this.micStream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    this.workletNode = null; this.inCtx = null; this.micStream = null;
  }

  ensureOutCtx() {
    if (!this.outCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.outCtx = new Ctx({ sampleRate: 24000, latencyHint: "interactive" });
      this.outQueueTime = this.outCtx.currentTime;
      this.log("speaker.audioctx", { sampleRate: 24000 });
    }
    if (this.outCtx.state === "suspended") void this.outCtx.resume();
  }

  queueAudio(b64) {
    try {
      this.ensureOutCtx();
      const bytes = b64decode(b64);
      const ints = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const buf = this.outCtx.createBuffer(1, ints.length, 24000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ints.length; i++) ch[i] = ints[i] / 32768;
      const src = this.outCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.outCtx.destination);
      const startAt = Math.max(this.outQueueTime, this.outCtx.currentTime + 0.02);
      src.start(startAt);
      this.outQueueTime = startAt + buf.duration;
      this.activeSources.add(src);
      this.emit("speaking", { active: true });
      src.onended = () => {
        this.activeSources.delete(src);
        if (this.activeSources.size === 0) this.emit("speaking", { active: false });
      };
    } catch (err) {
      this.log("speaker.queue_failed", { error: String(err) });
    }
  }

  stopPlayback() {
    for (const src of this.activeSources) { try { src.stop(); } catch { /* noop */ } }
    this.activeSources.clear();
    if (this.outCtx) this.outQueueTime = this.outCtx.currentTime;
    this.emit("speaking", { active: false });
  }
}

function b64encode(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function b64decode(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
