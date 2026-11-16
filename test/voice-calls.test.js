import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceCalls, namedAgent, fishVoiceFor, agentVoice, spokenReply, splitWork, voiceGain, FISH_CATALOG, FISH_VOICES } from "../src/voice-calls.js";
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

function setup({ replies = {}, agentChain = 6, dispatch = null, listenGapMs, now } = {}) {
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
    store: { settings: { defaultModel: "ollama/fast" }, agents: () => [radix, ada] }, bots: { client: (id) => clients[id] || null }, llm, fish, agentChain, dispatch,
    log: (entry) => log.push(entry), makeLink: (options) => { const link = new FakeLink(options); links.push(link); return link; },
    listenGapMs, now,
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
  const heard = fish.stts[0].audio.length;
  ear.emit("quiet", SEB);
  await until(() => fish.stts[0].audio.length >= heard + 3, "silence given while Seb is quiet", 1000);
  const pumped = fish.stts[0].audio.slice(heard);
  assert.ok(pumped.every((bytes) => bytes <= 48000 * 0.2 * 2), "the silence goes in real time, never as one burst");
  const given = pumped.reduce((sum, bytes) => sum + bytes, 0) / 96;
  const quietFor = Date.now() - calls.calls.get(VOICE).speakers.get(SEB).lastAt;
  assert.ok(given <= quietFor + 25, `no more silence than the time that passed (${given} ms given, ${quietFor} ms quiet)`);
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
  assert.equal(fish.ttss[0].options.speed, 1.3, "live calls request the default pace");
  assert.notEqual(fish.ttss[1].options.voice, fish.ttss[0].options.voice, "two agents never share a voice");
  assert.equal(links[1].speeches[0].bytes, 9600, "Ada's own bot speaks Ada's words");
  assert.equal(links[0].speeches[0].bytes, 9600, "Radix's bot speaks Radix's");
  assert.deepEqual(fish.stts[0].speakingFlags, [true, false, true, false], "Fish knows when an agent is speaking");
  assert.ok(fish.stts[0].context.some((item) => item.role === "assistant" && item.text === "Sto testando la chiamata."));
  assert.match(asked[0].system, /chiamata vocale dal vivo su Discord, nel canale «General»/);
  assert.match(asked[0].system, /Nella chiamata: Seb, Radix \(Radix è un agente come te\)/);
  assert.equal(asked[0].model, "ollama/fast");
});

test("voice calls: a person who keeps talking over an agent stops its voice, and PASS says nothing", async (t) => {
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
  const talking = setInterval(() => link.emit("audio", SEB, speech16(8000)), 20);
  await until(() => link.speeches[0].stopped, "the cut once Seb keeps talking", 2000);
  clearInterval(talking);
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

test("voice calls: a person who speaks to an agent always gets words, never PASS", async (t) => {
  const { calls, fish, links, asked, log } = setup({ replies: { Radix: (prompt) => (/Hai risposto PASS/.test(prompt) ? "Sì, ci sono." : "PASS") } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  const [link] = links;
  link.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Radix, ci sei?", user_turn: true });
  await until(() => link.speeches.length === 1, "Radix answering");
  assert.equal(fish.ttss[0].text, "Sì, ci sono.");
  assert.match(asked[0].system, /Una persona ti sta parlando: rispondi sempre/);
  assert.doesNotMatch(asked[0].system, /mai «ci sono»/);
  assert.doesNotMatch(asked[0].system, /rispondi esattamente PASS/);
  assert.equal(asked.length, 2, "one PASS, then asked once more");
  assert.ok(!log.some((entry) => /non risponde \(PASS/.test(entry.text)));
});

test("voice calls: an agent takes on a job and keeps talking; a job for a colleague goes to them; only a person starts one", async (t) => {
  const jobs = [];
  let radixReply = "Sì, ci lavoro subito.\nLAVORO: Controlla i 503 di REF-93 nel Feed production";
  const { calls, fish, links, asked, log } = setup({ agentChain: 2, dispatch: async (work) => { jobs.push(work); return "thread"; }, replies: { Radix: () => radixReply, Ada: "Ada, io ci sono.\nLAVORO: qualcosa che nessuno ha chiesto" } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE, origin: "text-thread" });
  await calls.join(ada, { channelId: VOICE, origin: "ada-thread" });
  links[0].emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Radix, controlla i 503 del Feed.", user_turn: true });
  await until(() => jobs.length === 1 && fish.ttss.length >= 1, "the job and the spoken answer");
  assert.equal(fish.ttss[0].text, "Sì, ci lavoro subito.", "the job line is never spoken");
  assert.deepEqual({ agent: jobs[0].agent.id, from: jobs[0].from.id, channelId: jobs[0].channelId, speakerId: jobs[0].speakerId, speakerName: jobs[0].speakerName, said: jobs[0].said, task: jobs[0].task, callName: jobs[0].callName },
    { agent: "ag_radix", from: "ag_radix", channelId: "text-thread", speakerId: SEB, speakerName: "Seb", said: "Radix, controlla i 503 del Feed.", task: "Controlla i 503 di REF-93 nel Feed production", callName: "General" });
  assert.ok(log.some((entry) => entry.text === "Radix prende un lavoro dalla chiamata per Seb: Controlla i 503 di REF-93 nel Feed production"));
  assert.match(asked[0].system, /In chiamata coordini il lavoro: parli e intanto lavori\./);
  assert.doesNotMatch(asked[0].system, /non puoi usare strumenti/);
  const call = calls.calls.get(VOICE);
  await until(() => call.history.length === 3, "Radix's words, and Ada answering them");
  await wait(30);
  assert.equal(call.history[2].text, "Ada, io ci sono.");
  assert.equal(jobs.length, 1, "Ada's job line answering an agent starts nothing");

  radixReply = "LAVORO per Ada: Rifai il giro UI di NOT-34 a 360 px";
  fish.stts[0].emit("committed", { text: "Radix, fai fare ad Ada il giro UI.", user_turn: true });
  await until(() => jobs.length === 2, "the job for Ada");
  assert.equal(jobs[1].agent.id, "ag_ada", "the colleague named does the job");
  assert.equal(jobs[1].from.id, "ag_radix");
  assert.equal(jobs[1].channelId, "text-thread", "written where Radix was called from");
  await until(() => fish.ttss.some((tts, index) => index >= 2 && tts.text === "Ci lavoro."), "Radix's short confirmation");
  assert.ok(log.some((entry) => entry.text === "Radix passa a Ada un lavoro dalla chiamata per Seb: Rifai il giro UI di NOT-34 a 360 px"));
  radixReply = "Ok.";
  const before = asked.filter((entry) => entry.name === "Radix").length;
  fish.stts[0].emit("committed", { text: "Radix, a che punto siete?", user_turn: true });
  await until(() => asked.filter((entry) => entry.name === "Radix").length > before, "Radix asked again");
  assert.match(asked.filter((entry) => entry.name === "Radix").at(-1).system, /Lavori già avviati da questa chiamata[\s\S]*Radix, per Seb: Controlla i 503 di REF-93[\s\S]*Ada, per Seb: Rifai il giro UI/, "it knows what the call already started");
});

test("voice calls: asked to leave, an agent says goodbye and goes; an agent cannot send another out", async (t) => {
  const { calls, fish, links } = setup({ replies: { Radix: "Ciao Seb, a dopo.\nESCI", Ada: "Radix, esci pure.\nESCI" } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  links[0].emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Radix, staccati dalla chiamata.", user_turn: true });
  await until(() => !calls.calls.has(VOICE), "Radix leaving");
  assert.equal(fish.ttss[0].text, "Ciao Seb, a dopo.", "the goodbye is spoken, the line is not");
  assert.equal(links[0].closed, true);

  const two = setup({ agentChain: 2, replies: { Radix: "Ciao Ada.", Ada: "Ciao Radix.\nESCI" } });
  t.after(() => two.calls.stop());
  await two.calls.join(radix, { channelId: VOICE });
  await two.calls.join(ada, { channelId: VOICE });
  await two.calls.speak(two.calls.calls.get(VOICE), two.calls.calls.get(VOICE).members.get(radix.id), "Ciao Ada.");
  await until(() => two.fish.ttss.length === 2, "Ada answering Radix");
  await wait(30);
  assert.equal(two.calls.calls.get(VOICE)?.members.has(ada.id), true, "an agent's words never make another leave");
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

test("voice calls: a job line and a leave line are split from what is spoken", () => {
  assert.deepEqual(splitWork("Ci lavoro.\nLAVORO: controlla\n  i log"), { said: "Ci lavoro.\n", task: "controlla i log", for: "" });
  assert.equal(splitWork("Va bene.\nLAVORO per Ada: rifai il giro").for, "Ada");
  assert.deepEqual(splitWork("Nessun lavoro qui, il lavoro: lo vedo dopo."), { said: "Nessun lavoro qui, il lavoro: lo vedo dopo.", task: "", for: "" }, "only a line that starts with LAVORO counts");
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

test("voice calls: the answer starts when the turn is expected to end, and is kept only if the words stay the same", async (t) => {
  const { calls, fish, links, asked, log } = setup({ replies: { Radix: (prompt) => (/Seb: Radix, a che punto è il rilascio\?/.test(prompt) ? "Il rilascio è fermo sul gate." : "Altro.") } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  links[0].emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  const stt = fish.stts[0];
  stt.emit("eager_end_of_turn", { text: "Radix, a che punto è il rilascio?" });
  await until(() => asked.length === 1, "the answer thought before the commit");
  const call = calls.calls.get(VOICE);
  assert.equal(call.history.length, 0, "nothing is a turn before the commit");
  assert.equal(fish.ttss.length, 0, "and nothing is said");
  stt.emit("committed", { text: "Radix, a che punto è il rilascio", user_turn: true });
  await until(() => fish.ttss.length === 1, "the prepared answer spoken");
  assert.equal(fish.ttss[0].text, "Il rilascio è fermo sul gate.");
  assert.equal(asked.length, 1, "the same words are not thought twice");
  await until(() => log.some((entry) => /Radix ha parlato \(pensato in [\d.]+ s, iniziato [\d.]+ s prima della fine del turno/.test(entry.text)), "the log says it started early");

  stt.emit("eager_end_of_turn", { text: "Radix, e poi" });
  await until(() => asked.length === 2, "a second early answer");
  stt.emit("turn_resumed", {});
  stt.emit("committed", { text: "Radix, e poi controlla il Feed.", user_turn: true });
  await until(() => asked.length === 3, "a resumed turn is thought again with its final words");
  assert.match(asked[2].prompt, /Seb: Radix, e poi controlla il Feed\./);
  await until(() => fish.ttss.length === 2, "the answer to the final words");

  stt.emit("eager_end_of_turn", { text: "Radix, ferma tutto" });
  await until(() => asked.length === 4, "a third early answer");
  stt.emit("committed", { text: "Radix, ferma tutto il Feed adesso.", user_turn: true });
  await until(() => asked.length === 5, "different final words are thought again");
  assert.match(asked[4].prompt, /Seb: Radix, ferma tutto il Feed adesso\./);
});

test("voice calls: a listen gap is logged once when audio stops and again when it returns", async (t) => {
  let clock = Date.now();
  const { calls, links, log, people } = setup({ listenGapMs: 20000, now: () => clock });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  const [ear, other] = links;
  ear.listenHealth = () => ({ status: "ready", ws: 40, udp: null, drops: 2 });
  other.listenHealth = () => ({ status: "ready", ws: 40, udp: 15, drops: 0 });
  ear.emit("audio", SEB, speech16(8000));
  clock += 19000;
  calls.sweep();
  assert.equal(log.filter((entry) => entry.text.startsWith("ascolto fermo")).length, 0, "a pause under the gap stays quiet");
  clock += 2000;
  calls.sweep();
  const stalled = log.filter((entry) => entry.text.startsWith("ascolto fermo"));
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].type, "voice");
  assert.match(stalled[0].text, /ascolto fermo: Seb nel canale «General» da 21 s senza audio/);
  assert.match(stalled[0].text, /ear Radix, connessione ready, ping ws 40 ms, ping udp assente, mute no, sordità no, scartati 2, ultimo pacchetto 21 s fa/);
  calls.sweep();
  assert.equal(log.filter((entry) => entry.text.startsWith("ascolto fermo")).length, 1, "the gap is logged once until audio returns");
  clock += 29000;
  ear.emit("audio", SEB, speech16(8000));
  calls.sweep();
  const resumed = log.filter((entry) => entry.text.startsWith("ascolto ripreso"));
  assert.equal(resumed.length, 1);
  assert.match(resumed[0].text, /ascolto ripreso: Seb nel canale «General» dopo 50 s/);
  assert.match(resumed[0].text, /ultimo pacchetto 0 s fa/);
  people[0].selfMute = true;
  clock += 21000;
  calls.sweep();
  const muted = log.filter((entry) => entry.text.startsWith("ascolto fermo"));
  assert.equal(muted.length, 2);
  assert.match(muted[1].text, /mute sì/);
});

test("voice calls: a gap is logged when the packets keep coming but the ear hears no voice", async (t) => {
  let clock = Date.now();
  const { calls, links, log } = setup({ listenGapMs: 20000, now: () => clock });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  const [ear] = links;
  ear.listenHealth = () => ({ status: "ready", ws: 40, udp: null, drops: 0 });
  ear.emit("audio", SEB, speech16(8000));
  for (let i = 0; i < 5; i += 1) { clock += 5000; ear.emit("audio", SEB, speech16(0)); }
  calls.sweep();
  const stalled = log.filter((entry) => entry.text.startsWith("ascolto fermo"));
  assert.equal(stalled.length, 1, "a silent microphone still sends packets, and that is a gap");
  assert.match(stalled[0].text, /da 25 s senza audio/);
  assert.match(stalled[0].text, /ultimo pacchetto 0 s fa/);
  assert.match(stalled[0].text, /ultima voce 25 s fa/);
  clock += 5000;
  ear.emit("audio", SEB, speech16(8000));
  calls.sweep();
  const resumed = log.filter((entry) => entry.text.startsWith("ascolto ripreso"));
  assert.equal(resumed.length, 1);
  assert.match(resumed[0].text, /dopo 30 s/);
});

test("voice calls: the listen log names a speaking signal with no packets, another agent still hearing, and a connection change", async (t) => {
  let clock = Date.now();
  const { calls, links, log } = setup({ listenGapMs: 20000, now: () => clock });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  const [ear, other] = links;
  ear.listenHealth = () => ({ status: "disconnected", ws: null, udp: null, drops: 0 });
  other.listenHealth = () => ({ status: "ready", ws: 12, udp: 12, drops: 0 });
  ear.emit("audio", SEB, speech16(8000));
  clock += 25000;
  ear.emit("speaking", SEB);
  other.emit("audio", SEB, speech16(8000));
  calls.sweep();
  const stalled = log.find((entry) => entry.text.startsWith("ascolto fermo"));
  assert.ok(stalled, "the ear's silence is a gap even when someone else still hears");
  assert.match(stalled.text, /connessione disconnected/);
  assert.match(stalled.text, /segnale di parola senza pacchetti/);
  assert.match(stalled.text, /Ada riceve audio/);
  assert.match(stalled.text, /Ada ready/);
  ear.emit("connection", "ready", "disconnected");
  const change = log.find((entry) => entry.text.includes("connessione ready"));
  assert.equal(change.text, "voce Radix: connessione ready → disconnected");
  assert.equal(change.type, "voice");
});

test("voice calls: when another bot hears a person and the ear does not, the next bot becomes the ear", async (t) => {
  const { calls, fish, links, log } = setup();
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  const [ear, other] = links;
  const call = calls.calls.get(VOICE);
  ear.emit("audio", SEB, speech16(8000));
  other.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb heard by the ear");
  assert.equal(calls.ear(call).agent.id, radix.id);
  call.members.get(ada.id).voiced.get(SEB).first -= 4000;
  other.emit("audio", SEB, speech16(8000));
  assert.equal(calls.ear(call).agent.id, radix.id, "the ear heard the start of that speech: it is not deaf");

  call.members.get(radix.id).voiced.get(SEB).last -= 10000;
  other.emit("audio", SEB, speech16(8000));
  assert.equal(calls.ear(call).agent.id, ada.id);
  assert.match(log.at(-1).text, /^voice: il bot di Radix non riceve più la voce di Seb \(il bot di Ada la sente da 4 s\): ora ascolta il bot di Ada$/);
  assert.equal(call.speakers.get(SEB).ear, ada.id, "the open stream is now fed by the new ear");
  const fed = fish.stts[0].audio.length;
  ear.emit("audio", SEB, speech16(8000));
  other.emit("audio", SEB, speech16(8000));
  assert.equal(fish.stts.length, 1, "the same stream goes on");
  assert.equal(fish.stts[0].audio.length, fed + 1, "only the new ear feeds it");
});

test("voice calls: DAVE decryption failures on the ear are written once per burst, with session errors", async (t) => {
  const { calls, links, log } = setup();
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  const [ear, other] = links;
  const call = calls.calls.get(VOICE);
  const texts = () => log.map((entry) => entry.text);
  other.emit("dave", "[NW] [DAVE] Failed to decrypt a packet (1 consecutive fails)");
  assert.ok(!texts().some((text) => /DAVE/.test(text)), "only the ear's bot reports DAVE");
  ear.emit("dave", "[NW] [DAVE] Failed to decrypt a packet (1 consecutive fails)");
  ear.emit("dave", "[NW] [DAVE] Failed to decrypt a packet (2 consecutive fails)");
  ear.emit("dave", "[NW] [DAVE] Executing transition (4)");
  ear.emit("dave", "[NW] [DAVE] MLS commit errored from transition 4: boom");
  assert.equal(log.filter((entry) => /DAVE non decifra/.test(entry.text)).length, 1);
  assert.ok(texts().includes("DAVE sul bot di Radix: [NW] [DAVE] MLS commit errored from transition 4: boom"));
  assert.ok(!texts().some((text) => /Executing transition/.test(text)), "ordinary transitions stay out of the log");
  calls.checkDave(call, Date.now() + 11000);
  assert.match(texts().at(-1), /^DAVE: 2 pacchetti non decifrati in 0 s, poi di nuovo regolare$/);
  assert.equal(call.dave, null);
});

test("voice calls: a recogniser Fish closes, or one idle for long, is let go with a line in the log and reopens with the next sound", async (t) => {
  const { calls, fish, links, log } = setup();
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  const [ear] = links;
  const call = calls.calls.get(VOICE);
  ear.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("providerError", Object.assign(new Error("x"), { code: "rate_limited", recoverable: true }));
  assert.equal(log.at(-1).text, "voice: speech to text for Seb reported rate_limited (recoverable)");
  fish.stts[0].emit("finish", {});
  assert.equal(call.speakers.size, 0);
  assert.equal(log.at(-1).text, "voice: speech to text for Seb closed by Fish; it reopens with the next sound");
  ear.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 2, "a new stream after Fish closed the first");
  call.speakers.get(SEB).lastAt = Date.now() - 130000;
  calls.sweep();
  assert.equal(call.speakers.size, 0);
  assert.ok(log.some((entry) => /^chiudo l'ascolto di Seb: nessun audio da 13\d s$/.test(entry.text)));
});

test("voice calls: an answer a person cut off is owed: a murmur resumes it, new words get it with the cut in mind", async (t) => {
  const { calls, fish, links, log, asked } = setup({ replies: { Radix: "Una risposta lunga sui progetti." } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  const [link] = links;
  link.hold = true;
  link.emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Dammi un aggiornamento sui progetti.", user_turn: true });
  await until(() => link.speeches[0]?.ended, "Radix speaking");
  fish.stts[0].emit("user_turn_taken", { turn_index: 1 });
  const talking = setInterval(() => link.emit("audio", SEB, speech16(8000)), 20);
  await until(() => link.speeches[0].stopped, "the cut", 2000);
  clearInterval(talking);
  const call = calls.calls.get(VOICE);
  assert.ok(log.some((entry) => entry.text === "Seb interrompe Radix mentre diceva «Una risposta lunga sui progetti.»"));
  assert.equal(call.cut.agentId, radix.id, "the answer is owed");

  link.hold = false;
  fish.stts[0].emit("committed", { text: "eh", user_turn: true });
  await until(() => link.speeches.length === 2 && call.history.length === 3, "Radix resuming after a murmur");
  assert.ok(log.some((entry) => entry.text === "Radix riprende la risposta interrotta"));
  assert.ok(log.some((entry) => /^Radix ha parlato \(.*dopo un'interruzione/.test(entry.text)));
  assert.match(asked.at(-1).system, /La persona ti ha interrotto mentre dicevi «Una risposta lunga sui progetti\.»/);
  assert.match(asked.at(-1).system, /senza chiedere di ripetere/);
  assert.equal(call.cut, null, "said in full, nothing is owed any more");

  link.hold = true;
  fish.stts[0].emit("committed", { text: "E il resto?", user_turn: true });
  await until(() => link.speeches[2]?.ended, "Radix speaking again");
  fish.stts[0].emit("user_turn_taken", { turn_index: 2 });
  const again = setInterval(() => link.emit("audio", SEB, speech16(8000)), 20);
  await until(() => link.speeches[2].stopped, "the second cut", 2000);
  clearInterval(again);
  link.hold = false;
  fish.stts[0].emit("committed", { text: "Ah no, aspetta, un po' di rispetto.", user_turn: true });
  await until(() => link.speeches.length === 4, "Radix answering the new words");
  assert.match(asked.at(-1).system, /La persona ti ha interrotto mentre dicevi/, "new words are answered knowing what was cut");
  assert.match(asked.at(-1).prompt, /Seb: Dammi un aggiornamento sui progetti\.[\s\S]*Seb: Ah no, aspetta/);
  await until(() => call.cut === null, "the cut settled");
  fish.stts[0].emit("committed", { text: "Radix, che ore sono?", user_turn: true });
  await until(() => link.speeches.length === 5, "Radix answering a fresh question");
  assert.match(asked.at(-1).system, /Rispondi all'ultima richiesta e basta/);
  assert.doesNotMatch(asked.at(-1).system, /ti ha interrotto/);
});

test("voice calls: a person sends several agents out: each one asked leaves, the one not asked stays", async (t) => {
  const { calls, fish, links, asked, log } = setup({ replies: {
    Radix: "Va bene, stacco.\nESCI",
    Ada: (prompt) => (/anche tu Ada/.test(prompt) ? "Stacco anch'io.\nESCI" : "PASS"),
  } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  links[0].emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Radix, stacca il vocale, anche tu Ada.", user_turn: true });
  await until(() => !calls.calls.has(VOICE), "both leaving");
  assert.deepEqual(fish.ttss.map((tts) => tts.text), ["Va bene, stacco.", "Stacco anch'io."], "who says goodbye goes");
  assert.equal(links[1].closed, true, "Ada's bot left too");
  assert.match(asked.find((entry) => entry.name === "Ada").system, /Radix è appena uscito perché una persona gliel'ha chiesto/);

  const one = setup({ replies: { Radix: "Ciao Seb.\nESCI", Ada: (prompt) => (/anche tu Ada/.test(prompt) ? "Ciao.\nESCI" : "PASS") } });
  t.after(() => one.calls.stop());
  await one.calls.join(radix, { channelId: VOICE });
  await one.calls.join(ada, { channelId: VOICE });
  one.links[0].emit("audio", SEB, speech16(8000));
  await until(() => one.fish.stts.length === 1, "Seb's stream");
  one.fish.stts[0].emit("committed", { text: "Radix, staccati.", user_turn: true });
  await until(() => one.links[0].closed, "Radix leaving");
  await until(() => one.log.some((entry) => /Ada non risponde \(PASS/.test(entry.text)), "Ada passing");
  assert.equal(one.calls.calls.get(VOICE)?.members.has(ada.id), true, "a request only for Radix leaves Ada in the call");
  assert.equal(one.fish.ttss.length, 1);
  assert.ok(!log.some((entry) => /voleva uscire/.test(entry.text)));
});

test("voice calls: a job one agent took is not opened again by a colleague", async (t) => {
  const jobs = [];
  const { calls, fish, links, log } = setup({ dispatch: async (work) => { jobs.push(work); return "thread"; }, replies: {
    Ada: "Ci lavoro.\nLAVORO: In Cora, allineare le emoji del canale vocale e dei messaggi vocali",
    Radix: "Ci penso io.\nLAVORO: In Cora, allineare le emoji del canale vocale e dei messaggi vocali (progetto Cora, rif. NOT-43)",
  } });
  t.after(() => calls.stop());
  await calls.join(radix, { channelId: VOICE });
  await calls.join(ada, { channelId: VOICE });
  links[0].emit("audio", SEB, speech16(8000));
  await until(() => fish.stts.length === 1, "Seb's stream");
  fish.stts[0].emit("committed", { text: "Ada, cambiate le emoji: vocale e messaggi vocali uguali.", user_turn: true });
  await until(() => jobs.length === 1, "Ada's job");
  await wait(30);
  fish.stts[0].emit("committed", { text: "Radix, e le emoji?", user_turn: true });
  await until(() => log.some((entry) => /^Ada ha già questo lavoro, aperto \d+ s fa: non lo riapro/.test(entry.text)), "the duplicate refused");
  await wait(30);
  assert.equal(jobs.length, 1, "one job, one agent");
  assert.equal(jobs[0].agent.id, ada.id);
});

test("voice calls: an agent has one voice, the same in every call and in its voice messages", async (t) => {
  const { calls, fish } = setup({ replies: { Radix: "Ci sono." } });
  t.after(() => calls.stop());
  const nico = { id: "ag_nico", name: "Nico", gender: "male", createdAt: "2026-01-02" };
  const older = { ...radix, createdAt: "2026-01-01" };
  const alone = agentVoice(older, [older]);
  assert.equal(agentVoice(older, [older, nico]), alone, "a colleague made later never changes a voice");
  assert.equal(alone, FISH_VOICES.male[0], "the voice chosen for the gender");
  assert.equal(agentVoice(nico, [older, nico]), FISH_VOICES.male[1], "two men never sound alike");
  assert.notEqual(agentVoice(nico, [older, nico]), agentVoice(older, [older, nico]));
  assert.equal(agentVoice(nico, [{ ...older, voice: FISH_VOICES.male[0] }, nico]), FISH_VOICES.male[1], "a voice a colleague picked is not taken again");
  assert.equal(agentVoice({ ...ada, createdAt: "2026-01-03" }, [older, nico]), FISH_VOICES.female[0]);
  const men = ["Primo", "Nico", "Seeky", "Radix", "Buzz"].map((name, index) => ({ id: `ag_${name}`, name, gender: "male", createdAt: `2026-10-2${index}` }));
  assert.equal(new Set(men.map((man) => agentVoice(man, men))).size, men.length, "five men, five voices: Nico and Radix never match");
  assert.equal(agentVoice({ ...nico, voice: FISH_CATALOG[2].id }, [older, nico]), FISH_CATALOG[2].id, "a Fish voice picked in the panel");
  assert.equal(agentVoice({ ...nico, voice: "Giulia" }, [older, nico]), FISH_VOICES.male[1], "a Soniox voice is not a Fish voice");
  assert.equal(agentVoice({ ...older, fishVoice: "chosen" }, [older, nico]), "chosen");

  await calls.join(radix, { channelId: VOICE });
  const member = [...calls.calls.get(VOICE).members.values()][0];
  assert.equal(member.voice, calls.voiceOf(radix), "in a call the agent speaks with its own voice, not one picked by who else is there");
  await calls.join(ada, { channelId: VOICE });
  assert.equal(member.voice, calls.voiceOf(radix));

  const pcm = await calls.speech(radix, "Ciao Seb.", "it");
  const note = fish.ttss.at(-1).options;
  assert.equal(note.voice, member.voice, "a voice message speaks with the call's voice");
  assert.equal(note.speed, calls.speechSpeed(radix), "and at the call's speed");
  assert.equal(note.language, "it");
  assert.equal(pcm.length, 9600);
  assert.equal(fish.ttss.at(-1).text, "Ciao Seb.");
});

test("voice calls: a voice Fish makes quieter is raised to the others' loudness, across chunk boundaries, without wrapping", () => {
  const quiet = FISH_CATALOG.find((voice) => voice.gain);
  assert.equal(quiet.id, FISH_VOICES.female[0]);
  const same = voiceGain(FISH_VOICES.male[0]);
  const raw = Buffer.from([1, 2, 3, 4]);
  assert.equal(same(raw), raw, "a voice at the right loudness is left untouched");
  const louder = voiceGain(quiet.id);
  const pcm = Buffer.alloc(6);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-20000, 2);
  pcm.writeInt16LE(30000, 4);
  const out = Buffer.concat([louder(pcm.subarray(0, 3)), louder(pcm.subarray(3))]);
  assert.equal(out.length, 6);
  assert.deepEqual([out.readInt16LE(0), out.readInt16LE(2), out.readInt16LE(4)], [Math.round(1000 * quiet.gain), -32768, 32767]);
});
