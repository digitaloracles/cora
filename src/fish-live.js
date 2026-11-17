import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { encode, decode } from "@msgpack/msgpack";

const ASR_URL = "wss://api.fish.audio/v1/asr/realtime";
const TTS_URL = "wss://api.fish.audio/v1/tts/live";
const ASR_FILE_URL = "https://api.fish.audio/v1/asr";
const AUDIO_FILE_LIMIT = 25 * 1024 * 1024;
const FRAME_LIMIT = 1024 * 1024;
const RATES = new Set([8000, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

export class FishLiveError extends Error {
  constructor(message, { code = "fish_live_error", status = 0, requestId = "", recoverable = false } = {}) {
    super(message);
    this.name = "FishLiveError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.recoverable = recoverable;
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function contextItems(items = []) {
  if (!Array.isArray(items) || items.length > 32) throw new TypeError("Fish context requires at most 32 items");
  return items.map(({ role, text }) => {
    if (!["user", "assistant"].includes(role) || typeof text !== "string" || text.length > 2000) throw new TypeError("Invalid Fish context item");
    return { role, text };
  });
}

class FishSession extends EventEmitter {
  constructor({ key, url, model, start, kind, socketFactory, connectTimeoutMs, finishTimeoutMs, keepaliveMs, signal, maxBufferedBytes }) {
    super();
    this.kind = kind;
    this.state = "connecting";
    this.requestId = "";
    this.speaking = false;
    this.maxBufferedBytes = maxBufferedBytes;
    this.finishTimeoutMs = finishTimeoutMs;
    this._ready = deferred();
    this._done = deferred();
    this.ready = this._ready.promise;
    this.done = this._done.promise;
    this.signal = signal;
    this.abortListener = () => this.abort();
    if (signal?.aborted) {
      this.fail(new FishLiveError("Fish session cancelled", { code: "aborted" }));
      return;
    }
    signal?.addEventListener("abort", this.abortListener, { once: true });
    try {
      this.socket = socketFactory(url, { headers: { Authorization: `Bearer ${key}`, model }, maxPayload: FRAME_LIMIT, handshakeTimeout: connectTimeoutMs });
      this.timer = setTimeout(() => this.fail(new FishLiveError("Fish session start timed out", { code: "start_timeout" })), connectTimeoutMs);
      this.timer.unref?.();
      this.socket.on("unexpected-response", (_request, response) => {
        const status = Number(response.statusCode) || 0;
        response.resume();
        this.fail(new FishLiveError(`Fish WebSocket refused (${status})`, { code: "upgrade_refused", status }));
      });
      this.socket.on("error", () => this.fail(new FishLiveError("Fish WebSocket connection failed", { code: "connection_error" })));
      this.socket.on("open", () => {
        if (this.state !== "connecting") return;
        try {
          this.send(start, true);
          if (kind === "tts") this.started();
          if (kind === "stt") {
            this.keepalive = setInterval(() => {
              if (this.state !== "ready") return;
              try { this.send({ type: "keepalive" }); } catch (error) { this.fail(error); }
            }, keepaliveMs);
            this.keepalive.unref?.();
          }
        } catch (error) { this.fail(error); }
      });
      this.socket.on("message", (bytes, binary) => this.message(bytes, binary));
      this.socket.on("close", (code) => {
        if (["done", "failed"].includes(this.state)) return;
        this.fail(this.pendingFailure || new FishLiveError(`Fish session closed before completion (${Number(code) || 0})`, { code: "unexpected_close", requestId: this.requestId }));
      });
    } catch {
      this.fail(new FishLiveError("Fish WebSocket could not start", { code: "connection_error" }));
    }
  }

  started() {
    if (this.state !== "connecting") return;
    clearTimeout(this.timer);
    this.state = "ready";
    this._ready.resolve(this);
    this.emit("ready");
  }

  send(message, starting = false) {
    if ((!starting && this.state !== "ready") || this.socket?.readyState !== WebSocket.OPEN) throw new FishLiveError("Fish session is not writable", { code: "not_ready" });
    const bytes = encode(message);
    if (bytes.byteLength > FRAME_LIMIT) throw new FishLiveError("Fish message exceeds frame limit", { code: "frame_limit" });
    if (this.socket.bufferedAmount + bytes.byteLength > this.maxBufferedBytes) throw new FishLiveError("Fish audio transport is congested", { code: "backpressure" });
    this.socket.send(bytes, { binary: true }, (error) => {
      if (error) this.fail(new FishLiveError("Fish message could not be sent", { code: "send_error" }));
    });
  }

  message(bytes, binary) {
    if (["done", "failed"].includes(this.state)) return;
    try {
      if (!binary || bytes.byteLength > FRAME_LIMIT) throw new Error("Invalid Fish frame");
      const event = decode(bytes, { maxStrLength: FRAME_LIMIT, maxBinLength: FRAME_LIMIT, maxArrayLength: 65536, maxMapLength: 4096 });
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid Fish event");
      if (event.type === "error" || event.event === "error") {
        const error = new FishLiveError("Fish provider rejected the request", { code: typeof event.error_type === "string" && /^[a-z_]{1,80}$/.test(event.error_type) ? event.error_type : "provider_error", status: Number(event.code) || 0, requestId: this.requestId, recoverable: event.recoverable === true });
        if (this.kind === "stt" && this.state !== "connecting" && ["server_restarting", "max_duration_exceeded"].includes(error.code)) {
          this.pendingFailure = error;
          this.state = "draining";
          clearInterval(this.keepalive);
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.fail(error), Math.min(this.finishTimeoutMs, 5000));
          this.timer.unref?.();
          this.emit("providerError", error);
        } else if (error.recoverable) this.emit("providerError", error);
        else this.fail(error);
        return;
      }
      if (this.kind === "stt") {
        if (typeof event.type !== "string") throw new Error("Missing Fish event type");
        if (event.type === "session_started") {
          if (this.state !== "connecting") throw new Error("Duplicate Fish start");
          if (typeof event.request_id === "string" && /^[\w-]{1,200}$/.test(event.request_id)) this.requestId = event.request_id;
          this.started();
        } else if (this.state === "connecting") throw new Error("Fish event before session start");
        this.emit("event", event);
        this.emit(event.type, event);
        if (event.type === "session_done") {
          if (this.pendingFailure) this.fail(this.pendingFailure);
          else this.complete(event);
        }
      } else {
        if (event.event === "audio") {
          if (!(event.audio instanceof Uint8Array)) throw new Error("Invalid Fish audio bytes");
          this.emit("audio", Buffer.from(event.audio));
        } else if (event.event === "finish") {
          if (event.reason !== "stop") {
            this.fail(new FishLiveError("Fish speech synthesis failed", { code: "synthesis_error" }));
            return;
          }
          this.complete(event);
        }
        this.emit("event", event);
      }
    } catch {
      this.fail(new FishLiveError("Fish sent an invalid binary message", { code: "invalid_frame", requestId: this.requestId }));
    }
  }

  sendAudio(bytes) {
    if (this.kind !== "stt") throw new TypeError("Audio input requires STT");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Audio must be PCM bytes");
    if (!bytes.byteLength) return;
    this.send({ type: "audio", data: bytes });
  }

  setAgentSpeaking(speaking) {
    if (this.kind !== "stt" || typeof speaking !== "boolean") throw new TypeError("STT speaking must be boolean");
    if (this.speaking === speaking) return;
    this.send({ type: "agent_speaking", speaking });
    this.speaking = speaking;
  }

  addContext(items, { resetHistory = false } = {}) {
    if (this.kind !== "stt") throw new TypeError("Context requires STT");
    this.send({ type: "context_add", items: contextItems(items), reset_history: Boolean(resetHistory) });
  }

  finalize() {
    if (this.kind !== "stt") throw new TypeError("Finalize requires STT");
    this.send({ type: "finalize" });
  }

  sendText(text) {
    if (this.kind !== "tts" || typeof text !== "string") throw new TypeError("TTS text must be a string");
    if (text) this.send({ event: "text", text });
  }

  flush() {
    if (this.kind !== "tts") throw new TypeError("Flush requires TTS");
    this.send({ event: "flush" });
  }

  end() {
    if (["ending", "draining", "done", "failed"].includes(this.state)) return this.done;
    this.send(this.kind === "stt" ? { type: "audio_done" } : { event: "stop" });
    this.state = "ending";
    clearInterval(this.keepalive);
    this.timer = setTimeout(() => this.fail(new FishLiveError("Fish session did not finish", { code: "finish_timeout" })), this.finishTimeoutMs);
    this.timer.unref?.();
    return this.done;
  }

  complete(event) {
    if (["done", "failed"].includes(this.state)) return;
    this.state = "done";
    this.cleanup();
    this._done.resolve(event);
    this.socket.close(1000);
    this.emit("finish", event);
  }

  fail(error) {
    if (["done", "failed"].includes(this.state)) return;
    this.state = "failed";
    this.cleanup();
    this._ready.reject(error);
    this._done.reject(error);
    this.socket?.terminate();
    this.emit("failure", error);
    if (this.listenerCount("error")) this.emit("error", error);
  }

  abort() { this.fail(new FishLiveError("Fish session cancelled", { code: "aborted" })); }
  close() { this.abort(); }

  cleanup() {
    clearTimeout(this.timer);
    clearInterval(this.keepalive);
    this.signal?.removeEventListener("abort", this.abortListener);
  }
}

export class FishLive {
  constructor({ key = "", sttUrl = ASR_URL, ttsUrl = TTS_URL, asrFileUrl = ASR_FILE_URL, ttsModel = "s2.1-pro", asrFileModel = "transcribe-1-pro", socketFactory = (url, options) => new WebSocket(url, options), connectTimeoutMs = 15000, finishTimeoutMs = 30000, keepaliveMs = 10000, maxBufferedBytes = FRAME_LIMIT * 2, fileTimeoutMs = 120000 } = {}) {
    Object.assign(this, { key, sttUrl, ttsUrl, asrFileUrl, ttsModel, asrFileModel, socketFactory, connectTimeoutMs, finishTimeoutMs, keepaliveMs, maxBufferedBytes, fileTimeoutMs });
  }

  get enabled() { return Boolean(this.key); }
  setKey(key) { this.key = String(key || ""); }

  openStt({ sampleRate = 48000, history = [], terms = [], reference = "", signal } = {}) {
    if (!RATES.has(sampleRate)) throw new TypeError("Unsupported Fish PCM sample rate");
    if (!Array.isArray(terms) || terms.length > 100 || terms.some((term) => typeof term !== "string" || term.length > 32)) throw new TypeError("Invalid Fish recognition terms");
    return this.open("stt", this.sttUrl, "transcribe-stream-1", {
      type: "config", protocol_version: 1,
      audio: { format: "pcm_s16le", sample_rate: sampleRate, channels: 1 },
      turn_detection: { mode: "auto", eager: true },
      results: { drafts: true, diarize: false, tag_audio_events: false },
      context: { history: contextItems(history), terms },
      ...(reference ? { client_reference_id: String(reference).slice(0, 256) } : {}),
    }, signal);
  }

  /** A recorded voice message as text, with the language Fish heard it in: one upload, nothing kept on Fish. */
  async transcribe(bytes, { filename = "voice.ogg" } = {}) {
    if (!this.enabled) throw new FishLiveError("Fish Audio is not configured", { code: "missing_key" });
    if (!bytes?.length) throw new FishLiveError("audio vuoto", { code: "empty_audio" });
    if (bytes.length > AUDIO_FILE_LIMIT) throw new FishLiveError("audio troppo lungo", { code: "too_large" });
    const form = new FormData();
    form.append("audio", new Blob([bytes]), String(filename).replace(/[^\w.-]/g, "_").slice(-80) || "voice.ogg");
    form.append("ignore_timestamps", "true");
    let response;
    try {
      response = await fetch(this.asrFileUrl, { method: "POST", headers: { Authorization: `Bearer ${this.key}`, model: this.asrFileModel }, body: form, signal: AbortSignal.timeout(this.fileTimeoutMs) });
    } catch (error) {
      throw new FishLiveError(error?.name === "TimeoutError" ? "trascrizione Fish troppo lenta" : "Fish non raggiungibile", { code: error?.name === "TimeoutError" ? "timeout" : "connection_error" });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new FishLiveError(`Fish ${response.status}${body?.message ? `: ${String(body.message).slice(0, 200)}` : ""}`, { code: "provider_error", status: response.status, requestId: String(body?.request_id || "") });
    const code = String(body?.language_code || "").toLowerCase();
    return { text: String(body?.text || "").replace(/<\|speaker:[^|>]*\|>/g, " ").replace(/\s+/g, " ").trim(), language: /^[a-z]{2,3}$/.test(code) ? code : "" };
  }

  openTts({ voice = "", language = "", sampleRate = 24000, latency = "normal", speed = 1, signal } = {}) {
    if (![24000, 44100].includes(sampleRate)) throw new TypeError("Unsupported Fish TTS sample rate");
    if (typeof voice !== "string" || voice.length > 256) throw new TypeError("Invalid Fish voice");
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new TypeError("Invalid Fish speaking speed");
    if (typeof language !== "string" || (language && !/^[a-zA-Z0-9_-]{1,35}$/.test(language))) throw new TypeError("Invalid Fish language");
    return this.open("tts", this.ttsUrl, this.ttsModel, {
      event: "start", request: { text: "", format: "pcm", sample_rate: sampleRate, latency: ["low", "normal", "balanced"].includes(latency) ? latency : "normal", ...(speed !== 1 ? { prosody: { speed } } : {}), ...(voice ? { reference_id: voice } : {}), ...(language ? { language } : {}) },
    }, signal);
  }

  open(kind, url, model, start, signal) {
    if (!this.enabled) throw new FishLiveError("Fish Audio is not configured", { code: "missing_key" });
    return new FishSession({ ...this, kind, url, model, start, signal });
  }
}
