import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import prism from "prism-media";
import { OpusDecoder, VoiceLink } from "../src/discord-voice.js";

const options = { rate: 48000, channels: 2, frameSize: 960 };
async function packet() {
  const encoder = new prism.opus.Encoder(options);
  const encoded = once(encoder, "data");
  encoder.end(Buffer.alloc(3840));
  return (await encoded)[0];
}

test("Opus decoder preserves audio and completion across an invalid packet", async () => {
  const valid = await packet();
  const decoder = new OpusDecoder(options);
  const frames = [];
  let dropped = 0;
  decoder.on("data", (data) => frames.push(data));
  decoder.on("packetDropped", () => dropped++);
  const ended = once(decoder, "end");
  decoder.write(valid);
  decoder.write(Buffer.from([0x03]));
  decoder.end(valid);
  await ended;
  assert.equal(dropped, 1);
  assert.deepEqual(frames.map((frame) => frame.length), [3840, 3840]);
  assert.equal(decoder.readableEnded, true);
});

test("Opus decoder keeps unexpected decoder failures visible", async () => {
  const decoder = new OpusDecoder(options);
  decoder._decode = () => { throw new Error("decoder unavailable"); };
  const failed = once(decoder, "error");
  decoder.end(Buffer.from([0x03]));
  assert.equal((await failed)[0].message, "decoder unavailable");
  assert.equal(decoder.destroyed, true);
});

test("Voice receive reaches quiet after a damaged packet and subsequent audio", async () => {
  const valid = await packet();
  const input = new PassThrough({ objectMode: true });
  const errors = [];
  const audio = [];
  const link = new VoiceLink({ client: { user: { id: "nico" } }, log: (error) => errors.push(error) });
  link.connection = { receiver: { subscriptions: new Map(), subscribe: () => input } };
  link.on("audio", (userId, pcm) => audio.push({ userId, bytes: pcm.length }));
  const quiet = once(link, "quiet");
  link.hear("seb");
  input.write(valid);
  input.write(Buffer.from([0x03]));
  input.end(valid);
  assert.deepEqual(await quiet, ["seb"]);
  assert.deepEqual(audio, [{ userId: "seb", bytes: 1920 }, { userId: "seb", bytes: 1920 }]);
  assert.deepEqual(errors, []);
});
