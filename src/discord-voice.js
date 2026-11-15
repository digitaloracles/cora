import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel } from "@discordjs/voice";
import prism from "prism-media";

/** Discord voice is 48 kHz stereo: 20 ms is 960 samples a channel. */
export const DISCORD_RATE = 48000;
const FRAME_SAMPLES = 960;
const SILENCE_AFTER_MS = 1000;

/**
 * Speech at 24 kHz mono turned into Discord's 48 kHz stereo, chunk after chunk: the last sample of
 * one chunk is carried to the next, so streamed speech has no seam where two chunks meet.
 */
export class Upsampler {
  constructor() {
    this.last = null;
    this.odd = null;
  }

  push(chunk) {
    let pcm = Buffer.from(chunk);
    if (this.odd) {
      pcm = Buffer.concat([this.odd, pcm]);
      this.odd = null;
    }
    if (pcm.length % 2) {
      this.odd = pcm.subarray(pcm.length - 1);
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    const samples = pcm.length / 2;
    if (!samples) return Buffer.alloc(0);
    const out = Buffer.alloc(samples * 8);
    let previous = this.last ?? pcm.readInt16LE(0);
    for (let i = 0; i < samples; i += 1) {
      const sample = pcm.readInt16LE(i * 2);
      const middle = (previous + sample) >> 1;
      out.writeInt16LE(middle, i * 8);
      out.writeInt16LE(middle, i * 8 + 2);
      out.writeInt16LE(sample, i * 8 + 4);
      out.writeInt16LE(sample, i * 8 + 6);
      previous = sample;
    }
    this.last = previous;
    return out;
  }
}

/** Discord's 48 kHz stereo as 48 kHz mono, the shape speech to text reads. */
export function toMono(stereo) {
  const frames = Math.floor(stereo.length / 4);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) out.writeInt16LE((stereo.readInt16LE(i * 4) + stereo.readInt16LE(i * 4 + 2)) >> 1, i * 2);
  return out;
}

/** Loudest sample of 16-bit PCM: tells speech from a stream of silence. */
export function peakOf(pcm) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  return peak;
}

export class OpusDecoder extends prism.opus.Decoder {
  _transform(chunk, encoding, done) {
    super._transform(chunk, encoding, (error) => {
      if (error?.message === "Decode error: Invalid packet") {
        this.emit("packetDropped");
        done();
      } else done(error);
    });
  }
}

/**
 * One agent's bot in one Discord voice channel, through that bot's own gateway connection:
 * it hears every participant on a stream of their own (decrypted, DAVE included, and decoded
 * to 48 kHz mono PCM) and speaks streamed 24 kHz mono PCM. Each bot joins in its own group,
 * so several agents of this Cora sit in the same channel at once.
 */
export class VoiceLink extends EventEmitter {
  constructor({ client, guildId, channelId, log = () => {}, join = joinVoiceChannel }) {
    super();
    this.client = client;
    this.guildId = guildId;
    this.channelId = channelId;
    this.log = log;
    this.join = join;
    this.connection = null;
    this.player = null;
    this.playing = null;
    this.closed = false;
    this.handlers = [];
    this.drops = 0;
    this.lastAudioAt = new Map();
    this.lastSpeakingAt = new Map();
  }

  get userId() {
    return this.client.user?.id || "";
  }

  async open(timeoutMs = 20000) {
    if (!this.client.user) throw new Error("the agent's bot is not connected to Discord");
    let adapter = null;
    const onState = (data) => {
      if (data.guild_id === this.guildId && data.user_id === this.client.user?.id) adapter?.onVoiceStateUpdate(data);
    };
    const onServer = (data) => {
      if (data.guild_id === this.guildId) adapter?.onVoiceServerUpdate(data);
    };
    this.client.on("voiceState", onState);
    this.client.on("voiceServer", onServer);
    this.handlers = [["voiceState", onState], ["voiceServer", onServer]];
    this.bindConnection(this.join({
      channelId: this.channelId,
      guildId: this.guildId,
      group: this.client.user.id,
      selfDeaf: false,
      selfMute: false,
      adapterCreator: (methods) => {
        adapter = methods;
        return { sendPayload: (payload) => this.client.gatewaySend(payload), destroy: () => { adapter = null; } };
      },
    }));
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, timeoutMs);
    } catch (error) {
      this.close("timeout");
      throw new Error(`could not join the voice channel within ${Math.round(timeoutMs / 1000)} s`);
    }
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on("error", (error) => this.log(`voice player: ${error.message}`));
    this.connection.subscribe(this.player);
    this.connection.receiver.speaking.on("start", (userId) => {
      this.lastSpeakingAt.set(String(userId), Date.now());
      this.emit("speaking", userId);
      this.hear(userId);
    });
    return this;
  }

  /** Connection state, ping and decode failures: enough to tell a dead pipe from a quiet person. */
  listenHealth() {
    const status = this.connection?.state?.status || (this.closed ? "closed" : "absent");
    let ws = null;
    let udp = null;
    try {
      const ping = this.connection?.ping;
      if (Number.isFinite(ping?.ws)) ws = Math.round(ping.ws);
      if (Number.isFinite(ping?.udp)) udp = Math.round(ping.udp);
    } catch { /* ping exists only while the voice connection is ready */ }
    return {
      status,
      ws,
      udp,
      subscriptions: this.connection?.receiver?.subscriptions?.size || 0,
      drops: this.drops,
    };
  }

  bindConnection(connection) {
    this.connection = connection;
    connection.on("error", (error) => this.log(`voice connection: ${error.message}`));
    connection.on("stateChange", (before, after) => {
      if (before.status !== after.status) this.emit("connection", before.status, after.status);
      if (after.status === VoiceConnectionStatus.Disconnected && !this.closed) {
        // Moved or kicked: give Discord a moment to reconnect us, otherwise the call is over for this bot.
        Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]).catch(() => this.close("disconnected"));
      }
      if (after.status === VoiceConnectionStatus.Destroyed && !this.closed) this.close("destroyed");
    });
    return connection;
  }

  hear(userId) {
    const receiver = this.connection?.receiver;
    if (!receiver || this.closed || userId === this.userId || receiver.subscriptions.has(userId)) return;
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_AFTER_MS } });
    const decoder = new OpusDecoder({ rate: DISCORD_RATE, channels: 2, frameSize: FRAME_SAMPLES });
    opus.on("error", (error) => this.log(`voice receive ${userId}: ${error.message}`));
    decoder.on("error", (error) => this.log(`voice decode ${userId}: ${error.message}`));
    decoder.on("packetDropped", () => { this.drops += 1; });
    opus.pipe(decoder);
    decoder.on("data", (stereo) => {
      this.lastAudioAt.set(String(userId), Date.now());
      this.emit("audio", userId, toMono(stereo));
    });
    decoder.on("end", () => this.emit("quiet", userId));
  }

  /**
   * Starts speaking: write 24 kHz mono PCM as it arrives, then end(). stop() cuts it off at once.
   * `done` settles when the last sample has been played or the speech was stopped.
   */
  speak() {
    if (!this.player || this.closed) throw new Error("not in a voice channel");
    this.playing?.stop();
    const stream = new PassThrough({ highWaterMark: DISCORD_RATE * 4 * 30 });
    const upsampler = new Upsampler();
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    let stopped = false;
    let started = false;
    const finish = (how) => {
      this.player?.off("stateChange", onState);
      if (this.playing === speech) this.playing = null;
      settle(how);
    };
    const onState = (before, after) => {
      if (after.status === AudioPlayerStatus.Playing) started = true;
      if (after.status === AudioPlayerStatus.Idle && started) finish(stopped ? "stopped" : "played");
    };
    const speech = {
      write: (pcm) => {
        if (stopped || !pcm?.length) return;
        stream.write(upsampler.push(pcm));
        if (!started && this.player.state.resource !== resource) this.player.play(resource);
      },
      end: () => {
        if (!stopped) stream.end();
        if (!started && this.player.state.resource !== resource) finish("empty");
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        stream.destroy();
        if (this.player?.state.resource === resource) this.player.stop(true);
        else finish("stopped");
      },
      done,
    };
    this.player.on("stateChange", onState);
    this.playing = speech;
    return speech;
  }

  get speaking() {
    return Boolean(this.playing);
  }

  close(reason = "left") {
    if (this.closed) return;
    this.closed = true;
    this.playing?.stop();
    for (const [event, handler] of this.handlers) this.client.off(event, handler);
    this.handlers = [];
    try { this.player?.stop(true); } catch {}
    try { this.connection?.destroy(); } catch {}
    this.emit("closed", reason);
  }
}
