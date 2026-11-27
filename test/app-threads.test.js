import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { waitFor } from "./helpers.js";

test("threads in app: their person opens them with chosen agents, invites more by name, and nobody else sees them", async (t) => {
  const f = await knowledgeWorld(); t.after(f.close);
  const make = async (actor, name) => (await f.request(actor, "/api/agents", { method: "POST", body: { name, model: "ollama/test-model", tools: false } })).data;
  const ada = await make(f.alice, "Ada"), leo = await make(f.alice, "Leo"), bobAgent = await make(f.bob, "Bobby");
  const prompts = [];
  f.state.answer = (body) => {
    prompts.push(body);
    const system = body.messages[0]?.content || "";
    return { content: system.includes("Sei Leo") ? "LEO_IN_APP_REPLY" : "ADA_IN_APP_REPLY" };
  };

  const offer = (await f.request(f.alice, "/api/app-threads")).data;
  assert.deepEqual(offer.threads, []);
  assert.deepEqual(offer.agents.map((agent) => agent.name).sort(), ["Ada", "Leo"], "only the person's own agents can be put in a thread");
  assert.equal((await f.request(f.alice, "/api/app-threads", { method: "POST", body: { agentIds: [bobAgent.id] } })).status, 403);
  assert.equal((await f.request(f.alice, "/api/app-threads", { method: "POST", body: { agentIds: [] } })).status, 400);

  const created = await f.request(f.alice, "/api/app-threads", { method: "POST", body: { agentIds: [ada.id] } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.match(id, /^web-t-[a-f0-9]{12}$/);
  assert.equal(created.data.name, "Nuovo thread");

  // Nobody else lists it, reads it or writes in it.
  assert.deepEqual((await f.request(f.bob, "/api/app-threads")).data.threads, []);
  assert.equal((await f.request(f.bob, `/api/rooms/${id}/messages`)).status, 404);
  assert.equal((await f.request(f.bob, `/api/rooms/${id}/messages`, { method: "POST", body: { text: "BOB_FORGED" } })).status, 404);
  assert.equal((await f.request(f.bob, `/api/threads/${id}`)).status, 404);
  assert.equal((await f.request(f.bob, `/api/app-threads/${id}`, { method: "PATCH", body: { name: "forged" } })).status, 404);
  assert.equal((await f.request(f.bob, "/api/threads/close", { method: "POST", body: { id } })).status, 404);
  assert.ok(!(await f.request(f.bob, "/api/threads")).data.threads.some((thread) => thread.id === id));

  // A message that names nobody is for the agents of the thread; the first one names it.
  assert.equal((await f.request(f.alice, `/api/rooms/${id}/messages`, { method: "POST", body: { text: "Prepariamo il lancio della landing nuova" } })).status, 201);
  await waitFor(async () => JSON.stringify((await f.request(f.alice, `/api/rooms/${id}/messages`)).data).includes("ADA_IN_APP_REPLY"), { what: "Ada answers in the thread" });
  const prompt = JSON.stringify(prompts.at(-1));
  assert.match(prompt, /thread in app/i);
  assert.match(prompt, /Prepariamo il lancio/);
  const listed = (await f.request(f.alice, "/api/app-threads")).data.threads;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Prepariamo il lancio della landing nuova");
  assert.deepEqual(listed[0].agents.map((agent) => agent.name), ["Ada"]);
  assert.equal(listed[0].last.content, "ADA_IN_APP_REPLY");

  // An agent called by name joins the thread while it runs.
  await f.request(f.alice, `/api/rooms/${id}/messages`, { method: "POST", body: { text: "@Leo entra anche tu e dimmi la tua" } });
  await waitFor(async () => JSON.stringify((await f.request(f.alice, `/api/rooms/${id}/messages`)).data).includes("LEO_IN_APP_REPLY"), { what: "Leo answers once invited" });
  assert.deepEqual(f.app.orchestrator.appThreads.agentIds(id), [ada.id, leo.id]);
  assert.ok(f.app.brain.postingChannels(f.app.store.agent(leo.id), { id: "web-" + leo.id }).some((channel) => channel.id === id), "list_channels offers the thread to its agents");
  assert.ok(!f.app.brain.postingChannels(f.app.store.agent(bobAgent.id), { id: "web-" + bobAgent.id }).some((channel) => channel.id === id));

  // Another person's agent cannot be invited, by name or by the thread settings.
  await f.request(f.alice, `/api/rooms/${id}/messages`, { method: "POST", body: { text: "@Bobby vieni qui" } });
  assert.ok(!f.app.orchestrator.appThreads.agentIds(id).includes(bobAgent.id));
  assert.equal((await f.request(f.alice, `/api/app-threads/${id}`, { method: "PATCH", body: { agentIds: [ada.id, bobAgent.id] } })).status, 403);

  // The sidebar's latest threads lead with it, light, and leave it out for anyone else.
  const recent = (await f.request(f.alice, "/api/threads/recent")).data.threads;
  const own = recent.find((thread) => thread.id === id);
  assert.equal(own.app, true);
  assert.equal(own.room, "app");
  assert.deepEqual(own.agents.map((agent) => agent.name), ["Ada", "Leo"]);
  assert.equal(own.flows, undefined, "the sidebar list carries no flows");
  assert.ok(!(await f.request(f.bob, "/api/threads/recent")).data.threads.some((thread) => thread.id === id));

  // On the Thread page it is an in-app thread, renamed and closed like the others.
  const board = (await f.request(f.alice, "/api/threads")).data.threads.find((thread) => thread.id === id);
  assert.equal(board.kind, "web");
  assert.equal(board.app, true);
  assert.equal(board.open, true);
  assert.equal((await f.request(f.alice, `/api/threads/${id}`)).status, 200);
  assert.equal((await f.request(f.alice, "/api/threads/rename", { method: "POST", body: { id, name: "Lancio landing" } })).data.name, "Lancio landing");
  assert.equal((await f.request(f.alice, "/api/threads/close", { method: "POST", body: { id } })).data.closed, true);
  assert.equal((await f.request(f.alice, "/api/app-threads")).data.threads[0].closed, true);
  // Writing again opens it again.
  await f.request(f.alice, `/api/rooms/${id}/messages`, { method: "POST", body: { text: "Riprendiamo" } });
  assert.equal((await f.request(f.alice, "/api/app-threads")).data.threads[0].closed, false);
  assert.equal((await f.request(f.alice, "/api/app-threads")).data.threads[0].name, "Lancio landing", "a named thread keeps its name");
});

test("in a shared space a thread in app stays its person's: other members neither read it nor receive its live messages", async (t) => {
  const f = await knowledgeWorld({ ownerMemory: false }); t.after(f.close);
  f.state.answer = () => ({ content: "SHARED_SPACE_REPLY" });
  const ada = (await f.request(f.admin, "/api/agents", { method: "POST", body: { name: "Ada", model: "ollama/test-model", tools: false } })).data;
  const created = await f.request(f.alice, "/api/app-threads", { method: "POST", body: { name: "Alice only", agentIds: [ada.id] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  const abort = new AbortController();
  const stream = await fetch(f.base + "/api/events", { headers: f.bob.headers, signal: abort.signal });
  let events = ""; const reading = (async () => { try { for await (const chunk of stream.body) events += Buffer.from(chunk).toString(); } catch {} })();
  try {
    await f.request(f.alice, `/api/rooms/${id}/messages`, { method: "POST", body: { text: "ALICE_IN_APP_SECRET" } });
    await waitFor(async () => JSON.stringify((await f.request(f.alice, `/api/rooms/${id}/messages`)).data).includes("SHARED_SPACE_REPLY"), { what: "Ada answers Alice" });
    await f.request(f.bob, "/api/rooms/web/messages", { method: "POST", body: { text: "BOB_LOUNGE_MARKER" } });
    await waitFor(() => events.includes("BOB_LOUNGE_MARKER"), { what: "Bob's own stream is live" });
    assert.doesNotMatch(events, /ALICE_IN_APP_SECRET|SHARED_SPACE_REPLY/);
  } finally { abort.abort(); await reading; }
  assert.equal((await f.request(f.bob, `/api/rooms/${id}/messages`)).status, 404);
  assert.ok(!(await f.request(f.bob, "/api/threads/recent")).data.threads.some((thread) => thread.id === id));
  assert.match(JSON.stringify((await f.request(f.admin, `/api/rooms/${id}/messages`)).data), /ALICE_IN_APP_SECRET/, "the space owner keeps the view of a shared space");
});
