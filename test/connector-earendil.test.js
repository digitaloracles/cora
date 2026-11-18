import assert from "node:assert/strict";
import { test } from "node:test";
import { earendilWorld, EARENDIL_KEY, EARENDIL_UNPAID } from "./earendil-fixtures.js";
import { connectorCatalog, connectorForTool } from "../src/connectors/index.js";

const connect = (f, token) => f.call("/api/connectors/keys/earendil", { method: "POST", body: { mode: "key", token } });
const grant = (f, agents) => f.call("/api/connectors/keys/earendil", { method: "PUT", body: { agents } });

test("Eärendil studio checks the agent key on the MCP server before the vault, and refuses wrong, revoked and unpaid keys", async (t) => {
  const f = await earendilWorld(t);
  const card = connectorCatalog().find((item) => item.id === "earendil");
  assert.equal(card.name, "Eärendil studio"); assert.equal(card.secret, "CORA_EARENDIL_KEY"); assert.equal(card.modes[0].rows[0].field.placeholder, "earendil_…");
  for (const token of ["not-a-key", "earendil_wrong", EARENDIL_UNPAID]) {
    const refused = await connect(f, token);
    assert.equal(refused.status, 400, token);
    assert.match(refused.data.error, /Eärendil studio non ha confermato la chiave/);
  }
  assert.equal((await f.call("/api/connectors/keys/earendil", { method: "POST", body: { token: EARENDIL_KEY } })).status, 400, "the key mode is explicit");
  assert.equal(f.app.store.vaultSecret("CORA_EARENDIL_KEY"), null);
  const made = await connect(f, EARENDIL_KEY);
  assert.equal(made.status, 200);
  assert.doesNotMatch(JSON.stringify(made.data), /fixture-cora-studio-key/);
  assert.ok(f.app.store.vaultSecret("CORA_EARENDIL_KEY"));
  const listed = (await f.call("/api/connectors")).data.keyConnectors.find((item) => item.service === "earendil");
  assert.equal(listed.status, "connected"); assert.equal(listed.workspace, "Eärendil studio"); assert.equal(listed.remoteTools, undefined);
  assert.ok(f.remote.calls.every((call) => call.session === undefined), "a stateless server gets no session header");
});

test("Eärendil studio tools are namespaced, reach only authorised agents and never show the key", async (t) => {
  const f = await earendilWorld(t);
  await connect(f, EARENDIL_KEY);
  assert.deepEqual(f.connectors.toolsFor(f.agent), []);
  assert.match((await f.connectors.runTool(f.agent, "earendil_list_projects", {})).text, /not authorised/);
  await grant(f, [f.agent.id]);
  const tools = f.connectors.toolsFor(f.agent);
  assert.deepEqual(tools.map((tool) => tool.name), f.remote.definitions.map((tool) => `earendil_${tool.name}`));
  assert.equal(connectorForTool("earendil_listen").id, "earendil");
  const generate = tools.find((tool) => tool.name === "earendil_generate_speech");
  assert.match(generate.description, /then earendil_get_transcript and earendil_view_waveform, not listen_more/);
  assert.match(generate.parameters.properties.project_id.description, /^Project id from earendil_list_projects or create_project\.$/);
  assert.match(tools.find((tool) => tool.name === "earendil_list_projects").description, /How the studio works: Workflow: earendil_list_projects or create_project → earendil_generate_speech → listen\./);
  assert.match(tools.find((tool) => tool.name === "earendil_video_delete").description, /explicit user request/);
  assert.ok(tools.find((tool) => tool.name === "earendil_video_add_picture").parameters.properties.path);
  const projects = await f.connectors.runTool(f.agent, "earendil_list_projects", {});
  assert.match(projects.text, /"Guida"/);
  assert.doesNotMatch(projects.text, /fixture-cora-studio-key/); assert.match(projects.text, /\[key\]/);
  const call = f.remote.calls.find((item) => item.method === "tools/call");
  assert.equal(call.name, "list_projects", "the studio gets its own tool name");
  assert.equal((await f.connectors.runTool(f.agent, "earendil_generate_speech", { project_id: "p1", text: "Ciao" })).text, "error: Eärendil studio: Unknown voice.");
  assert.match((await f.connectors.runTool(f.agent, "earendil_unknown_tool", {})).text, /unavailable on the connected account/);
  await grant(f, []);
  assert.deepEqual(f.connectors.toolsFor(f.agent), []);
  assert.match((await f.connectors.runTool(f.agent, "earendil_list_projects", {})).text, /not authorised/);
});

test("Eärendil studio saves heard audio, pictures and long transcripts on the agent's computer and sends local pictures as data", async (t) => {
  const f = await earendilWorld(t);
  await connect(f, EARENDIL_KEY); await grant(f, [f.agent.id]);
  const files = new Map();
  const io = { writeFile: async (path, bytes) => files.set(path, Buffer.from(bytes)), readFile: async (path) => { if (path === "/home/agent/work/place.png") return Buffer.from("png-bytes"); throw new Error("missing"); } };
  const heard = JSON.parse((await f.connectors.runTool(f.agent, "earendil_listen", { project_id: "p1" }, io)).text);
  assert.match(heard.audio[0], /^\/home\/agent\/work\/earendil\/listen-\d+-1\.wav$/);
  assert.equal(files.get(heard.audio[0]).toString(), "RIFF-fixture-wav");
  assert.equal(heard.words[0][0], "Ciao");
  const seen = JSON.parse((await f.connectors.runTool(f.agent, "earendil_view_waveform", { project_id: "p1" }, io)).text);
  assert.match(seen.images[0], /view_waveform-\d+-1\.png$/);
  const transcript = await f.connectors.runTool(f.agent, "earendil_get_transcript", { project_id: "p1" }, io);
  assert.ok(transcript.text.length < 40000);
  const short = JSON.parse(transcript.text);
  assert.equal(short.duration, 900); assert.match(short.sentences, /characters: in full_answer/);
  assert.equal(JSON.parse(files.get(short.full_answer).toString()).sentences.length, 900);
  const added = await f.connectors.runTool(f.agent, "earendil_video_add_picture", { kind: "backdrop", path: "/home/agent/work/place.png" }, io);
  assert.match(added.text, /pic1/);
  assert.deepEqual(f.remote.pictures[0], { kind: "backdrop", data: Buffer.from("png-bytes").toString("base64"), name: "place" });
  assert.match((await f.connectors.runTool(f.agent, "earendil_video_add_picture", { kind: "backdrop", path: "/home/agent/work/place.png", url: "https://x.test/a.png" }, io)).text, /one of path, url or data/);
  assert.match((await f.connectors.runTool(f.agent, "earendil_video_add_picture", { kind: "backdrop", path: "/home/agent/work/none.png" }, io)).text, /cannot read/);
});

test("Eärendil studio reports a revoked key and an expired plan once, then disconnecting removes the key", async (t) => {
  const f = await earendilWorld(t);
  await connect(f, EARENDIL_KEY); await grant(f, [f.agent.id]);
  f.remote.state.refuse = 402;
  const before = f.remote.calls.filter((c) => c.method === "tools/call").length;
  assert.match((await f.connectors.runTool(f.agent, "earendil_generate_speech", { project_id: "p1", text: "x" })).text, /active subscription.*do not retry/);
  assert.equal(f.remote.calls.filter((c) => c.method === "tools/call").length - before, 1, "a paid action refused by the studio is not replayed");
  f.remote.state.refuse = 0; f.remote.state.revoked = true;
  assert.match((await f.connectors.runTool(f.agent, "earendil_list_projects", {})).text, /refused the agent key/);
  await f.call("/api/connectors/keys/earendil", { method: "DELETE" });
  assert.equal(f.app.store.vaultSecret("CORA_EARENDIL_KEY"), null);
  assert.deepEqual(f.connectors.toolsFor(f.agent), []);
  assert.match((await f.connectors.runTool(f.agent, "earendil_list_projects", {})).text, /not connected/);
});
