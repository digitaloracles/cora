import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceCalls, namedAgent, fishVoiceFor, spokenReply, FISH_VOICES } from "../src/voice-calls.js";
import { Upsampler, toMono, peakOf } from "../src/discord-voice.js";

const GUILD = "g1";
const VOICE = "v1";
const SEB = "u-seb";
const radix = { id: "ag_radix", name: "Radix", gender: "male", model: "ollama/fast", personality: "Custode." };
const ada = { id: "ag_ada", name: "Ada", gender: "female", model: "ollama/fast", personality: "Operatrice." };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await wait(5);
  }
}

function speech16(value, samples = 960) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(i % 2 ? value : -value, i * 2);
  return pcm;
}

function fakeClient(userId, members) {
  return {
    user: { id: userId, username: userId },
    channelInfo: (id) => (id === VOICE ? { id, name: "General", type: 2, guildId: GUILD } : id === "text" ? { id, name: "chat", type: 0, guildId: GUILD } : null),
    voiceChannelOf: (user) => (members().some((member) => member.userId === user) ? { channelId: VOICE, guildId: GUILD } : null),
    voiceMembers: () => members(),
  };
}

class FakeLink extends EventEmitter {
  constructor({ client }) {
    super();
    this.client = client;
    this.spoken = [];
    this.closed = false;
    this.speeches = [];
  }
  async open() { this.opened = true; return this; }
  speak() {
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const speech = { bytes: 0, ended: false, stopped: false, done,
      write: (pcm) => { speech.bytes += pcm.length; },
      end: () => { speech.ended = true; if (!this.hold) settle("played"); },
      stop: () => { speech.stopped = true; settle("stopped"); },
      finish: () => settle("played"),
    };
    this.speeches.push(speech);
    return speech;
  }
  close(reason = "left") { this.closed = true; this.emit("closed", reason); }
}

class FakeStt extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.audio = [];
    this.speakingFlags = [];
    this.context = [];
    this.finalized = 0;
    this.ended = false;
    this.aborted = false;
    this.ready = Promise.resolve(this);
  }
  sendAudio(pcm) { this.audio.push(pcm.length); }
  setAgentSpeaking(value) { this.speakingFlags.push(value); }
  addContext(items) { this.context.push(...items); }
  finalize() { this.finalized += 1; }
  end() { this.ended = true; return Promise.resolve(); }
  abort() { this.aborted = true; }
}

class FakeTts extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.text = "";
    this.aborted = false;
    this.ready = Promise.resolve(this);
  }
  sendText(text) { this.text += text; }
  flush() {}
  async end() { this.emit("audio", Buffer.alloc(4800)); this.emit("audio", Buffer.alloc(4800)); }
  abort() { this.aborted = true; }
}

function setup({ replies = {}, agentChain = 6 } = {}) {
  const people = [{ userId: SEB, name: "Seb", bot: false }];
  const members = () => [...people, ...[...calls.calls.values()].flatMap((call) => [...call.members.values()].map((member) => ({ userId: member.userId, name: member.agent.name, bot: true })))];
  const clients = { [radix.id]: fakeClient("bot-radix", members), [ada.id]: fakeClient("bot-ada", members) };
  const fish = { enabled: true, stts: [], ttss: [], openStt(options) { const stt = new FakeStt(options); this.stts.push(stt); return stt; }, openTts(options) { const tts = new FakeTts(options); this.ttss.push(tts); return tts; } };
  const asked = [];
  const llm = {
    isAgentic: () => false,
    chat: async ({ model, messages }) => {
      const name = /^Sei (\w+)\./.exec(messages[0].content)[1];
      asked.push({ name, model, system: messages[0].content, prompt: messages[1].content });
      const reply = replies[name];
      return { text: typeof reply === "function" ? reply(messages[1].content) : reply ?? "PASS" };
    },
  };
  const links = [];
  const log = [];
  const calls = new VoiceCalls({
    store: { settings: { defaultModel: "ollama/fast" } }, bots: { client: (id) => clients[id] || null }, llm, fish, agentChain,
    log: (entry) => log.push(entry), makeLink: (options) => { const link = new FakeLink(options); links.push(link); return link; },
  });
  return { calls, fish, llm, asked, links, log, people, clients };
}

test("voice calls: an agent joins where the person asking is, and refuses what is not a voice channel", async (t) => {
  const { calls, links } = setup();
  t.after(() => calls.stop());
  const where = await calls.join(radix, { requesterId: SEB });
  assert.deepEqual(where, { channel_id: VOICE, channel_name: "General", agents: ["Radix"], people: ["Seb"], joined: true });
  assert.equal(links[0].opened, true);
  await assert.rejects(calls.join(ada, { channelId: "text" }), /not a voice channel/);
  await assert.rejects(calls.join(ada, { requesterId: "u-nobody" }), /which voice channel/);
  await assert.rejects(calls.join(ada, { channelId: VOICE, allowedGuild: () => false }), /not one this Cora works in/);
  await assert.rejects(calls.join({ id: "ag_none", name: "Nessuno" }, { channelId: VOICE }), /no Discord bot of its own/);
  const off = setup();
  off.fish.enabled = false;
  await assert.rejects(off.calls.join(radix, { channelId: VOICE }), /Fish Audio is not connected/);
  off.calls.stop();
});

test("voice calls: one speech-to-text stream per person, through the first agent's bot only, never for the call's own agents or silence", async (t) => {
  const { calls, fish, links } = setup();
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  const [ear, other] = links;
  other.emit("audio", SEB, speech16(8000));
  ear.emit("audio", "bot-ada", speech16(8000));
  ear.emit("audio", SEB, speech16(10));
  assert.equal(fish.stts.length, 0, "the second agent's bot, the call's own agents and a stream of silence open nothing");
  ear.emit("audio", SEB, speech16(8000));
  ear.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts[0]?.audio.length === 2, "Seb's audio reaching Fish");
  assert.equal(fish.stts.length, 1);
  assert.equal(fish.stts[0].options.sampleRate, 48000);
  assert.deepEqual(fish.stts[0].options.terms, ["Radix", "Ada"], "the agents' names are terms to recognize");
  ear.emit("quiet", SEB);
  assert.equal(fish.stts[0].audio.at(-1), 48000 * 1.6 * 2, "a quiet speaker's turn is closed with silence given at once");
});

test("voice calls: a person names an agent, it answers by voice, and agents answer each other up to the chain limit", async (t) => {
  const { calls, fish, links, asked } = setup({ agentChain: 2, replies: { Ada: "**Ada:** Sto testando la chiamata.", Radix: (prompt) => (/Ada: Sto testando/.test(prompt) ? "Bene, Ada. Fammi sapere." : "Ciao.") } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  const [ear] = links;
  ear.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Ada, che cosa stai testando?", user_turn: true });
  const call = calls.calls.get(VOICE);
  await until(() => call.history.length >= 3, "Ada's answer and Radix's reply", 4000);
  await wait(30);
  assert.deepEqual(call.history.map((turn) => `${turn.agent?.name || turn.name}: ${turn.text}`), [
    "Seb: Ada, che cosa stai testando?",
    "Ada: Sto testando la chiamata.",
    "Radix: Bene, Ada. Fammi sapere.",
  ], "the name and markdown are not spoken; after two agent turns in a row they wait for a person");
  assert.equal(fish.ttss.length, 2);
  assert.equal(fish.ttss[0].text, "Sto testando la chiamata.");
  assert.equal(fish.ttss[0].options.voice, fishVoiceFor(ada));
  assert.equal(fish.ttss[0].options.speed, 1.2, "live calls request faster speech");
  assert.notEqual(fish.ttss[1].options.voice, fish.ttss[0].options.voice, "two agents never share a voice");
  assert.equal(links[1].speeches[0].bytes, 9600, "Ada's own bot speaks Ada's words");
  assert.equal(links[0].speeches[0].bytes, 9600, "Radix's bot speaks Radix's");
  assert.deepEqual(fish.stts[0].speakingFlags, [true, false, true, false], "Fish knows when an agent is speaking");
  assert.ok(fish.stts[0].context.some((item) => item.role === "assistant" && item.text === "Sto testando la chiamata."));
  assert.match(asked[0].system, /chiamata vocale dal vivo su Discord, nel canale «General»/);
  assert.match(asked[0].system, /Nella chiamata: Seb, Radix \(Radix è un agente come te\)/);
  assert.equal(asked[0].model, "ollama/fast");
});

test("voice calls: a person talking over an agent stops its voice at once, and PASS says nothing", async (t) => {
  const { calls, fish, links, log } = setup({ replies: { Radix: "Una risposta lunga che verrà interrotta." } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  const [link] = links;
  link.hold = true;
  link.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Raccontami tutto.", user_turn: true });
  await until(() => link.speeches[0]?.ended, "Radix speaking");
  const call = calls.calls.get(VOICE);
  assert.equal(call.speaking?.name, "Radix");
  fish.stts[0].emit("user_turn_taken", { turn_index: 1 });
  assert.equal(link.speeches[0].stopped, true, "the voice stops");
  assert.equal(fish.ttss[0].aborted, true, "and so does the synthesis");
  assert.equal(call.speaking, null);
  await wait(20);
  assert.equal(call.history.length, 1, "interrupted words are not a turn the others hear");
  assert.deepEqual(fish.stts[0].speakingFlags, [true, false]);

  link.hold = false;
  calls.llm = { isAgentic: () => false, chat: async () => ({ text: "PASS" }) };
  fish.stts[0].emit("committed", { text: "Niente, lascia stare.", user_turn: true });
  await wait(30);
  assert.equal(fish.ttss.length, 1, "PASS opens no voice");
  assert.ok(log.some((entry) => /Radix non risponde \(PASS/.test(entry.text)), "but the activity log says the agent passed");
  fish.stts[0].emit("committed", { text: "mm-hm", user_turn: false, turn_kind: "backchannel" });
  await wait(10);
  assert.equal(call.history.length, 2, "a backchannel is not a turn");
});

test("voice calls: leaving closes the person's stream, and the last agent out ends the call", async (t) => {
  const { calls, fish, links } = setup();
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  links[0].emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  assert.deepEqual(await calls.leave(radix), { left: true, channel_id: VOICE, channel_name: "General" });
  await wait(5);
  assert.equal(links[0].closed, true);
  assert.equal(fish.stts[0].ended, true, "the stream heard through Radix's bot is closed");
  assert.equal(fish.stts[0].aborted, true);
  links[1].emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 2, "Ada's bot taking over as the ear");
  await calls.leave(ada);
  assert.equal(calls.calls.size, 0);
  assert.deepEqual(await calls.leave(ada), { left: false });
});

test("voice calls: names, voices and spoken replies", () => {
  assert.equal(namedAgent("ok, Radix e poi Ada", [ada, radix])?.name, "Radix");
  assert.equal(namedAgent("radixx", [radix]), null);
  assert.equal(namedAgent("ÀDA, ci sei?", [ada])?.name, "Ada");
  assert.ok(FISH_VOICES.female.includes(fishVoiceFor(ada)));
  assert.equal(fishVoiceFor({ ...ada, fishVoice: "custom" }), "custom");
  assert.equal(spokenReply("pass"), "");
  assert.equal(spokenReply("<think>hm</think>Radix: Vedi [qui](https://x.y)."), "Radix: Vedi qui.");
  assert.equal(spokenReply("Radix: Vedi.", "Radix"), "Vedi.");
  assert.ok(spokenReply(`${"Frase. ".repeat(200)}`).length <= 600);
});

test("discord voice: 24 kHz mono speech becomes 48 kHz stereo without a seam between chunks, and back to mono", () => {
  const upsampler = new Upsampler();
  const a = Buffer.alloc(4);
  a.writeInt16LE(100, 0);
  a.writeInt16LE(200, 2);
  const first = upsampler.push(Buffer.concat([a, Buffer.from([0x2c])]));
  const second = upsampler.push(Buffer.from([0x01]));
  const read = (buf) => Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2));
  assert.deepEqual(read(first), [100, 100, 100, 100, 150, 150, 200, 200]);
  assert.deepEqual(read(second), [250, 250, 300, 300], "an odd byte waits for the next chunk; the join is interpolated");
  assert.deepEqual(read(toMono(second)), [250, 300]);
  assert.equal(peakOf(speech16(-1234)), 1234);
});
