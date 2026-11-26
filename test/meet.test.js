import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { fakeSoniox, tempHome } from "./helpers.js";
import { Voice } from "../src/voice.js";
import { captionTurns, Meet } from "../src/meet.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";
import { rmSync } from "node:fs";
import { privateRoom } from "../src/rooms.js";

test("Meet actions enforce agent and folder access and deliver a reviewed transcript to private chat", async (t) => {
  const f = await knowledgeWorld();
  t.after(f.close);
  const { meet, boxes, store, artifacts, orchestrator } = f.app;
  const agent = store.createAgent({ name: "Meeting assistant", brainOwnerId: f.alice.user.id, tools: true, enabled: true, model: "ollama/test-model" });
  const path = "/api/agents/" + agent.id + "/meet";
  const call = (action, body = {}, actor = f.alice, method = "POST") => f.request(actor, path + action, { method, body });
  const target = artifacts.createFolder({ path: "meetings/qa", createdBy: { kind: "user", id: f.alice.user.id } });
  artifacts.createFolder({ path: "meetings/foreign", createdBy: { kind: "user", id: f.bob.user.id } });
  assert.equal((await f.request(f.bob, path)).status, 403);
  const settings = await call("", { enabled: true }, f.alice, "PUT");
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.data.folders.map((item) => item.id), [target.id]);
  const commands = [];
  let email = "", state, transcript, now = Date.now();
  boxes.ensure = async () => {};
  boxes.meet = async (id, [command]) => {
    assert.equal(id, agent.id);
    commands.push(command);
    if (command === "account") return { email };
    if (command === "state") return state;
    if (command === "captions") return { captions: [{ at: 0, speaker: "QA host", text: "First sentence.", block: 1 }, { at: 25, speaker: "QA host", text: "Second sentence.", block: 2 }] };
    return {};
  };
  boxes.writeFile = async (_agent, _path, bytes) => { transcript = bytes; };
  boxes.artifactManifest = async () => ({ root: "call", files: [{ path: "transcript.md", size: transcript.length, sha256: createHash("sha256").update(transcript).digest("hex") }], refused: [], skipped: [] });
  boxes.artifactSend = async (_agent, _root, _files, open) => { const writer = open(0); writer.write(transcript); writer.end(); };
  const input = { link: "https://meet.google.com/abc-defg-hij", folder: target.path, channelId: "attacker", memberUserId: f.bob.user.id };
  assert.equal((await call("/signin")).status, 200);
  assert.equal((await call("/join", input)).status, 409);
  email = "agent@example.test";
  assert.equal((await call("/account")).data.account.email, email);
  assert.equal((await call("/join", { ...input, folder: "meetings/foreign" })).status, 404);
  const responses = await Promise.all([call("/join", input), call("/join", input)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(commands.filter((cmd) => cmd === "start").length, 1);
  assert.equal((await call("/signout")).status, 409);
  state = { phase: "joined", alive: true, joinedAt: now, recordingAt: now, people: 2, names: ["QA host"] };
  await meet.poll();
  assert.equal((await call("/leave")).status, 200);
  state = { ...state, phase: "ended", endedAt: now + 30000, reason: "stopped", audioBytes: 30000 };
  await meet.poll();
  const recent = (await f.request(f.alice, path)).data.recent[0];
  assert.equal(recent.error, "");
  assert.equal(recent.transcript.status, "proposed");
  assert.ok(recent.transcript.url.startsWith(f.base + "/#/artefatti/"));
  const file = artifacts.treeOf(recent.transcript.commit).get(recent.transcript.path);
  assert.match((await artifacts.readFile(file)).toString(), /QA host[\s\S]*First sentence\.[\s\S]*0:25[\s\S]*Second sentence\./);
  const notices = orchestrator.state(privateRoom(agent.id)).history.filter((item) => item.kind === "bot");
  assert.equal(notices.length, 1);
  assert.ok(notices[0].content.includes(recent.transcript.url));
  assert.equal((await call("/signout")).data.account, null);
});

test("updated Meet captions produce one timed turn per block", () => {
  const partial = { at: 2, block: 4, speaker: "Host", text: "Hello" };
  assert.deepEqual(captionTurns([partial, { ...partial, at: 30, text: "Hello. Goodbye." }]), [{ name: "Host", start: 2, text: "Hello" }, { name: "Host", start: 30, text: "Goodbye." }]);
  assert.deepEqual(captionTurns([partial, { ...partial, at: 3, text: "Hello there" }]), [{ name: "Host", start: 2, text: "Hello there" }]);
});

test("Soniox call transcription requests diarization and retains the timed tokens", async (t) => {
  const f = await fakeSoniox();
  t.after(f.close);
  const voice = new Voice({ key: f.key, api: f.url });
  const transcript = await voice.transcribeCall(Buffer.from("audio"), { pollMs: 1 });
  assert.equal(f.state.transcriptions[0].enable_speaker_diarization, true);
  assert.equal(transcript.tokens[0].text, f.state.text);
});

test("meet_setup prepares the agent's own Google password, opens sign-in and is done only on the agent's address", async (t) => {
  const home = tempHome();
  const store = new Store(home);
  t.after(() => { store.close?.(); rmSync(home, { recursive: true, force: true }); });
  const agent = store.createAgent({ name: "Clàra Test", tools: true, enabled: true, model: "ollama/test-model" });
  const imported = [];
  const commands = [];
  let email = "";
  const boxes = {
    ensure: async () => {},
    importSecret: async (agentId, name, value) => { imported.push({ agentId, name, value: value.toString("utf8") }); },
    meet: async (_id, [command]) => { commands.push(command); return command === "account" ? { email } : {}; },
  };
  const vault = new Vault({ store, key: "fixture-session-key", boxes, log: () => {} });
  const meet = new Meet({ store, boxes });
  meet.save(agent.id, { enabled: true });
  await assert.rejects(meet.setup(agent, { step: "start", email: "", vault }), /mailbox/);
  const started = await meet.setup(agent, { step: "start", email: "Clara@Example.test", vault });
  assert.equal(started.status, "running");
  assert.equal(started.secret, "GOOGLE_CLARA_TEST_PASSWORD");
  assert.equal(started.newPassword, true);
  assert.ok(started.steps.some((line) => line.includes("hush run --name GOOGLE_CLARA_TEST_PASSWORD")));
  assert.ok(!JSON.stringify(started).includes(imported[0].value));
  assert.deepEqual(imported.map((item) => [item.agentId, item.name]), [[agent.id, "GOOGLE_CLARA_TEST_PASSWORD"]]);
  assert.match(imported[0].value, /^Cm[\w-]{20}#7$/);
  assert.deepEqual(store.vaultSecret("GOOGLE_CLARA_TEST_PASSWORD").agents, [agent.id]);
  assert.deepEqual(commands, ["account", "signin"]);
  assert.equal(meet.view(agent).setup.status, "running");
  const again = await meet.setup(agent, { step: "start", email: "clara@example.test", vault });
  assert.equal(again.newPassword, false);
  assert.equal(imported[1].value, imported[0].value);
  await assert.rejects(meet.setup(agent, { step: "needs-human", note: "" }), /one line/);
  assert.equal((await meet.setup(agent, { step: "needs-human", note: "Google vuole il QR" })).status, "needs-human");
  email = "someone@else.test";
  const wrong = await meet.setup(agent, { step: "check" });
  assert.equal(wrong.status, "needs-human");
  assert.match(wrong.next, /someone@else\.test/);
  email = "clara@example.test";
  const done = await meet.setup(agent, { step: "check" });
  assert.equal(done.status, "done");
  assert.equal(meet.view(agent).setup.status, "done");
  assert.equal(meet.view(agent).account.email, "clara@example.test");
  const signed = await meet.setup(agent, { step: "start", email: "clara@example.test", vault });
  assert.equal(signed.status, "done");
  assert.equal(commands.filter((cmd) => cmd === "signin").length, 2);
});
