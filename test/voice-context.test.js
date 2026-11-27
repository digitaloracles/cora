import { test } from "node:test";
import assert from "node:assert/strict";
import { Brain } from "../src/brain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { Meet } from "../src/meet.js";

const agent = { id: "ag_radix", name: "Radix" };

function brainFixture({ messages, plans = [], facts = [] }) {
  const brain = Object.create(Brain.prototype);
  brain.timezone = "Europe/Rome";
  brain.channelIdsFor = () => Object.keys(messages);
  brain.channelLabel = (id) => ({ otel: "Investigare opentelemetry", voice: "Cora Voice" })[id] || id;
  brain.memory = { relevant: (id, query) => facts.filter((fact) => query.includes(fact.word)) };
  brain.store = {
    diary: () => [],
    recentElsewhere: (agentId, ids) => ids.filter((id) => messages[id]?.length).map((id) => ({ channelId: id, messages: messages[id] })),
    plans: { recent: ({ agentIds }) => plans.filter((plan) => agentIds.includes(plan.agentId)) },
  };
  return brain;
}

test("voice context: the agent in a call sees its memories, its threads newest first with the last request, and its open plans", async () => {
  const now = Date.now();
  const brain = brainFixture({
    messages: {
      voice: [{ kind: "owner", authorName: "Seb", at: now - 60000, content: "procedi" }, { kind: "agent", agentId: agent.id, authorName: "Radix", at: now - 30000, content: "Scrivo il codice." }],
      otel: [{ kind: "owner", authorName: "Seb", at: now - 3600000, content: "investiga opentelemetry" }, { kind: "agent", agentId: agent.id, authorName: "Radix", at: now - 3500000, content: "NOT-115 su main: span invoke_agent ed execute_tool." }],
    },
    plans: [{ agentId: agent.id, channelId: "voice", name: "NOT-123 · voce", done: 1, items: [{ text: "leggere" }, { text: "contesto in chiamata" }], blockedReason: "" }],
    facts: [{ id: "mem_1", word: "OpenTelemetry", text: "NOT-115: OTel live verso Langfuse" }],
  });
  const text = await brain.callContext(agent, { query: "a che punto è OpenTelemetry" });
  assert.match(text, /Ti torna in mente:\n- \[mem_1\] NOT-115: OTel live verso Langfuse/);
  assert.match(text, /I tuoi thread delle ultime 24 ore, dal più recente:\n- «Investigare opentelemetry» [^\n]*Seb: «investiga opentelemetry»; tu: «NOT-115 su main: span invoke_agent ed execute_tool\.»\n- «Cora Voice»/);
  assert.match(text, /I tuoi piani aperti:\n- «Cora Voice» NOT-123 · voce: 1\/2, prossimo passo: contesto in chiamata/);
});

test("voice context: a part that fails leaves the others", async () => {
  const brain = brainFixture({ messages: { otel: [{ kind: "agent", agentId: agent.id, authorName: "Radix", at: Date.now(), content: "lavoro" }] } });
  brain.memory = { relevant: () => { throw new Error("db"); } };
  brain.log = () => {};
  assert.match(await brain.callContext(agent, { query: "x" }), /«Investigare opentelemetry»/);
});

function orchestratorFixture({ openThread }) {
  const orchestrator = Object.create(Orchestrator.prototype);
  const archived = [];
  const posted = [];
  orchestrator.brain = { timezone: "Europe/Rome" };
  orchestrator.store = { settings: { ownerIds: ["u-seb"] }, appendArchive: (channelId, item) => archived.push({ channelId, ...item }) };
  orchestrator.discord = { post: async (channelId, message) => { posted.push({ channelId, ...message }); return [{ id: "m" }]; } };
  orchestrator.log = () => {};
  orchestrator.isOwner = (id) => id === "u-seb";
  orchestrator.openThread = openThread;
  return { orchestrator, archived, posted };
}

test("voice transcript: a thread «🎙️ Vocale» beside the conversation that called the agent, else the voice channel's chat", async () => {
  const asked = [];
  const { orchestrator } = orchestratorFixture({ openThread: async (who, currentId, { name }) => { asked.push({ who: who.id, currentId, name }); return { id: "thread-1" }; } });
  const id = await orchestrator.callTranscript({ agent, origin: "1575785973424328704", callChannelId: "1560000000000000000", callName: "Generale", startedAt: Date.parse("2026-11-27T10:00:00Z") });
  assert.equal(id, "thread-1");
  assert.deepEqual(asked, [{ who: agent.id, currentId: "1575785973424328704", name: "🎙️ Vocale · Generale · 27/11, 11:00" }]);
  const refused = orchestratorFixture({ openThread: async () => { throw new Error("no"); } }).orchestrator;
  assert.equal(await refused.callTranscript({ agent, origin: "1575785973424328704", callChannelId: "1560000000000000000", callName: "Generale" }), "1560000000000000000");
  assert.equal(await refused.callTranscript({ agent, origin: "web:salotto", callChannelId: "" }), "");
});

test("voice transcript: each line is posted with its time and kept in the archive as said by that person or agent; the end says no audio is kept", async () => {
  const { orchestrator, archived, posted } = orchestratorFixture({ openThread: async () => ({ id: "t" }) });
  const at = Date.parse("2026-11-27T09:08:19Z");
  await orchestrator.writeTranscript("t", [
    { at, name: "Seb", userId: "u-seb", agentId: null, text: "Radix, a che punto è OpenTelemetry?" },
    { at: at + 2000, name: "Radix", userId: null, agentId: "ag_radix", text: "NOT-115 è su main." },
    { at: at + 3000, name: "Seb", userId: "u-seb", agentId: null, text: "   " },
  ], { ended: true, startedAt: at - 120000, endedAt: at + 60000 });
  assert.equal(posted.length, 1, "one batch, one message");
  assert.equal(posted[0].content, "`10:08:19` **Seb**: Radix, a che punto è OpenTelemetry?\n`10:08:21` **Radix**: NOT-115 è su main.\n— Fine della chiamata, 3 min. Restano solo le parole: l'audio non viene salvato.");
  assert.deepEqual(archived.map((item) => [item.channelId, item.kind, item.authorName, item.agentId, item.content]), [
    ["t", "owner", "Seb", null, "Radix, a che punto è OpenTelemetry?"],
    ["t", "agent", "Radix", "ag_radix", "NOT-115 è su main."],
  ]);
  const long = Array.from({ length: 40 }, (_, index) => ({ at, name: "Seb", userId: "u-seb", text: `${index} ${"parola ".repeat(12)}` }));
  posted.length = 0;
  await orchestrator.writeTranscript("t", long);
  assert.ok(posted.length > 1 && posted.every((message) => message.content.length <= 1800), "long batches are split under Discord's limit");
});

test("meet: the meeting is written in a thread beside the conversation that sent the agent, with each turn's time", async () => {
  const calls = [];
  const meet = Object.create(Meet.prototype);
  meet.store = { settings: { language: "it" } };
  meet.log = () => {};
  meet.thread = async (options) => { calls.push(options); return "thread-meet"; };
  const session = { channelId: "1575785973424328704", recordingAt: 1000000, endedAt: 1600000 };
  await meet.writeThread(agent, session, [{ name: "Seb", start: 2.5, text: "Iniziamo." }, { name: "Alice", start: 10, text: "Ok." }]);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], agent: calls[0].agent.id }, { agent: agent.id, origin: session.channelId, callName: "Meet", startedAt: 1000000, endedAt: 1600000, lines: [{ at: 1002500, name: "Seb", text: "Iniziamo." }, { at: 1010000, name: "Alice", text: "Ok." }] });
  await meet.writeThread(agent, { ...session, channelId: "" }, [{ name: "Seb", start: 0, text: "x" }]);
  await meet.writeThread(agent, session, []);
  assert.equal(calls.length, 1, "nothing without a conversation or without words");
});
