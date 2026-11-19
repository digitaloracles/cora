import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.js";
import { Traces } from "../src/traces.js";
import { tempHome } from "./helpers.js";

test("one open plan per agent in a thread, revision protection and ordered completion survive restart", () => {
  const home = tempHome();
  let store = new Store(home);
  const agent = store.createAgent({ name: "Pilot" });
  const other = store.createAgent({ name: "Crew" });
  const channel = "800000000000000051";
  const plans = store.plans;
  let plan = plans.create(channel, agent.id, { name: "Delivery", items: ["Verify", "Send", "Check receipt"] });
  const original = plan;
  assert.throws(() => plans.create(channel, agent.id, { name: "Duplicate", items: ["Check"] }), { status: 409 });
  assert.throws(() => plans.change(channel, other.id, "advance", { ...plan, step: 1 }), { status: 404 });
  assert.throws(() => plans.change("800000000000000052", agent.id, "advance", { ...plan, step: 1 }), { status: 404 });
  assert.throws(() => plans.change(channel, agent.id, "advance", { ...plan, step: 2 }), /only step 1/);
  plan = plans.change(channel, agent.id, "advance", { ...plan, step: 1 });
  assert.throws(() => plans.change(channel, agent.id, "advance", { ...original, step: 1 }), { status: 409 });
  plan = plans.change(channel, agent.id, "update", { ...plan, remaining: ["Check receipt", "Send"], blocked_reason: "Wait for receipt" });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.next, null);
  assert.deepEqual(plan.items.map(({ id }) => id), [original.items[0].id, original.items[2].id, original.items[1].id]);
  assert.throws(() => plans.change(channel, agent.id, "advance", { ...plan, step: 2 }), /clear the blocker/);
  // Recreate the legacy index to exercise migration with an existing blocked plan.
  store.db.exec(`CREATE UNIQUE INDEX thread_plans_open ON thread_plans(channel_id)
    WHERE status IN ('active', 'blocked'); DROP INDEX thread_plans_open_by_agent; ALTER TABLE thread_plans DROP COLUMN dependencies;`);
  store.close();
  store = new Store(home);
  assert.deepEqual(store.plans.open(channel, agent.id), plan);
  assert.throws(() => store.plans.create(channel, agent.id, { name: "Duplicate", items: ["Check"] }), { status: 409 });
  const parallel = store.plans.create(channel, other.id, { name: "Independent", items: ["Check", "Report"] });
  assert.equal(store.plans.list(channel).length, 2);
  const progressed = store.plans.change(channel, other.id, "advance", { ...parallel, step: 1 });
  assert.equal(progressed.next, 2);
  assert.deepEqual(store.plans.open(channel, agent.id), plan);
  store.close();
  store = new Store(home);
  assert.deepEqual(store.plans.open(channel, other.id), progressed);
  plan = store.plans.change(channel, agent.id, "update", { ...plan, blocked_reason: "" });
  plan = store.plans.change(channel, agent.id, "advance", { ...plan, step: 2 });
  plan = store.plans.change(channel, agent.id, "advance", { ...plan, step: 3 });
  assert.equal(plan.status, "completed");
  assert.equal(plan.next, null);
  assert.equal(store.plans.open(channel, agent.id), null);
  assert.deepEqual(store.plans.open(channel, other.id), progressed);
  const fresh = store.plans.create(channel, agent.id, { name: "Next plan", items: ["Publish"] });
  store.plans.change(channel, agent.id, "advance", { ...fresh, step: 1 });
  const next = store.plans.create("800000000000000052", other.id, { name: "Another thread", items: ["Draft"] });
  const closed = store.plans.change(next.channelId, other.id, "close", next);
  assert.equal(closed.status, "closed");
  assert.equal(closed.done, 0);
  assert.deepEqual(store.plans.list(channel, [agent.id]).map(({ id }) => id).sort(), [plan.id, fresh.id].sort());
  assert.deepEqual(store.plans.list(channel, []), []);
  store.close();
});

test("task reasoning survives trace rewrites, the rolling trace buffer and plan revisions", () => {
  const store = new Store(tempHome());
  const agent = store.createAgent({ name: "Pilot" });
  const thread = "800000000000000051";
  const plan = store.plans.create(thread, agent.id, { name: "Audit", items: ["Old checklist step", "Review"] });
  const task = plan.items[0];
  const traces = new Traces({ store });
  const trace = traces.start({ agentId: agent.id, channelId: thread, kind: "chat" });
  trace.planTask = { planId: plan.id, taskId: task.id, text: task.text };
  for (let i = 0; i < 310; i++) trace.add({ type: "thinking", text: "Reasoning " + i });
  trace.planTask = null;
  trace.add({ type: "thinking", text: "Unrelated note" });
  trace.finish({ status: "done" });
  store.plans.change(thread, agent.id, "update", { ...plan, remaining: ["New checklist step", "Review"] });
  assert.equal(store.plans.tasks([plan.id])[0].count, 310);
  assert.equal(store.plans.traceTasks([trace.id])[0].taskId, task.id);
  let events = store.plans.reasoning(plan.id, task.id);
  assert.equal(events.length, 100);
  assert.equal(events[0].step.text, "Reasoning 309");
  for (let i = 0; i < 3; i++) events = store.plans.reasoning(plan.id, task.id, events.at(-1).seq);
  assert.equal(events.at(-1).step.text, "Reasoning 0");
  assert.ok(!store.trace(trace.id).steps.some((step) => step.text === "Reasoning 0"));
  store.close();
});

test("plans across threads: every open plan, and the finished ones newest first with a stable cursor", () => {
  const store = new Store(tempHome());
  const agent = store.createAgent({ name: "Pilot" });
  const other = store.createAgent({ name: "Crew" });
  const changes = [];
  store.plans.onChange = (plan) => changes.push([plan.id, plan.status]);
  const open = store.plans.create("800000000000000061", agent.id, { name: "Open", items: ["One", "Two"] });
  const blocked = store.plans.change("800000000000000061", agent.id, "update", { ...open, blocked_reason: "Wait" });
  const foreign = store.plans.create("800000000000000062", other.id, { name: "Foreign", items: ["One"] });
  const finished = [];
  for (let i = 0; i < 5; i++) {
    const channel = String(800000000000000070 + i);
    const plan = store.plans.create(channel, agent.id, { name: "Done " + i, items: ["Only"] });
    finished.push(i % 2 ? store.plans.change(channel, agent.id, "close", plan) : store.plans.change(channel, agent.id, "advance", { ...plan, step: 1 }));
  }
  assert.deepEqual(store.plans.recent({ open: true }).map(({ id }) => id).sort(), [blocked.id, foreign.id].sort());
  assert.deepEqual(store.plans.recent({ open: true, agentIds: [agent.id] }).map(({ id, status, channelId }) => [id, status, channelId]), [[open.id, "blocked", "800000000000000061"]]);
  const newest = [...finished].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(({ id }) => id);
  const first = store.plans.recent({ open: false, limit: 2 });
  assert.deepEqual(first.map(({ id }) => id), newest.slice(0, 2));
  const rest = store.plans.recent({ open: false, limit: 10, before: `${first.at(-1).updatedAt}|${first.at(-1).id}` });
  assert.deepEqual(rest.map(({ id }) => id), newest.slice(2));
  assert.deepEqual(store.plans.recent({ open: false, agentIds: [other.id] }), []);
  assert.ok(changes.some(([id, status]) => id === blocked.id && status === "blocked"));
  assert.equal(changes.filter(([, status]) => status === "completed" || status === "closed").length, 5);
  store.close();
});

test("dependencies gate only the affected work, reject cycles, and preserve one assignment", () => {
  const home = tempHome();
  let store = new Store(home);
  const producer = store.createAgent({ name: "Producer" });
  const consumer = store.createAgent({ name: "Consumer" });
  const reviewer = store.createAgent({ name: "Reviewer" });
  const channel = "800000000000000084";
  const advance = (plan, step) => store.plans.change(channel, plan.agentId, "advance", { ...plan, step });
  const update = (plan, delta) => store.plans.change(channel, plan.agentId, "update", { ...plan, ...delta });
  let source = store.plans.create(channel, producer.id, { name: "Area API", items: ["Build schema", "Deploy API"] });
  const [schema, deploy] = source.items;
  assert.throws(() => store.plans.create(channel, consumer.id, { name: "Duplicate", items: ["build   schema"] }), /repeats a task/);
  let client = store.plans.create(channel, consumer.id, {
    name: "Area picker", items: ["Draw form", "Wire API"],
    dependencies: [{ step: 2, plan_id: source.id, task_id: schema.id }],
  });
  let review = store.plans.create(channel, reviewer.id, {
    name: "Review", items: ["Run acceptance checks"], dependencies: [{ plan_id: source.id }, { plan_id: client.id }],
  });
  assert.equal(client.next, 1);
  assert.equal(review.next, null);
  client = advance(client, 1);
  assert.equal(client.next, null);
  assert.deepEqual(client.waitingOn, [{ itemId: client.items[1].id, planId: source.id, taskId: schema.id, status: "waiting" }]);
  assert.throws(() => advance(client, 2), /waiting for a plan dependency/);
  assert.throws(() => store.plans.change(channel, consumer.id, "resume", client), /waiting for a plan dependency/);
  assert.throws(() => update(source, { dependencies: [{ plan_id: client.id }] }), /would create a cycle/);
  assert.throws(() => update(source, { remaining: ["Deploy API"] }), /required by another open plan/);
  // The later API step can wait for the picker because the picker only needs the earlier schema.
  source = update(source, { dependencies: [{ step: 2, plan_id: client.id, task_id: client.items[1].id }] });
  source = advance(source, 1);
  assert.equal(source.next, null);
  store.close();
  store = new Store(home);
  client = store.plans.open(channel, consumer.id);
  assert.equal(client.next, 2);
  client = advance(client, 2);
  assert.equal(client.status, "completed");
  assert.equal(store.plans.open(channel, producer.id).next, 2);
  review = store.plans.open(channel, reviewer.id);
  assert.deepEqual(review.waitingOn.map(({ planId }) => planId), [source.id]);
  const completedSource = advance(store.plans.open(channel, producer.id), 2);
  assert.equal(completedSource.items[1].id, deploy.id);
  review = store.plans.open(channel, reviewer.id);
  assert.equal(review.next, 1);
  assert.equal(advance(review, 1).status, "completed");
  store.close();
});

test("closed prerequisites require an explicit change unless the required step was completed", () => {
  const store = new Store(tempHome());
  const producer = store.createAgent({ name: "Producer" });
  const consumer = store.createAgent({ name: "Consumer" });
  const channel = "800000000000000084";
  let source = store.plans.create(channel, producer.id, { name: "Source", items: ["Publish file", "Report result"] });
  source = store.plans.change(channel, producer.id, "advance", { ...source, step: 1 });
  const client = store.plans.create(channel, consumer.id, {
    name: "Client", items: ["Validate file", "Verify report"],
    dependencies: [{ step: 1, plan_id: source.id, task_id: source.items[0].id }, { step: 2, plan_id: source.id }],
  });
  store.plans.change(channel, producer.id, "close", source);
  let current = store.plans.open(channel, consumer.id);
  assert.equal(current.next, 1);
  current = store.plans.change(channel, consumer.id, "advance", { ...current, step: 1 });
  assert.equal(current.next, null);
  assert.equal(current.waitingOn[0].status, "unavailable");
  current = store.plans.change(channel, consumer.id, "update", { ...current, dependencies: [] });
  assert.equal(current.next, 2);
  assert.deepEqual(current.dependencies, [client.dependencies[0]]);
  store.close();
});
