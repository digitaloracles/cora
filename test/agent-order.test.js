import assert from "node:assert/strict";
import { test } from "node:test";
import { byAgentName } from "../src/agent-order.js";
import { knowledgeWorld } from "./knowledge-fixtures.js";

const CREATED = ["agent 10", "Zeta", "Agent 2", "ada", "Éric", "Bruno", "Agent 1"];
const BY_NAME = ["ada", "Agent 1", "Agent 2", "agent 10", "Bruno", "Éric", "Zeta"];

test("agents sort by name, ignoring case and accents, with numbers in natural order", () => {
  const agents = CREATED.map((name, i) => ({ id: `ag_${i}`, name }));
  assert.deepEqual(byAgentName(agents).map((agent) => agent.name), BY_NAME);
  assert.deepEqual(agents.map((agent) => agent.name), CREATED, "the list it is given stays as it was");
  assert.deepEqual(byAgentName([{ id: "ag_b", name: "Nico" }, { id: "ag_a", name: "nico" }]).map((agent) => agent.id), ["ag_a", "ag_b"], "same name: a stable order");
});

test("the panel, the Mac and iPhone apps and the agent pickers list agents by name, not by creation", async (t) => {
  const f = await knowledgeWorld(); t.after(f.close);
  for (const name of CREATED) f.app.store.createAgent({ name, brainOwnerId: f.alice.user.id, tools: false, enabled: true });
  const state = await f.request(f.alice, "/api/state");
  assert.equal(state.status, 200);
  assert.deepEqual(state.data.agents.map((agent) => agent.name), BY_NAME);

  const pairing = await f.request(f.alice, "/api/app/pairings", { method: "POST", body: {} });
  const code = new URL(pairing.data.link).searchParams.get("code");
  const session = await (await fetch(f.base + "/app/v1/session", { method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify({ code, name: "MacBook", platform: "macOS 26" }) })).json();
  const snapshot = await (await fetch(f.base + "/app/v1/snapshot", { headers: { Authorization: `Bearer ${session.token}` } })).json();
  assert.deepEqual(snapshot.agents.map((agent) => agent.name), BY_NAME);

  const connectors = await f.request(f.alice, "/api/connectors");
  assert.deepEqual(connectors.data.agents.map((agent) => agent.name), BY_NAME);
  const email = await f.request(f.alice, "/api/mail/channel");
  assert.equal(email.status, 200);
  assert.deepEqual(email.data.agents.map((agent) => agent.name), BY_NAME);

  assert.deepEqual(f.app.store.agents().map((agent) => agent.name), CREATED, "the stored order, which other parts of Cora rely on, is unchanged");
});
