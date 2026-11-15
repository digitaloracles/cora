import test from "node:test";
import assert from "node:assert/strict";
import { VoiceCalls, isNoise, workKey, sameWork, splitWork } from "../src/voice-calls.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agent = { id: "a1", name: "Ada", gender: "female", core: "organizzo il banco" };

function calls(dispatch = async () => {}) {
  const logs = [];
  const app = new VoiceCalls({
    store: { settings: {}, agents: () => [agent, { id: "a2", name: "Nico" }] },
    bots: {},
    llm: {},
    fish: {},
    log: (entry) => logs.push(entry),
    dispatch,
  });
  return { app, logs };
}

function call(works = []) {
  const member = { agent, voice: "v", origin: "", link: { client: { voiceMembers: () => [{ userId: "900", name: "Seb" }] } } };
  return { channelId: "1", name: "Cora voice", members: new Map([[agent.id, member]]), speakers: new Map(), works, history: [], speaking: null, thinking: null, chain: 0 };
}

const asker = { userId: "900", name: "Seb", text: "Ada, controlla il rilascio di NOT-43" };

test("a murmur, a greeting or a test of the line is not a request", () => {
  for (const text of ["mm", "Mm-hmm.", "ok", "okay va bene", "Grazie mille", "ci sono", "sono qui", "ti sento", "pronto?", "mi sentite", "Ascolta.", "test"]) {
    assert.equal(isNoise(text), true, `"${text}" is noise`);
  }
  for (const text of ["staccatevi", "Ada, controlla il rilascio di NOT-43", "Ascolta il rilascio di stamattina", "perché la voce è lenta?", "mi sentite anche ora che sono in macchina?"])
    assert.equal(isNoise(text), false, `"${text}" is a request`);
});

test("a refusal or a request to wait is never mistaken for a murmur", () => {
  for (const text of ["no", "No.", "no aspetta", "non ancora", "fermati", "stop", "basta così"])
    assert.equal(isNoise(text), false, `"${text}" changes what the agents do`);
});

test("the same job asked twice looks the same", () => {
  assert.equal(workKey("Controlla il rilascio di NOT-43, per favore!"), workKey("controlla il rilascio di NOT 43 per favore"));
  assert.notEqual(workKey("Controlla il rilascio"), workKey("Misura la latenza"));
});

test("a job already open is not opened again, a new one is", async () => {
  const sent = [];
  const { app, logs } = calls(async (work) => sent.push(work));
  const target = call();
  app.startWork(target, agent, asker, "Controlla il rilascio di NOT-43");
  await sleep(20);
  app.startWork(target, agent, { ...asker, text: "Ascolta" }, "controlla il rilascio di NOT-43, per favore");
  await sleep(20);
  assert.equal(sent.length, 1, "the repeated request does not start a second job");
  assert.ok(logs.some((entry) => /ha già questo lavoro/.test(entry.text)));
  app.startWork(target, agent, asker, "Misura la latenza della voce");
  await sleep(20);
  assert.equal(sent.length, 2, "a different job starts");
});

test("a job whose asker was a murmur does not start: noise never reaches the request path", () => {
  const target = call();
  const { app } = calls();
  // turn() drops a noise line before any agent is chosen: nothing is dispatched and nothing is spoken.
  const spoken = [];
  app.answer = async (cc, who) => spoken.push(who.name);
  target.history = [];
  app.turn(target, { userId: "900", name: "Seb", text: "mi sentite", agent: null });
  assert.deepEqual(spoken, [], "nobody answers a test of the line");
});

test("a short murmur does not cut the agent who is talking", async () => {
  const { app } = calls();
  const target = call();
  const speaker = { userId: "900", name: "Seb", inTurn: true, bargeTimer: null, bargeAt: 0, lastSoundAt: Date.now() };
  target.speaking = { agentId: agent.id, name: "Ada", tts: { abort() {} }, speech: { stop() {} } };
  app.pendingBarge(target, speaker);
  await sleep(900);
  assert.ok(target.speaking, "300 ms of sound and then silence is a murmur, not an interruption");
  assert.equal(speaker.bargeAt, 0);
});

test("a person who keeps talking over the agent does cut it, once", async () => {
  const { app, logs } = calls();
  const target = call();
  const speaker = { userId: "900", name: "Seb", inTurn: true, bargeTimer: null, bargeAt: 0, lastSoundAt: Date.now() };
  target.speaking = { agentId: agent.id, name: "Ada", tts: { abort() {} }, speech: { stop() {} } };
  app.pendingBarge(target, speaker);
  const sound = setInterval(() => { speaker.lastSoundAt = Date.now(); }, 100);
  await sleep(1000);
  clearInterval(sound);
  assert.equal(target.speaking, null, "one second of continuous speech stops the agent");
  assert.ok(logs.some((entry) => /interrompe/.test(entry.text)));
  assert.equal(speaker.bargeAt, 0, "and the interruption is spent, not repeated");
});

test("a turn the recogniser leaves open, with no sound behind it, never cuts", async () => {
  const { app } = calls();
  const target = call();
  const speaker = { userId: "900", name: "Seb", inTurn: true, bargeTimer: null, bargeAt: 0, lastSoundAt: Date.now() };
  target.speaking = { agentId: agent.id, name: "Ada", tts: { abort() {} }, speech: { stop() {} } };
  app.pendingBarge(target, speaker);
  await sleep(1800);
  assert.ok(target.speaking, "an open turn is not proof the person is still talking");
});

test("the voice speaks at the measured pace, and the pace can be chosen without a deploy", () => {
  const { app } = calls();
  assert.equal(app.speechSpeed(agent), 1.7);
  assert.equal(app.speechSpeed({ ...agent, voiceSpeed: 1.45 }), 1.45);
  app.store.settings.voiceSpeed = 1.2;
  assert.equal(app.speechSpeed({ id: "a3", name: "Nico" }), 1.2);
  assert.equal(app.speechSpeed({ ...agent, voiceSpeed: 9 }), 1.7, "an impossible value falls back to the default");
});

test("the call prompt keeps the agents from filler confirmations", () => {
  const { app } = calls();
  const prompt = app.prompt(call(), agent);
  assert.match(prompt.system, /mai «ci sono»/);
  assert.match(prompt.system, /non si riapre/);
  assert.match(prompt.system, /ESCI/);
});

test("the LAVORO line is never spoken, and the job keeps its text", () => {
  const { said, task } = splitWork("Ci lavoro.\nLAVORO: Controlla i log della chiamata per NOT-43");
  assert.equal(said.trim(), "Ci lavoro.");
  assert.equal(task, "Controlla i log della chiamata per NOT-43");
});

test("«staccatevi» said by a person makes the agent say goodbye and leave the call", async () => {
  const { app } = calls();
  const target = call();
  const said = [];
  const left = [];
  app.calls.set(target.channelId, target);
  app.think = async () => "Va bene, stacco.\nESCI.";
  app.speak = async (cc, member, text) => said.push(text);
  app.leave = async (who) => left.push(who.name);
  target.history.push({ userId: "900", name: "Seb", text: "Staccatevi", agent: null });
  await app.answer(target, agent);
  assert.deepEqual(said, ["Va bene, stacco."], "it says goodbye, and ESCI is never spoken");
  assert.deepEqual(left, ["Ada"], "then it leaves");
});

test("a job is not taken on when it was not a person asking", async () => {
  const sent = [];
  const { app } = calls(async (work) => sent.push(work));
  const target = call();
  app.think = async () => "Ci lavoro.\nLAVORO: Controlla il rilascio di NOT-43";
  app.speak = async () => {};
  target.history.push({ agent, name: "Ada", text: "Dico io una cosa", agent: { id: "a2" } });
  await app.answer(target, agent);
  assert.deepEqual(sent, [], "an agent's own words start no job");
});

test("a bare «ok» after a question is the answer, not a murmur", () => {
  const { app } = calls();
  const target = call();
  const spoken = [];
  app.calls.set(target.channelId, target);
  app.answer = async (cc, who) => spoken.push(who.name);
  target.history.push({ agent, name: "Ada", text: "Lo rilascio adesso?", at: 1 });
  app.turn(target, { userId: "900", name: "Seb", text: "ok", agent: null });
  assert.deepEqual(spoken, ["Ada"], "a confirmation after a question reaches the agent");
});

test("one changed word is a different job", () => {
  assert.equal(sameWork(workKey("controlla il rilascio di NOT-43"), workKey("controlla il rilascio di NOT-44")), false);
  assert.equal(sameWork(workKey("verifica il DNS di catania"), workKey("verifica il DNS di ragusa")), false);
});

test("a number that only starts the same is a different job", () => {
  const same = (one, other) => sameWork(workKey(one), workKey(other));
  assert.equal(same("controlla il rilascio di NOT-4", "controlla il rilascio di NOT-43"), false);
  assert.equal(same("rilancia la build 12", "rilancia la build 123"), false);
  assert.equal(same("controlla il rilascio di NOT-43", "controlla il rilascio di NOT-43, per favore"), true);
});
