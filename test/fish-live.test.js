import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";
import { FishLive, FishLiveError } from "../src/fish-live.js";

async function fixture(t, handler, { reject = 0, clientOptions = {} } = {}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const state = { headers: [], events: [] };
  server.on("upgrade", (request, socket, head) => {
    state.headers.push(request.headers);
    if (reject) {
      socket.end(`HTTP/1.1 ${reject} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (bytes, binary) => {
        assert.equal(binary, true);
        const event = decode(bytes);
        state.events.push(event);
        handler?.(ws, event, state);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}`;
  const fish = new FishLive({ key: "fixture-fish-key", sttUrl: `${url}/asr`, ttsUrl: `${url}/tts`, connectTimeoutMs: 500, finishTimeoutMs: 500, ...clientOptions });
  return { fish, state };
}

const send = (ws, event) => ws.send(encode(event));
function sttStart(ws, event) {
  if (event.type === "config") send(ws, { type: "session_started", request_id: "fixture-request", config: event });
}

test("Fish STT sends authenticated binary PCM config and waits for session admission", async (t) => {
  const { fish, state } = await fixture(t, (ws, event) => {
    sttStart(ws, event);
    if (event.type === "audio_done") {
      send(ws, { type: "committed", text: "Ciao Nico", user_turn: true, turn_index: 0 });
      send(ws, { type: "session_done", stats: { audio_ms: 40 } });
    }
  });
  const session = fish.openStt({ terms: ["Cora"], reference: "fixture-call" });
  t.after(() => session.close());
  assert.throws(() => session.sendAudio(Buffer.alloc(1280)), { code: "not_ready" });
  await session.ready;
  assert.equal(state.headers[0].authorization, "Bearer fixture-fish-key");
  assert.equal(state.headers[0].model, "transcribe-stream-1");
  assert.deepEqual(state.events[0].audio, { format: "pcm_s16le", sample_rate: 48000, channels: 1 });
  assert.deepEqual(state.events[0].turn_detection, { mode: "auto", eager: true });
  assert.deepEqual(state.events[0].context, { history: [], terms: ["Cora"] });
  const pcm = Buffer.from([0, 127, 255, 0]);
  session.sendAudio(pcm);
  const transcript = once(session, "committed");
  const done = await session.end();
  assert.equal((await transcript)[0].text, "Ciao Nico");
  assert.deepEqual(Buffer.from(state.events.find((event) => event.type === "audio").data), pcm);
  assert.equal(done.type, "session_done");
  assert.equal(session.requestId, "fixture-request");
  assert.equal(session.state, "done");
});

test("Fish TTS streams text, flush and PCM audio before a clean finish", async (t) => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const { fish, state } = await fixture(t, (ws, event) => {
    if (event.event === "text") send(ws, { event: "audio", audio: pcm });
    if (event.event === "stop") send(ws, { event: "finish", reason: "stop" });
  });
  const session = fish.openTts({ voice: "fixture-voice", language: "it" });
  t.after(() => session.close());
  const chunks = [];
  session.on("audio", (bytes) => chunks.push(bytes));
  await session.ready;
  session.sendText("Ciao ");
  session.sendText("Seb.");
  session.flush();
  await session.end();
  assert.equal(state.headers[0].model, "s2.1-pro");
  assert.deepEqual(state.events[0], { event: "start", request: { text: "", format: "pcm", sample_rate: 24000, latency: "normal", reference_id: "fixture-voice", language: "it" } });
  assert.deepEqual(state.events.map((event) => event.event), ["start", "text", "text", "flush", "stop"]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([pcm, pcm]));
  assert.throws(() => session.sendText("stale"), { code: "not_ready" });
});

test("Fish auto turns preserve backchannels and resumed turns without inventing a user turn", async (t) => {
  const { fish } = await fixture(t, (ws, event) => {
    sttStart(ws, event);
    if (event.type === "audio") {
      for (const response of [
        { type: "speech_start", turn_index: 0 },
        { type: "user_backchannel", turn_index: 0 },
        { type: "committed", turn_index: 0, user_turn: false, turn_kind: "backchannel", text: "mh mh" },
        { type: "user_turn_taken", turn_index: 1 },
        { type: "eager_end_of_turn", turn_index: 1, text: "aspetta" },
        { type: "turn_resumed", turn_index: 1 },
        { type: "committed", turn_index: 1, user_turn: true, text: "aspetta, cambia" },
      ]) send(ws, response);
    }
    if (event.type === "audio_done") send(ws, { type: "session_done" });
  });
  const session = fish.openStt();
  t.after(() => session.close());
  const events = [];
  session.on("event", (event) => events.push(event));
  await session.ready;
  const committed = new Promise((resolve) => session.on("committed", (event) => { if (event.turn_index === 1) resolve(); }));
  session.sendAudio(Buffer.alloc(1920));
  await committed;
  assert.deepEqual(events.filter((event) => event.type === "committed").map((event) => event.user_turn), [false, true]);
  assert.equal(events.filter((event) => event.type === "turn_resumed").length, 1);
  await session.end();
});

test("Fish speaking state is sent only on changes and contexts use their own wire type", async (t) => {
  const { fish, state } = await fixture(t, (ws, event) => {
    sttStart(ws, event);
    if (event.type === "audio_done") send(ws, { type: "session_done" });
  });
  const session = fish.openStt();
  t.after(() => session.close());
  await session.ready;
  session.setAgentSpeaking(true);
  session.setAgentSpeaking(true);
  session.addContext([{ role: "assistant", text: "Ciao." }]);
  session.setAgentSpeaking(false);
  session.finalize();
  await session.end();
  assert.deepEqual(state.events.filter((event) => event.type === "agent_speaking").map((event) => event.speaking), [true, false]);
  assert.deepEqual(state.events.find((event) => event.type === "context_add"), { type: "context_add", items: [{ role: "assistant", text: "Ciao." }], reset_history: false });
});

for (const status of [401, 402, 429, 503]) test(`Fish exposes HTTP ${status} admission refusal without a transcript or credential`, async (t) => {
  const { fish } = await fixture(t, null, { reject: status });
  const session = fish.openStt();
  await assert.rejects(session.ready, (error) => error instanceof FishLiveError && error.code === "upgrade_refused" && error.status === status && !error.message.includes("fixture-fish-key"));
  await assert.rejects(session.done, { status });
  assert.equal(session.state, "failed");
});

test("Fish recoverable provider errors preserve the stream and exclude raw error text", async (t) => {
  const { fish } = await fixture(t, (ws, event) => {
    sttStart(ws, event);
    if (event.type === "audio") send(ws, { type: "error", error_type: "invalid_request", code: 400, recoverable: true, message: "fixture-fish-key" });
    if (event.type === "audio_done") send(ws, { type: "session_done" });
  });
  const session = fish.openStt();
  t.after(() => session.close());
  await session.ready;
  const error = once(session, "providerError");
  session.sendAudio(Buffer.alloc(20));
  assert.equal((await error)[0].message.includes("fixture-fish-key"), false);
  assert.equal(session.state, "ready");
  await session.end();
});

for (const kind of ["text", "invalid-msgpack", "early-close", "fatal-error", "restarting"]) test(`Fish rejects ${kind} and releases the session`, async (t) => {
  const { fish } = await fixture(t, (ws, event) => {
    if (event.type !== "config") return;
    if (kind === "text") ws.send('{"type":"session_started"}');
    if (kind === "invalid-msgpack") ws.send(Buffer.from([0xc1]));
    if (kind === "early-close") ws.close(1000);
    if (kind === "fatal-error") send(ws, { type: "error", error_type: "invalid_config", code: 400, recoverable: false });
    if (kind === "restarting") send(ws, { type: "error", error_type: "server_restarting", code: 503, recoverable: true });
  });
  const session = fish.openStt();
  await assert.rejects(session.ready, FishLiveError);
  await assert.rejects(session.done, FishLiveError);
  assert.equal(session.state, "failed");
});

test("Fish TTS finish reason error rejects even after partial audio", async (t) => {
  const { fish } = await fixture(t, (ws, event) => {
    if (event.event === "text") {
      send(ws, { event: "audio", audio: Buffer.alloc(20) });
      send(ws, { event: "finish", reason: "error" });
    }
  });
  const session = fish.openTts();
  await session.ready;
  session.sendText("Ciao");
  await assert.rejects(session.done, { code: "synthesis_error" });
});

test("Fish start and drain have bounded timeouts", async (t) => {
  const { fish } = await fixture(t, (ws, event) => {
    if (event.type === "config" && event.client_reference_id === "admit") sttStart(ws, event);
  }, { clientOptions: { connectTimeoutMs: 60, finishTimeoutMs: 60 } });
  const stalled = fish.openStt();
  await assert.rejects(stalled.ready, { code: "start_timeout" });
  const session = fish.openStt({ reference: "admit" });
  await session.ready;
  await assert.rejects(session.end(), { code: "finish_timeout" });
});

test("Fish abort closes active and pre-aborted connections without reconnecting", async (t) => {
  const { fish, state } = await fixture(t, sttStart);
  const controller = new AbortController();
  const session = fish.openStt({ signal: controller.signal });
  await session.ready;
  controller.abort();
  await assert.rejects(session.done, { code: "aborted" });
  session.close();
  const preAborted = fish.openStt({ signal: controller.signal });
  await assert.rejects(preAborted.ready, { code: "aborted" });
  assert.equal(state.headers.length, 1);
});

test("Fish keepalive preserves a quiet STT session and stops at completion", async (t) => {
  const { fish, state } = await fixture(t, (ws, event) => {
    sttStart(ws, event);
    if (event.type === "audio_done") send(ws, { type: "session_done" });
  }, { clientOptions: { keepaliveMs: 15 } });
  const session = fish.openStt();
  t.after(() => session.close());
  await session.ready;
  await new Promise((resolve) => setTimeout(resolve, 45));
  await session.end();
  assert.ok(state.events.some((event) => event.type === "keepalive"));
  assert.equal(session.keepalive._destroyed, true);
});

test("Fish validates audio, context, key and outbound buffer limits", async (t) => {
  assert.throws(() => new FishLive().openStt(), { code: "missing_key" });
  assert.throws(() => new FishLive({ key: "x" }).openStt({ sampleRate: 42 }), TypeError);
  assert.throws(() => new FishLive({ key: "x" }).openStt({ history: [{ role: "system", text: "x" }] }), TypeError);
  const { fish } = await fixture(t, sttStart, { clientOptions: { maxBufferedBytes: 1024 } });
  const session = fish.openStt();
  t.after(() => session.close());
  await session.ready;
  assert.throws(() => session.sendAudio("not pcm"), TypeError);
  assert.throws(() => session.sendAudio(Buffer.alloc(2048)), { code: "backpressure" });
  assert.throws(() => session.sendAudio(Buffer.alloc(1024 * 1024)), { code: "frame_limit" });
  session.close();
  await assert.rejects(session.done, { code: "aborted" });
});

for (const code of ["server_restarting", "max_duration_exceeded"]) test(`Fish drains the final committed turn before ${code} closes the stream`, async (t) => {
  const { fish } = await fixture(t, (ws, event) => {
    sttStart(ws, event);
    if (event.type === "audio") {
      send(ws, { type: "error", error_type: code, code: 503, recoverable: code === "server_restarting" });
      send(ws, { type: "committed", user_turn: true, text: "ultima frase", reason: "finalize" });
      ws.close(1012);
    }
  });
  const session = fish.openStt();
  await session.ready;
  const turns = [];
  session.on("committed", (event) => turns.push(event.text));
  session.sendAudio(Buffer.alloc(20));
  await assert.rejects(session.done, { code });
  assert.deepEqual(turns, ["ultima frase"]);
});

test("Fish TTS applies requested speaking speed and rejects invalid rates before opening", async (t) => {
  const { fish, state } = await fixture(t, (ws, event) => {
    if (event.event === "stop") send(ws, { event: "finish", reason: "stop" });
  });
  const session = fish.openTts({ speed: 1.2 });
  t.after(() => session.close());
  await session.ready;
  await session.end();
  assert.deepEqual(state.events[0].request.prosody, { speed: 1.2 });
  for (const speed of [0, 0.49, 2.01, NaN, Infinity, "1.2", null]) {
    assert.throws(() => fish.openTts({ speed }), /Invalid Fish speaking speed/);
  }
  assert.equal(state.headers.length, 1, "invalid rates never reach the provider");
});
