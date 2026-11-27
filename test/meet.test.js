import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { mailWorld } from "./mail-fixtures.js";
import { googleConnectorFixture } from "./google-connector-fixtures.js";
import { fakeSoniox } from "./helpers.js";
import { Voice } from "../src/voice.js";
import { captionTurns } from "../src/meet.js";
import { privateRoom } from "../src/rooms.js";

test("Meet OAuth saves one shared identity without giving agents a Gmail connection", async (t) => {
  const instance = await mailWorld(t);
  const google = await googleConnectorFixture(t, instance);
  const path = "/api/settings/google-meet";
  assert.equal((await instance.call(path, { method: "POST", asMember: true })).status, 403);
  const { response, authorize } = await google.connect(path);
  assert.equal(response.status, 200);
  assert.deepEqual(authorize.searchParams.get("scope").split(" ").sort(), ["email", "openid", "profile"]);
  assert.equal(authorize.searchParams.get("access_type"), "online");
  assert.deepEqual((await instance.call(path)).data.account, { email: "robin+google@ambox.dev", name: "Shared Meet QA" });
  assert.equal(instance.app.googleConnector.records().length, 0);
  assert.deepEqual((await instance.call(path, { method: "DELETE" })).data, { account: null });
});

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
    assert.match(id, /^meet_[a-f0-9]{32}$/);
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
  assert.equal((await f.request(f.alice, "/api/settings/google-meet")).data.account, null);
  assert.equal((await call("/join", input)).status, 409);
  const key = f.app.googleConnector.meetIdentityKey(f.alice.user.id);
  store.setValue(key, { email: "shared@gmail.com", name: "Shared QA", subject: "qa" });
  email = "former-agent@example.test";
  assert.equal((await call("/join", input)).status, 409);
  email = "shared@gmail.com";
  const view = (await f.request(f.alice, path)).data;
  assert.equal(view.alias, "shared+meetingassistant@gmail.com");
  assert.equal(view.account.name, "Shared QA");
  assert.equal((await f.request(f.bob, "/api/settings/google-meet")).data.account, null);
  assert.equal((await call("/join", { ...input, folder: "meetings/foreign" })).status, 404);
  const responses = await Promise.all([call("/join", input), call("/join", input)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(commands.filter((cmd) => cmd === "start").length, 1);
  assert.equal((await f.request(f.alice, "/api/settings/google-meet/browser", {method: "POST"})).status, 409);
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
  assert.equal((await f.request(f.alice, "/api/settings/google-meet", {method: "DELETE"})).data.account, null);
});

test("all agents of one owner share the same browser and keep separate invitation addresses", async (t) => {
  const f = await knowledgeWorld();
  t.after(f.close);
  const { meet, store, googleConnector } = f.app;
  const agent = (name, owner) => store.createAgent({ name, brainOwnerId: owner.user.id, tools: true, enabled: true, model: "ollama/test-model" });
  const fab = agent("Fab", f.alice), ada = agent("Ada", f.alice), other = agent("Other", f.bob);
  for (const actor of [f.alice, f.bob]) store.setValue(googleConnector.meetIdentityKey(actor.user.id), { email: "team@gmail.com", name: "Common team name", subject: "team" });
  assert.equal(meet.sharedSeat(fab.brainOwnerId).id, meet.sharedSeat(ada.brainOwnerId).id);
  assert.notEqual(meet.sharedSeat(fab.brainOwnerId).id, meet.sharedSeat(other.brainOwnerId).id);
  assert.equal(meet.view(fab).alias, "team+fab@gmail.com");
  assert.equal(meet.view(ada).alias, "team+ada@gmail.com");
  assert.equal(meet.view(fab).account.name, meet.view(ada).account.name);
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
