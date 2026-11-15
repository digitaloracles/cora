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
// When a speaker goes quiet, the speech to text is given this much silence at once to close the turn.
const TAIL_MS = 1600;
const FINALIZE_AFTER_MS = 2500;
const IDLE_SPEAKER_MS = 120000;
const EMPTY_CALL_MS = 180000;
const REPLY_TIMEOUT_MS = 45000;

const fold = (text) => String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    this.lastHumanAt = Date.now();
    this.startedAt = Date.now();
  }
}

export class VoiceCalls {
  constructor({ store, bots, llm, fish, log = () => {}, emit = () => {}, language = () => "it", makeLink = (options) => new VoiceLink(options), agentChain = AGENT_CHAIN }) {
    this.store = store;
    this.bots = bots;
    this.llm = llm;
    this.fish = fish;
    this.log = log;
    this.emit = emit;
    this.language = language;
    this.makeLink = makeLink;
    this.agentChain = agentChain;
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
  async join(agent, { channelId = "", requesterId = "", allowedGuild = () => true } = {}) {
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
    if (current?.channelId === target) return this.where(current, agent);
    if (current) await this.leave(agent);
    let call = this.calls.get(target);
    if (!call) {
      call = new Call({ guildId: info.guildId, channelId: target, name: info.name });
      this.calls.set(target, call);
    }
    const link = this.makeLink({ client, guildId: info.guildId, channelId: target, log: (text) => this.log({ type: "error", agentId: agent.id, channelId: target, text }) });
    const member = { agent, link, userId: client.user.id, voice: fishVoiceFor(agent, [...call.members.values()].map((entry) => entry.voice)), joinedAt: Date.now() };
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
    clearTimeout(speaker.finalizer);
    if (speaker.ready) this.feed(speaker, pcm);
    else speaker.queued.push(pcm);
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
    // Discord stops sending when someone stops talking: the silence is given at once, so the turn can close.
    this.feed(speaker, Buffer.alloc(Math.round(SAMPLE_RATE * TAIL_MS / 1000) * 2));
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
    const speaker = { userId, name, ear: member.agent.id, channelId: call.channelId, stt, ready: false, open: true, queued: [], inTurn: false, lastAt: Date.now(), finalizer: null };
    call.speakers.set(userId, speaker);
    stt.on("speech_start", () => { speaker.inTurn = true; });
    stt.on("user_turn_taken", () => this.bargeIn(call, speaker));
    stt.on("committed", (event) => {
      speaker.inTurn = false;
      clearTimeout(speaker.finalizer);
      const text = String(event.text || "").trim();
      if (event.user_turn === false || !text) return;
      this.turn(call, { userId, name: speaker.name, text, agent: null });
    });
    stt.on("failure", (error) => {
      speaker.open = false;
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
    if (call.speakers.get(speaker.userId) === speaker) call.speakers.delete(speaker.userId);
    speaker.stt.end().catch(() => {}).finally(() => speaker.stt.abort());
  }

  sttContext(call) {
    return call.history.slice(-8).map((turn) => ({ role: turn.agent ? "assistant" : "user", text: turn.text.slice(0, 2000) }));
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

  turn(call, turn) {
    if (!this.calls.has(call.channelId)) return;
    call.history.push({ ...turn, at: Date.now() });
    if (call.history.length > HISTORY) call.history.splice(0, call.history.length - HISTORY);
    if (!turn.agent) {
      call.chain = 0;
      call.lastHumanAt = Date.now();
    } else call.chain += 1;
    this.log({ type: "voice", agentId: turn.agent?.id, channelId: call.channelId, text: `[voce] ${turn.agent?.name || turn.name}: ${turn.text.slice(0, 300)}` });
    for (const speaker of call.speakers.values()) {
      if (speaker.ready && speaker.open && turn.agent) try { speaker.stt.addContext([{ role: "assistant", text: turn.text.slice(0, 2000) }]); } catch {}
    }
    const agent = this.responder(call, turn);
    if (!agent) return;
    // One answer at a time: what is being prepared for an older turn gives way to the newer one.
    if (call.thinking) call.thinking.controller.abort();
    if (call.speaking && !turn.agent) this.stopSpeaking(call);
    this.answer(call, agent).catch((error) => {
      if (error.name !== "AbortError") this.log({ type: "error", agentId: agent.id, channelId: call.channelId, text: `voice: ${error.message}` });
    });
  }

  prompt(call, agent) {
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
        "Parli solo per te. In chiamata non puoi usare strumenti né fare lavori: se ti chiedono un lavoro, dillo e proponi di scriverlo in chat.",
        "Se la frase non era per te o non hai niente da aggiungere, rispondi esattamente PASS.",
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
    const lines = call.history.map((entry) => entry.agent?.id === agent.id ? `Tu: ${entry.text}` : `${entry.agent?.name || entry.name}: ${entry.text}`);
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

  async answer(call, agent) {
    const controller = new AbortController();
    const thinking = { agentId: agent.id, controller };
    call.thinking = thinking;
    const started = Date.now();
    let text;
    try {
      text = spokenReply(await this.think(agent, this.prompt(call, agent), controller.signal), agent.name);
    } finally {
      if (call.thinking === thinking) call.thinking = null;
    }
    if (controller.signal.aborted || !text) return;
    const member = call.members.get(agent.id);
    if (!member || !this.calls.has(call.channelId)) return;
    await this.speak(call, member, text, Date.now() - started);
  }

  async speak(call, member, text, thoughtMs = 0) {
    this.stopSpeaking(call);
    const { agent, link } = member;
    const tts = this.fish.openTts({ voice: member.voice, language: this.language(agent), latency: "balanced" });
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
      this.log({ type: "voice", agentId: agent.id, channelId: call.channelId, text: `${agent.name} ha parlato (pensato in ${(thoughtMs / 1000).toFixed(1)} s, prima voce dopo ${(firstAudio / 1000).toFixed(1)} s, ${how})` });
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
