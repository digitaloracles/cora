import { agentPersona } from "./character.js";
import { VoiceLink, peakOf } from "./discord-voice.js";
import { speakable } from "./voice.js";

/**
 * Agents in Discord voice channels, live: each joins with its own bot, people are heard through
 * Fish Audio's realtime speech to text (one stream per speaker), the agent answers with its own
 * model and persona, and speaks through Fish Audio's streaming speech. Agents of this Cora hear
 * each other as the words they said, without a round trip through speech to text.
 */

// Public Fish voices that speak Italian naturally: an agent without a chosen voice gets one of its gender.
export const FISH_VOICES = {
  male: ["05ec491eed4b4e49b09b874b116a6d2d", "71b5cb1b95714840839cf2cd39534bde", "90bae7a6dfc843f9acad0c8259f93e7c"],
  female: ["de56cf2236664adb863c0e34bed1f078", "ef02f46e6a7540759f9d767d7e22c2e5", "6d4fe655c7a14aabbb8e0e5d9fd62b41"],
};
const SAMPLE_RATE = 48000;
const HISTORY = 30;
const MAX_REPLY = 600;
// Agents may answer each other this many times in a row; then they wait for a person to speak.
export const AGENT_CHAIN = 6;
// Audio quieter than this is a stream of silence, not speech.
const VOICE_PEAK = 300;
// Discord sends nothing while a person is silent: after this long without audio the speech to text
// is given silence in real time, so its own turn detection hears the pause as it happens.
const SILENCE_PUMP_AFTER_MS = 100;
const SILENCE_PUMP_TICK_MS = 20;
const SILENCE_PUMP_MAX_MS = 4000;
const FINALIZE_AFTER_MS = 1500;
const IDLE_SPEAKER_MS = 120000;
const EMPTY_CALL_MS = 180000;
const REPLY_TIMEOUT_MS = 45000;

const fold = (text) => String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
// The words a person uses only to acknowledge, to test the line or to fill a silence: not a request.
const FILLERS = new Set(["mm", "mmm", "mmh", "mhm", "hmm", "eh", "ah", "oh", "beh", "boh", "ok", "okay", "okei", "grazie", "mille", "ciao", "ecco", "allora", "pronto", "ascolta", "ascoltate", "ascoltami", "senti", "dimmi", "perfetto", "certo", "bene", "buono", "giusto", "esatto", "test", "ti", "mi", "ci", "sei", "sono", "qui", "eccomi", "sento", "sentite", "sentito", "presente", "anche", "ora", "che", "come", "va", "vabbe", "un", "il", "la", "di", "dunque", "hmm"]);
const BARGE_MS = 700;
// The person must still be making sound this recently for the cut to be theirs and not a leftover turn.
const BARGE_SILENCE_MS = 280;
const WORK_DEDUPE_MS = 120000;
const SPEECH_SPEED = 1.7;

// A refusal or a request to wait changes what the agents do: never a murmur, whatever else it says.
const MEANINGFUL = new Set(["no", "non", "aspetta", "stop", "fermo", "fermati", "smetti", "basta"]);

/** What a person says only to acknowledge or to test the line: it is not a request and does not cut an agent. */
export function isNoise(text) {
  const words = fold(text).match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length || words.length > 6) return false;
  if (words.some((word) => MEANINGFUL.has(word))) return false;
  return words.every((word) => FILLERS.has(word));
}

/** The same job asked twice in a call, written a little differently, gets the same key. */
export function workKey(task) {
  return fold(task).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Two jobs are the same when one is the other with a few more words, or they share most of their words. */
export function sameWork(one, other) {
  if (!one || !other) return false;
  if (one === other) return true;
  const a = new Set(one.split(" ").filter(Boolean));
  const b = new Set(other.split(" ").filter(Boolean));
  // A different number is a different job: NOT-4 is not NOT-43, build 12 is not build 123.
  const numbers = (words) => [...words].filter((word) => /\d/.test(word)).sort().join(" ");
  if (numbers(a) && numbers(b) && numbers(a) !== numbers(b)) return false;
  if (one.includes(other) || other.includes(one)) return true;
  if (a.size < 3 || b.size < 3) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / new Set([...a, ...b]).size >= 0.75;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The words of a turn without case, accents or punctuation: an early guess and the final text compare on these. */
export function sameWords(text) {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) || []).join(" ");
}

/** The agent named first in what was said, if any: «Radix, che ne pensi?» goes to Radix. */
export function namedAgent(text, agents) {
  const said = fold(text);
  let best = null;
  for (const agent of agents) {
    const name = fold(agent.name).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!name) continue;
    const match = new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/ /g, "\\s+")}($|[^\\p{L}\\p{N}])`, "u").exec(said);
    if (match && (!best || match.index < best.index)) best = { agent, index: match.index };
  }
  return best?.agent || null;
}

/** A Fish voice for an agent that has not chosen one: stable, of its gender, different between agents where it can be. */
export function fishVoiceFor(agent, taken = []) {
  if (agent.fishVoice) return agent.fishVoice;
  const pool = FISH_VOICES[agent.gender === "female" ? "female" : "male"];
  let hash = 0;
  for (const char of String(agent.id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  for (let step = 0; step < pool.length; step += 1) {
    const voice = pool[(hash + step) % pool.length];
    if (!taken.includes(voice)) return voice;
  }
  return pool[hash % pool.length];
}

/**
 * A reply may end with a job the agent takes on: a line «LAVORO: …». That line is never spoken;
 * it becomes a task the agent works on in its written conversation while the call goes on.
 */
export function splitWork(text) {
  const raw = String(text || "");
  const match = /^[ \t*_>-]*LAVORO(?:\s+per\s+([^\s:][^:\n]{0,40}?))?\s*:\s*/im.exec(raw);
  if (!match) return { said: raw, task: "", for: "" };
  const task = raw.slice(match.index + match[0].length).replace(/\s+/g, " ").trim().slice(0, 2000);
  return { said: raw.slice(0, match.index), task, for: (match[1] || "").trim() };
}

// A line «ESCI» at the end of a reply: the agent says goodbye and leaves the call.
const LEAVE_LINE = /^[ \t*_>-]*ESCI[.!]?[ \t]*$/im;

/** What a voice says of a model's answer: plain words, a few sentences at most. */
export function spokenReply(text, agentName = "") {
  let spoken = speakable(String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, " "));
  if (agentName) spoken = spoken.replace(new RegExp(`^${agentName}\\s*:\\s*`, "i"), "");
  if (/^pass\.?$/i.test(spoken.trim())) return "";
  if (spoken.length > MAX_REPLY) {
    const cut = spoken.slice(0, MAX_REPLY);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    spoken = end > MAX_REPLY / 3 ? cut.slice(0, end + 1) : cut;
  }
  return spoken.trim();
}

class Call {
  constructor({ guildId, channelId, name }) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.name = name;
    this.members = new Map();
    this.speakers = new Map();
    this.history = [];
    this.chain = 0;
    this.speaking = null;
    this.thinking = null;
    this.pending = null;
    this.works = [];
    this.lastHumanAt = Date.now();
    this.startedAt = Date.now();
  }
}

export class VoiceCalls {
  constructor({ store, bots, llm, fish, log = () => {}, emit = () => {}, language = () => "it", makeLink = (options) => new VoiceLink(options), agentChain = AGENT_CHAIN, dispatch = null }) {
    this.store = store;
    this.bots = bots;
    this.llm = llm;
    this.fish = fish;
    this.log = log;
    this.emit = emit;
    this.language = language;
    this.makeLink = makeLink;
    this.agentChain = agentChain;
    // Hands a job taken on in a call to the agent's written conversation, where it works with its tools.
    this.dispatch = dispatch;
    this.calls = new Map();
    this.sweeper = setInterval(() => this.sweep(), 15000);
    this.sweeper.unref?.();
  }

  get enabled() {
    return Boolean(this.fish?.enabled);
  }

  callOf(agentId) {
    for (const call of this.calls.values()) if (call.members.has(agentId)) return call;
    return null;
  }

  status() {
    return [...this.calls.values()].map((call) => ({
      channelId: call.channelId, guildId: call.guildId, name: call.name, startedAt: call.startedAt,
      agents: [...call.members.values()].map((member) => ({ id: member.agent.id, name: member.agent.name, speaking: call.speaking?.agentId === member.agent.id })),
      speakers: [...call.speakers.values()].map((speaker) => ({ userId: speaker.userId, name: speaker.name })),
      turns: call.history.length,
    }));
  }

  /**
   * An agent joins a voice channel with its own bot: the one named, or the one the person who
   * asked is in. Returns where it is.
   */
  async join(agent, { channelId = "", requesterId = "", allowedGuild = () => true, origin = "" } = {}) {
    if (!this.enabled) this.refreshKey?.();
    if (!this.enabled) throw new Error("Fish Audio is not connected: the owner adds its key (FISH_AUDIO_API_KEY or the vault secret FISH_AUDIO_CORA)");
    const client = this.bots?.client(agent.id);
    if (!client?.user) throw new Error(`${agent.name} has no Discord bot of its own connected: voice calls need it`);
    let target = String(channelId || "");
    if (!target && requesterId) target = client.voiceChannelOf(requesterId)?.channelId || "";
    if (!target) throw new Error("say which voice channel, or join one yourself first");
    const info = client.channelInfo(target);
    if (!info || ![2, 13].includes(info.type)) throw new Error("that is not a voice channel this agent's bot can see");
    if (!allowedGuild(info.guildId)) throw new Error("that server is not one this Cora works in");
    const current = this.callOf(agent.id);
    if (current?.channelId === target) {
      if (origin) current.members.get(agent.id).origin = origin;
      return this.where(current, agent);
    }
    if (current) await this.leave(agent);
    let call = this.calls.get(target);
    if (!call) {
      call = new Call({ guildId: info.guildId, channelId: target, name: info.name });
      this.calls.set(target, call);
    }
    const link = this.makeLink({ client, guildId: info.guildId, channelId: target, log: (text) => this.log({ type: "error", agentId: agent.id, channelId: target, text }) });
    const member = { agent, link, userId: client.user.id, voice: fishVoiceFor(agent, [...call.members.values()].map((entry) => entry.voice)), joinedAt: Date.now(), origin: String(origin || "") };
    call.members.set(agent.id, member);
    try {
      await link.open();
    } catch (error) {
      call.members.delete(agent.id);
      if (!call.members.size) this.calls.delete(target);
      throw error;
    }
    link.on("audio", (userId, pcm) => this.heard(call, member, userId, pcm));
    link.on("quiet", (userId) => this.quiet(call, member, userId));
    link.on("closed", (reason) => {
      if (call.members.get(agent.id)?.link === link) this.drop(call, agent.id, reason);
    });
    this.log({ type: "voice", agentId: agent.id, channelId: target, text: `${agent.name} è entrato nel canale vocale «${call.name}»` });
    this.changed();
    return this.where(call, agent);
  }

  where(call, agent) {
    return { channel_id: call.channelId, channel_name: call.name, agents: [...call.members.values()].map((member) => member.agent.name), people: this.people(call).map((person) => person.name || person.userId), joined: call.members.has(agent.id) };
  }

  /** The people in the channel, as the first agent's bot sees them: everyone but this Cora's own agents. */
  people(call) {
    const own = new Set([...call.members.values()].map((member) => member.userId));
    const any = call.members.values().next().value;
    return (any?.link.client.voiceMembers(call.channelId) || []).filter((person) => !own.has(person.userId));
  }

  async leave(agent) {
    const call = this.callOf(agent.id);
    if (!call) return { left: false };
    const member = call.members.get(agent.id);
    member.link.close("left");
    this.drop(call, agent.id, "left");
    return { left: true, channel_id: call.channelId, channel_name: call.name };
  }

  drop(call, agentId, reason) {
    const member = call.members.get(agentId);
    if (!member) return;
    call.members.delete(agentId);
    if (call.speaking?.agentId === agentId) this.stopSpeaking(call);
    if (call.thinking?.agentId === agentId) call.thinking.controller.abort();
    // The speakers were heard through this agent's bot: hand them to whoever stays.
    for (const speaker of [...call.speakers.values()]) if (speaker.ear === agentId) this.closeSpeaker(call, speaker);
    if (!call.members.size) {
      for (const speaker of [...call.speakers.values()]) this.closeSpeaker(call, speaker);
      this.calls.delete(call.channelId);
    }
    this.log({ type: "voice", agentId, channelId: call.channelId, text: `${member.agent.name} è uscito dal canale vocale «${call.name}» (${reason})` });
    this.changed();
  }

  changed() {
    this.emit({ type: "voice-calls", calls: this.status() });
  }

  /** The first agent in the call is the ear: one stream per person, never one per agent. */
  ear(call) {
    return [...call.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0] || null;
  }

  isOwnAgent(call, userId) {
    return [...call.members.values()].some((member) => member.userId === userId);
  }

  heard(call, member, userId, pcm) {
    if (this.ear(call) !== member || this.isOwnAgent(call, userId)) return;
    let speaker = call.speakers.get(userId);
    if (!speaker) {
      if (peakOf(pcm) < VOICE_PEAK) return;
      speaker = this.openSpeaker(call, member, userId);
      if (!speaker) return;
    }
    speaker.lastAt = Date.now();
    if (peakOf(pcm) >= VOICE_PEAK) speaker.lastSoundAt = speaker.lastAt;
    clearTimeout(speaker.finalizer);
    if (speaker.ready) {
      this.feed(speaker, pcm);
      speaker.fedAt = speaker.lastAt;
    } else speaker.queued.push(pcm);
    this.pumpSilence(speaker);
  }

  /** While a person is silent the recogniser keeps hearing time pass, as silence, until it closes the turn. */
  pumpSilence(speaker) {
    if (speaker.pump) return;
    speaker.pump = setInterval(() => {
      const now = Date.now();
      if (!speaker.open || now - speaker.lastAt > SILENCE_PUMP_MAX_MS) {
        clearInterval(speaker.pump);
        speaker.pump = null;
        return;
      }
      if (!speaker.ready || now - speaker.lastAt < SILENCE_PUMP_AFTER_MS) return;
      const ms = Math.min(now - (speaker.fedAt || speaker.lastAt), 200);
      if (ms < SILENCE_PUMP_TICK_MS) return;
      this.feed(speaker, Buffer.alloc(Math.round(SAMPLE_RATE * ms / 1000) * 2));
      speaker.fedAt = (speaker.fedAt || speaker.lastAt) + ms;
    }, SILENCE_PUMP_TICK_MS);
    speaker.pump.unref?.();
  }

  feed(speaker, pcm) {
    try {
      speaker.stt.sendAudio(pcm);
    } catch (error) {
      this.log({ type: "error", channelId: speaker.channelId, text: `voice: audio for ${speaker.name || speaker.userId} not sent (${error.code || error.message})` });
    }
  }

  quiet(call, member, userId) {
    const speaker = call.speakers.get(userId);
    if (!speaker?.ready || this.ear(call) !== member) return;
    // The silence is already being given in real time; if the recogniser still holds the turn, it is closed.
    this.pumpSilence(speaker);
    clearTimeout(speaker.finalizer);
    speaker.finalizer = setTimeout(() => {
      if (speaker.open && speaker.inTurn) try { speaker.stt.finalize(); } catch {}
    }, FINALIZE_AFTER_MS);
  }

  personName(call, userId) {
    const any = call.members.values().next().value;
    const person = any?.link.client.voiceMembers(call.channelId).find((entry) => entry.userId === userId);
    return person?.name || "";
  }

  openSpeaker(call, member, userId) {
    const name = this.personName(call, userId) || "qualcuno";
    let stt;
    try {
      stt = this.fish.openStt({ sampleRate: SAMPLE_RATE, reference: `${call.channelId}:${userId}`.slice(0, 256), history: this.sttContext(call), terms: [...call.members.values()].map((entry) => entry.agent.name.slice(0, 32)).slice(0, 100) });
    } catch (error) {
      this.log({ type: "error", channelId: call.channelId, text: `voice: ${error.message}` });
      return null;
    }
    const speaker = { userId, name, ear: member.agent.id, channelId: call.channelId, stt, ready: false, open: true, queued: [], inTurn: false, lastAt: Date.now(), fedAt: 0, pump: null, lastSoundAt: 0, finalizer: null, bargeTimer: null, bargeAt: 0, early: null };
    call.speakers.set(userId, speaker);
    stt.on("speech_start", () => { speaker.inTurn = true; this.pendingBarge(call, speaker); });
    stt.on("user_turn_taken", () => this.pendingBarge(call, speaker));
    // The recogniser expects the turn to be over: the answer starts now, and is kept only if the words stay the same.
    stt.on("eager_end_of_turn", (event) => this.prepare(call, speaker, String(event.text || "").trim()));
    stt.on("turn_resumed", () => this.dropEarly(speaker));
    stt.on("committed", (event) => {
      speaker.inTurn = false;
      speaker.bargeAt = 0;
      clearTimeout(speaker.bargeTimer);
      speaker.bargeTimer = null;
      clearTimeout(speaker.finalizer);
      clearTimeout(speaker.bargeTimer);
      const text = String(event.text || "").trim();
      const early = speaker.early;
      speaker.early = null;
      if (event.user_turn === false || !text) return void early?.controller.abort();
      this.turn(call, { userId, name: speaker.name, text, agent: null }, early);
    });
    stt.on("failure", (error) => {
      speaker.open = false;
      clearTimeout(speaker.bargeTimer);
      clearInterval(speaker.pump);
      this.dropEarly(speaker);
      if (call.speakers.get(userId) === speaker) call.speakers.delete(userId);
      if (error.code !== "aborted") this.log({ type: "error", channelId: call.channelId, text: `voice: speech to text for ${name} stopped (${error.status || error.code})` });
    });
    stt.ready.then(() => {
      speaker.ready = true;
      for (const pcm of speaker.queued.splice(0)) this.feed(speaker, pcm);
      if (call.speaking) try { stt.setAgentSpeaking(true); } catch {}
    }).catch(() => {});
    this.log({ type: "voice", channelId: call.channelId, text: `ascolto ${name} nel canale vocale «${call.name}»` });
    return speaker;
  }

  closeSpeaker(call, speaker) {
    speaker.open = false;
    clearTimeout(speaker.finalizer);
    clearTimeout(speaker.bargeTimer);
    clearInterval(speaker.pump);
    this.dropEarly(speaker);
    if (call.speakers.get(speaker.userId) === speaker) call.speakers.delete(speaker.userId);
    speaker.stt.end().catch(() => {}).finally(() => speaker.stt.abort());
  }

  sttContext(call) {
    return call.history.slice(-8).map((turn) => ({ role: turn.agent ? "assistant" : "user", text: turn.text.slice(0, 2000) }));
  }

  /** A short "mm-hmm" does not cut an agent: it stops only if the person keeps talking over it. */
  pendingBarge(call, speaker) {
    if (!call.speaking && !call.thinking) return;
    clearTimeout(speaker.bargeTimer);
    if (!speaker.bargeAt) speaker.bargeAt = Date.now();
    speaker.bargeTimer = setTimeout(() => {
      speaker.bargeTimer = null;
      this.checkBarge(call, speaker);
    }, BARGE_MS);
    speaker.bargeTimer.unref?.();
  }

  /**
   * The cut is proven by sound: the person must have been talking for BARGE_MS and still be talking now.
   * The recogniser keeps its turn open after the words, so an open turn alone proves nothing.
   */
  checkBarge(call, speaker) {
    if (!call.speaking && !call.thinking) return;
    const since = speaker.bargeAt;
    if (!since) return;
    const talking = Date.now() - (speaker.lastSoundAt || 0) <= BARGE_SILENCE_MS;
    if (talking && Date.now() - since >= BARGE_MS) {
      speaker.bargeAt = 0;
      this.bargeIn(call, speaker);
      return;
    }
    // Still a murmur, or the sound stopped: look again only while the person keeps making sound.
    if (talking && Date.now() - since < BARGE_MS) {
      speaker.bargeTimer = setTimeout(() => {
        speaker.bargeTimer = null;
        this.checkBarge(call, speaker);
      }, BARGE_MS - (Date.now() - since));
      speaker.bargeTimer.unref?.();
      return;
    }
    speaker.bargeAt = 0;
  }

  /**
   * The answer to a turn the recogniser expects to be over, thought before the turn is committed.
   * Nothing is said or logged: the committed turn uses it only when its words and the call are unchanged.
   */
  prepare(call, speaker, text) {
    this.dropEarly(speaker);
    if (!text || (isNoise(text) && !this.askedQuestion(call)) || !this.calls.has(call.channelId)) return;
    const turn = { userId: speaker.userId, name: speaker.name, text, agent: null };
    const agent = this.responder(call, turn);
    if (!agent) return;
    const controller = new AbortController();
    const reply = this.think(agent, this.prompt(call, agent, turn), controller.signal);
    reply.catch(() => {});
    speaker.early = { key: sameWords(text), agentId: agent.id, history: call.history.length, last: call.history.at(-1), works: call.works.length, controller, reply, at: Date.now() };
  }

  dropEarly(speaker) {
    speaker.early?.controller.abort();
    speaker.early = null;
  }

  /** A prepared answer is still the right one: same words, same agent, nothing else said or started meanwhile. */
  earlyFits(call, early, turn, agent) {
    return Boolean(early && !early.controller.signal.aborted && early.agentId === agent.id && early.key === sameWords(turn.text)
      && early.history === call.history.length - 1 && early.last === call.history.at(-2) && early.works === call.works.length);
  }

  /** A person started talking over an agent: the agent stops, and what it was preparing is dropped. */
  bargeIn(call, speaker) {
    if (call.speaking) {
      this.log({ type: "voice", channelId: call.channelId, text: `${speaker.name} interrompe ${call.speaking.name}` });
      this.stopSpeaking(call);
    }
    if (call.thinking) call.thinking.controller.abort();
  }

  stopSpeaking(call) {
    const speaking = call.speaking;
    if (!speaking) return;
    call.speaking = null;
    speaking.tts?.abort();
    speaking.speech?.stop();
    this.setAgentSpeaking(call, false);
  }

  setAgentSpeaking(call, value) {
    for (const speaker of call.speakers.values()) {
      if (speaker.ready && speaker.open) try { speaker.stt.setAgentSpeaking(value); } catch {}
    }
  }

  /** Who answers what was just said: the agent named; for a person, otherwise the last agent who spoke. */
  responder(call, turn) {
    const agents = [...call.members.values()].map((member) => member.agent).filter((agent) => agent.id !== turn.agent?.id);
    if (!agents.length) return null;
    const named = namedAgent(turn.text, agents);
    if (turn.agent) {
      if (call.chain >= this.agentChain) return null;
      // An agent answers another only when named, or when it is the only other one in the call.
      return named || (agents.length === 1 ? agents[0] : null);
    }
    if (named) return named;
    const last = [...call.history].reverse().find((entry) => entry.agent && call.members.has(entry.agent.id));
    return last ? call.members.get(last.agent.id).agent : this.ear(call).agent;
  }

  turn(call, turn, early = null) {
    if (!this.calls.has(call.channelId)) return void early?.controller.abort();
    call.history.push({ ...turn, at: Date.now() });
    if (call.history.length > HISTORY) call.history.splice(0, call.history.length - HISTORY);
    if (!turn.agent) {
      call.chain = 0;
      call.lastHumanAt = Date.now();
    } else call.chain += 1;
    this.log({ type: "voice", agentId: turn.agent?.id, channelId: call.channelId, text: `[voce] ${turn.agent?.name || turn.name}: ${turn.text.slice(0, 300)}` });
    // A murmur or a test of the line is not a request: it neither cuts the agent nor is answered, and starts no work.
    if (!turn.agent && isNoise(turn.text) && !this.askedQuestion(call)) {
      this.log({ type: "voice", channelId: call.channelId, text: `[voce] ${turn.name}: ${turn.text.slice(0, 120)} (riscontro, ignorato)` });
      return void early?.controller.abort();
    }
    for (const speaker of call.speakers.values()) {
      if (speaker.ready && speaker.open && turn.agent) try { speaker.stt.addContext([{ role: "assistant", text: turn.text.slice(0, 2000) }]); } catch {}
    }
    const agent = this.responder(call, turn);
    const ready = agent && this.earlyFits(call, early, turn, agent) ? early : null;
    if (early && !ready) early.controller.abort();
    if (!agent) return;
    // One answer at a time: what is being prepared for an older turn gives way to the newer one.
    if (call.thinking) call.thinking.controller.abort();
    if (call.speaking && !turn.agent) this.stopSpeaking(call);
    this.answer(call, agent, ready).catch((error) => {
      if (error.name !== "AbortError" || error.message?.includes("timed out")) this.log({ type: "error", agentId: agent.id, channelId: call.channelId, text: `voice: ${error.message}` });
    });
  }

  /** A bare «ok» right after a question is the answer, not a murmur. */
  askedQuestion(call) {
    for (let index = call.history.length - 1; index >= 0; index -= 1) {
      const entry = call.history[index];
      if (entry.agent) return /[?]\s*$/.test(String(entry.text || "").trim());
    }
    return false;
  }

  prompt(call, agent, extra = null) {
    const others = [...call.members.values()].filter((member) => member.agent.id !== agent.id).map((member) => member.agent.name);
    const people = this.people(call).map((person) => person.name).filter(Boolean);
    const language = this.language(agent);
    const system = [
      `Sei ${agent.name}.`,
      agentPersona(agent) ? `## Chi sei\n${agentPersona(agent).slice(0, 2500)}` : "",
      agent.core?.trim() ? `## La tua scheda\n${agent.core.trim().slice(0, 3000)}` : "",
      [
        `## Ora`,
        `Sei in una chiamata vocale dal vivo su Discord, nel canale «${call.name}».`,
        `Nella chiamata: ${[...people, ...others].join(", ") || "nessun altro per ora"}${others.length ? ` (${others.join(", ")} ${others.length === 1 ? "è un agente" : "sono agenti"} come te)` : ""}.`,
        `Quello che scrivi viene detto subito ad alta voce dalla tua voce: rispondi con parole parlate, in ${language === "en" ? "inglese" : "italiano"} se non ti parlano in un'altra lingua, da una a tre frasi brevi.`,
        "Niente elenchi, markdown, link, emoji o didascalie: solo quello che diresti a voce. Non scrivere il tuo nome davanti alla risposta.",
        "Parli solo per te.",
        "Non confermare la tua presenza e non riempire i silenzi: mai «ci sono», «sono qui», «ti sento». Se non c'è niente da dire, PASS.",
        "Rispondi all'ultima richiesta e basta: non ripetere quello che hai già detto.",
        ...(this.dispatch ? [
          "In chiamata coordini il lavoro: parli e intanto lavori. Se una persona ti chiede un lavoro (cercare, controllare, scrivere, aggiustare, rilasciare…), non farlo a voce e non inventare risultati: di' in una frase breve che ci lavori, poi aggiungi in fondo una riga a parte che comincia con «LAVORO:» seguita dal compito completo e comprensibile da solo, come lo scriverebbe chi te lo chiede, con la sigla della issue se c'è (es. NOT-43). Cora lo porta nel thread di quella issue, altrimenti nella conversazione da cui sei entrato in chiamata. Quella riga non viene detta: diventa il compito che svolgi con tutti i tuoi strumenti mentre la chiamata continua, e lì scrivi i risultati.",
          "Se il lavoro è per un collega, in chiamata o fuori, scrivi «LAVORO per Nome:» e il compito va a lui.",
          "Non creare un lavoro se nessuno te l'ha chiesto o se è già tra quelli avviati: una richiesta uguale a una già avviata non si riapre.",
        ] : ["In chiamata non puoi usare strumenti né fare lavori: se ti chiedono un lavoro, dillo e proponi di scriverlo in chat."]),
        ...(call.works.length ? [`Lavori già avviati da questa chiamata (li svolgete nella conversazione scritta):\n${call.works.slice(-8).map((work) => `- ${work.agentName}, per ${work.by}: ${work.task.slice(0, 200)}`).join("\n")}`] : []),
        "Se una persona vi chiede di uscire o di staccarvi dalla chiamata, saluta in poche parole e aggiungi in fondo una riga a parte con «ESCI».",
        "Se la frase non era per te o non hai niente da aggiungere, rispondi esattamente PASS.",
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
    const lines = [...call.history, ...(extra ? [extra] : [])].map((entry) => entry.agent?.id === agent.id ? `Tu: ${entry.text}` : `${entry.agent?.name || entry.name}: ${entry.text}`);
    const prompt = `Conversazione finora (l'ultima frase è la più recente):\n${lines.join("\n")}\n\nLa tua risposta a voce:`;
    return { system, prompt };
  }

  /**
   * The model an agent answers with in a call: the one chosen for voice, else its own when it answers in
   * one quick request, else the space's default one; an agentic CLI only when nothing quicker exists.
   */
  voiceModel(agent) {
    const settings = this.store.settings;
    const quick = (model) => model && !this.llm.isAgentic(model);
    return agent.voiceModel || settings.voiceModel || [agent.model, settings.defaultModel].find(quick) || agent.model || settings.defaultModel;
  }

  async think(agent, { system, prompt }, signal) {
    const model = this.voiceModel(agent);
    const timeout = AbortSignal.timeout(REPLY_TIMEOUT_MS);
    const both = AbortSignal.any([signal, timeout]);
    if (this.llm.isAgentic(model)) {
      const result = await this.llm.runAgent({ model, subscriptionId: agent.subscriptionId || undefined, credentialId: agent.credentialId || "", system, prompt, tools: [], execute: null, timeoutMs: REPLY_TIMEOUT_MS, effort: "low", signal: both, host: agent.ollamaHost || "" });
      return result.text;
    }
    const result = await this.llm.chat({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], tools: [], effort: "low", signal: both, host: agent.ollamaHost || "" });
    return result.text;
  }

  async answer(call, agent, early = null) {
    const controller = early?.controller || new AbortController();
    const thinking = { agentId: agent.id, controller };
    call.thinking = thinking;
    const started = Date.now();
    const ahead = early ? started - early.at : null;
    // A job, or leaving, comes only from a person: what was asked, by whom, in the last human words.
    const asker = [...call.history].reverse().find((entry) => !entry.agent);
    const lastIsHuman = Boolean(call.history.at(-1) && !call.history.at(-1).agent);
    let text;
    let reply;
    let leaving = false;
    try {
      const raw = String(await (early ? early.reply : this.think(agent, this.prompt(call, agent), controller.signal)) || "");
      leaving = lastIsHuman && LEAVE_LINE.test(raw);
      reply = splitWork(raw.replace(new RegExp(LEAVE_LINE.source, "gim"), ""));
      text = spokenReply(reply.said, agent.name);
    } finally {
      if (call.thinking === thinking) call.thinking = null;
    }
    if (controller.signal.aborted) return;
    if (reply.task && this.dispatch && lastIsHuman && asker) {
      this.startWork(call, agent, asker, reply.task, reply.for);
      if (!text) text = this.language(agent) === "en" ? "On it." : "Ci lavoro.";
    }
    const member = call.members.get(agent.id);
    if (!text) {
      if (leaving && member) return void await this.leave(agent);
      this.log({ type: "voice", agentId: agent.id, channelId: call.channelId, text: `${agent.name} non risponde (PASS, pensato in ${((Date.now() - started) / 1000).toFixed(1)} s)` });
      return;
    }
    if (!member || !this.calls.has(call.channelId)) return;
    await this.speak(call, member, text, Date.now() - started, ahead);
    // Asked by a person to leave: it says goodbye, then goes.
    if (leaving && call.members.get(agent.id) === member) await this.leave(agent);
  }


  /** The job goes to the agent's written conversation as the person's own request: their permissions, the agent's tools. */
  startWork(call, agent, asker, task, workerName = "") {
    const member = call.members.get(agent.id);
    if (!member) return;
    const wanted = fold(workerName).trim();
    const worker = (wanted && (this.store.agents?.() || []).find((entry) => entry.enabled !== false && fold(entry.name) === wanted)) || agent;
    const key = workKey(task);
    const again = call.works.find((entry) => entry.agentId === worker.id && sameWork(entry.key, key) && Date.now() - entry.at < WORK_DEDUPE_MS);
    if (again) {
      this.log({ type: "voice", agentId: worker.id, channelId: call.channelId, text: `${worker.name} ha già questo lavoro, aperto ${Math.round((Date.now() - again.at) / 1000)} s fa: non lo riapro (${task.slice(0, 200)})` });
      return;
    }
    const work = { key, agentId: worker.id, agentName: worker.name, by: asker.name, byId: asker.userId, task, said: asker.text, at: Date.now(), channelId: member.origin || call.channelId };
    call.works.push(work);
    if (call.works.length > 20) call.works.shift();
    const who = worker === agent ? `${agent.name} prende` : `${agent.name} passa a ${worker.name}`;
    this.log({ type: "voice", agentId: worker.id, channelId: call.channelId, text: `${who} un lavoro dalla chiamata per ${asker.name}: ${task.slice(0, 300)}` });
    Promise.resolve()
      .then(() => this.dispatch({ agent: worker, from: agent, channelId: work.channelId, speakerId: asker.userId, speakerName: asker.name, said: asker.text, task, callName: call.name, callChannelId: call.channelId }))
      .catch((error) => this.log({ type: "error", agentId: agent.id, channelId: call.channelId, text: `voice: work not started (${error.message})` }));
  }

  /** How fast the voice speaks: the agent's own, else the space's, else the measured default. */
  speechSpeed(agent) {
    const wanted = Number(agent?.voiceSpeed ?? this.store?.settings?.voiceSpeed ?? SPEECH_SPEED);
    return Number.isFinite(wanted) && wanted >= 0.5 && wanted <= 2 ? wanted : SPEECH_SPEED;
  }

  async speak(call, member, text, thoughtMs = 0, aheadMs = null) {
    this.stopSpeaking(call);
    const { agent, link } = member;
    const tts = this.fish.openTts({ voice: member.voice, language: this.language(agent), latency: "balanced", speed: this.speechSpeed(agent) });
    const speaking = { agentId: agent.id, name: agent.name, tts, speech: null, text };
    call.speaking = speaking;
    this.setAgentSpeaking(call, true);
    const started = Date.now();
    let firstAudio = 0;
    try {
      const speech = link.speak();
      speaking.speech = speech;
      tts.on("audio", (pcm) => {
        if (!firstAudio) firstAudio = Date.now() - started;
        if (call.speaking === speaking) speech.write(pcm);
      });
      await tts.ready;
      tts.sendText(text);
      tts.flush();
      await tts.end();
      speech.end();
      const how = await speech.done;
      if (call.speaking !== speaking) return;
      call.speaking = null;
      this.setAgentSpeaking(call, false);
      this.log({ type: "voice", agentId: agent.id, channelId: call.channelId, text: `${agent.name} ha parlato (pensato in ${(thoughtMs / 1000).toFixed(1)} s${aheadMs !== null ? `, iniziato ${(aheadMs / 1000).toFixed(1)} s prima della fine del turno` : ""}, prima voce dopo ${(firstAudio / 1000).toFixed(1)} s, ${how})` });
      // Words that were fully said become a turn the others hear.
      if (how === "played") this.turn(call, { userId: member.userId, name: agent.name, text, agent });
    } catch (error) {
      if (call.speaking === speaking) {
        call.speaking = null;
        speaking.speech?.stop();
        this.setAgentSpeaking(call, false);
      }
      if (error.code !== "aborted") throw new Error(`${agent.name} could not speak: ${error.status || error.code || error.message}`);
    }
  }

  /** Speakers gone quiet for long are closed; a call with no person left for a while ends. */
  sweep() {
    const now = Date.now();
    for (const call of [...this.calls.values()]) {
      for (const speaker of [...call.speakers.values()]) if (now - speaker.lastAt > IDLE_SPEAKER_MS && !speaker.inTurn) this.closeSpeaker(call, speaker);
      if (this.people(call).length) call.lastHumanAt = Math.max(call.lastHumanAt, now - 1);
      else if (now - call.lastHumanAt > EMPTY_CALL_MS) {
        for (const member of [...call.members.values()]) this.leave(member.agent).catch(() => {});
      }
    }
  }

  stop() {
    clearInterval(this.sweeper);
    for (const call of [...this.calls.values()]) for (const member of [...call.members.values()]) this.leave(member.agent).catch(() => {});
  }
}
