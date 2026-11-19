const MAX_DEPENDENCIES = 48;
const OPEN = new Set(["active", "blocked"]);
const stepKey = (planId, taskId) => planId + "/" + taskId;

export function openPlan(plan) {
  return OPEN.has(plan.status);
}

export function dependencyState(edge, target) {
  if (!target) return "unavailable";
  if (!edge.taskId) return target.status === "completed" ? "done" : openPlan(target) ? "waiting" : "unavailable";
  const index = target.items.findIndex(({ id }) => id === edge.taskId);
  if (index < 0) return "unavailable";
  if (index < target.done) return "done";
  return openPlan(target) ? "waiting" : "unavailable";
}

export function updateDependencies(plan, input, findTarget) {
  if (!Array.isArray(input) || input.length > MAX_DEPENDENCIES) throw new Error("provide at most 48 dependencies");
  const links = new Map();
  for (const entry of input) {
    const step = entry?.step ?? null;
    if (step !== null && (!Number.isSafeInteger(step) || step <= plan.done || step > plan.items.length)) {
      throw new Error("choose an unfinished step or omit step for the whole remaining plan");
    }
    const planId = entry?.plan_id;
    const taskId = entry?.task_id ?? null;
    const target = typeof planId === "string" && findTarget(planId);
    const edge = { itemId: step === null ? null : plan.items[step - 1].id, planId, taskId };
    if (!target || planId === plan.id || dependencyState(edge, target) === "unavailable") {
      throw new Error("choose an available prerequisite plan or step from another agent in this thread");
    }
    links.set(JSON.stringify(edge), edge);
  }
  return [...links.values()];
}

export function assertAcyclic(plans) {
  const open = new Map(plans.filter(openPlan).map((plan) => [plan.id, plan]));
  const incoming = new Map();
  const outgoing = new Map();
  const link = (source, target) => {
    incoming.set(target, incoming.get(target) + 1);
    outgoing.get(source).push(target);
  };
  for (const plan of open.values()) {
    for (const item of plan.items.slice(plan.done)) {
      const id = stepKey(plan.id, item.id);
      incoming.set(id, 0);
      outgoing.set(id, []);
    }
  }
  for (const plan of open.values()) {
    const pending = plan.items.slice(plan.done);
    for (let i = 1; i < pending.length; i++) {
      link(stepKey(plan.id, pending[i - 1].id), stepKey(plan.id, pending[i].id));
    }
    for (const edge of plan.dependencies || []) {
      const target = open.get(edge.planId);
      if (dependencyState(edge, target) !== "waiting") continue;
      const sourceId = stepKey(target.id, edge.taskId || target.items.at(-1).id);
      const targetId = stepKey(plan.id, edge.itemId || pending[0]?.id);
      if (incoming.has(targetId)) link(sourceId, targetId);
    }
  }
  const ready = [...incoming].filter(([, degree]) => degree === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) {
    for (const dependent of outgoing.get(ready[i])) {
      const degree = incoming.get(dependent) - 1;
      incoming.set(dependent, degree);
      if (!degree) ready.push(dependent);
    }
  }
  if (ready.length !== incoming.size) throw new Error("plan dependencies would create a cycle");
}

export function assertDistinctTasks(plan, peers) {
  const key = (text) => text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const reserved = new Set(peers.filter(openPlan).flatMap(({ items }) => items.map(({ text }) => key(text))));
  for (const { text } of plan.items) {
    const normalized = key(text);
    if (reserved.has(normalized)) throw new Error("this checklist repeats a task already assigned in an open plan");
    reserved.add(normalized);
  }
}
