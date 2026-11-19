import { randomUUID } from "node:crypto";
import { assertAcyclic, assertDistinctTasks, dependencyState, openPlan, updateDependencies } from "./thread-plan-dependencies.js";

const MAX_STEPS = 24;
const MAX_NAME = 120;
const MAX_STEP = 300;

function planText(value, limit, field) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > limit || /[\r\n]/.test(clean)) {
    throw new Error(`${field} must be one line of 1–${limit} characters`);
  }
  return clean;
}

function checklist(values, max = MAX_STEPS) {
  if (!Array.isArray(values) || !values.length || values.length > max) {
    throw new Error(`provide between 1 and ${max} checklist items`);
  }
  return values.map((value) => planText(value, MAX_STEP, "Each checklist item"));
}

function planRow(row) {
  if (!row) return null;
  const items = JSON.parse(row.items);
  const dependencies = JSON.parse(row.dependencies);
  return {
    ...(dependencies.length ? { dependencies } : {}),
    id: row.id, agentId: row.agent_id, channelId: row.channel_id, name: row.name, status: row.status, items,
    done: row.done, next: row.status === "active" ? row.done + 1 : null,
    blockedReason: row.blocked_reason, revision: row.revision, updatedAt: row.updated_at,
  };
}

export class ThreadPlans {
  constructor(db) {
    this.db = db;
    this.onChange = null;
    this.canShare = () => true;
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_plans (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'completed', 'closed')),
        items TEXT NOT NULL,
        dependencies TEXT NOT NULL DEFAULT '[]',
        done INTEGER NOT NULL DEFAULT 0,
        blocked_reason TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS thread_plans_open_by_agent ON thread_plans(channel_id, agent_id)
        WHERE status IN ('active', 'blocked');
      DROP INDEX IF EXISTS thread_plans_open;
      CREATE INDEX IF NOT EXISTS thread_plans_recent ON thread_plans(channel_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS thread_plans_history ON thread_plans(updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS thread_plan_reasoning (
        seq INTEGER PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES thread_plans(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        task_text TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        step TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_plan_task_reasoning ON thread_plan_reasoning(plan_id, task_id, seq);
      CREATE INDEX IF NOT EXISTS thread_plan_trace_reasoning ON thread_plan_reasoning(trace_id, plan_id, task_id);
    `);
    if (!db.prepare("PRAGMA table_info(thread_plans)").all().some(({ name }) => name === "dependencies")) {
      db.exec("ALTER TABLE thread_plans ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'");
    }
  }

  raw(channelId, id) {
    return planRow(this.db.prepare("SELECT * FROM thread_plans WHERE channel_id = ? AND id = ?").get(channelId, id));
  }

  withDependencies(plan) {
    if (!openPlan(plan) || !plan.dependencies?.length) return plan;
    const itemId = plan.items[plan.done]?.id;
    const waitingOn = plan.dependencies.filter((edge) => !edge.itemId || edge.itemId === itemId).flatMap((edge) => {
      const target = this.raw(plan.channelId, edge.planId);
      const status = dependencyState(edge, target && this.canShare(plan.agentId, target.agentId) ? target : null);
      return status === "done" ? [] : [{ ...edge, status }];
    });
    return waitingOn.length ? { ...plan, next: null, waitingOn } : plan;
  }

  peerPlans(channelId, agentId, limit = -1) {
    const rows = this.db.prepare(`SELECT * FROM thread_plans WHERE channel_id = ?
      ORDER BY status NOT IN ('active', 'blocked'), updated_at DESC, id`).all(channelId);
    const visible = rows.filter((row) => this.canShare(agentId, row.agent_id));
    return (limit < 0 ? visible : visible.slice(0, limit)).map((row) => this.withDependencies(planRow(row)));
  }

  validate(plan, { dependencies, itemsChanged }) {
    const peers = this.db.prepare(`SELECT * FROM thread_plans WHERE channel_id = ?
      AND id != ? AND status IN ('active', 'blocked')`).all(plan.channelId, plan.id)
      .filter(({ agent_id }) => this.canShare(plan.agentId, agent_id)).map(planRow);
    if (itemsChanged) {
      assertDistinctTasks(plan, peers);
      const itemIds = new Set(plan.items.map(({ id }) => id));
      if (peers.some((peer) => openPlan(peer) && peer.dependencies?.some((edge) =>
        edge.planId === plan.id && edge.taskId && !itemIds.has(edge.taskId)))) {
        throw new Error("a step required by another open plan cannot be removed");
      }
    }
    if (dependencies !== undefined) {
      const historical = plan.dependencies || [];
      const completed = new Set(plan.items.slice(0, plan.done).map(({ id }) => id));
      const target = (id) => {
        const candidate = this.raw(plan.channelId, id);
        return candidate && candidate.agentId !== plan.agentId && this.canShare(plan.agentId, candidate.agentId) ? candidate : null;
      };
      plan.dependencies = [
        ...historical.filter((edge) => completed.has(edge.itemId)),
        ...updateDependencies(plan, dependencies, target),
      ];
    }
    assertAcyclic([...peers, plan]);
  }

  list(channelId, agentIds = null, limit = -1) {
    const scope = agentIds ? " AND agent_id IN (SELECT value FROM json_each(?))" : "";
    return this.db.prepare(`SELECT * FROM thread_plans WHERE channel_id = ?${scope}
      ORDER BY status NOT IN ('active', 'blocked'), updated_at DESC, id LIMIT ?`)
      .all(channelId, ...(agentIds ? [JSON.stringify(agentIds)] : []), limit).map((row) => this.withDependencies(planRow(row)));
  }

  /** Plans across every thread: all open ones, or the history of finished ones newest first, `before` an updatedAt|id cursor. */
  recent({ agentIds = null, open = true, limit = 50, before = "" } = {}) {
    const scope = agentIds ? " AND agent_id IN (SELECT value FROM json_each(?))" : "";
    const [at = "", id = ""] = String(before || "").split("|");
    const cursor = !open && at ? " AND (updated_at < ? OR (updated_at = ? AND id > ?))" : "";
    return this.db.prepare(`SELECT * FROM thread_plans WHERE status ${open ? "IN" : "NOT IN"} ('active', 'blocked')${scope}${cursor}
      ORDER BY updated_at DESC, id LIMIT ?`)
      .all(...(agentIds ? [JSON.stringify(agentIds)] : []), ...(cursor ? [at, at, id] : []), limit).map((row) => this.withDependencies(planRow(row)));
  }

  channels(agentIds = null) {
    const scope = agentIds ? " WHERE agent_id IN (SELECT value FROM json_each(?))" : "";
    return this.db.prepare(`SELECT channel_id AS id, MAX(updated_at) AS updatedAt FROM thread_plans${scope}
      GROUP BY channel_id`).all(...(agentIds ? [JSON.stringify(agentIds)] : []));
  }

  open(channelId, agentId) {
    const row = this.db.prepare(`SELECT * FROM thread_plans WHERE channel_id = ? AND agent_id = ?
      AND status IN ('active', 'blocked')`).get(channelId, agentId);
    return row ? this.withDependencies(planRow(row)) : null;
  }

  write(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const plan = operation();
      this.db.exec("COMMIT");
      return this.changed(plan);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  create(channelId, agentId, input) {
    return this.write(() => this.#create(channelId, agentId, input));
  }

  #create(channelId, agentId, { name, items, dependencies }) {
    const duplicate = () => Object.assign(new Error("this agent already has an open plan in this thread"), { status: 409 });
    if (this.open(channelId, agentId)) throw duplicate();
    const plan = {
      id: randomUUID(), channelId, agentId, name: planText(name, MAX_NAME, "Plan name"), done: 0, status: "active",
      items: checklist(items).map((text) => ({ id: randomUUID(), text })),
    };
    this.validate(plan, { dependencies, itemsChanged: true });
    const row = this.db.prepare(`INSERT INTO thread_plans (id, channel_id, agent_id, name, items, dependencies, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?) ON CONFLICT DO NOTHING RETURNING *`)
      .get(plan.id, channelId, agentId, plan.name, JSON.stringify(plan.items), JSON.stringify(plan.dependencies || []), new Date().toISOString());
    if (!row) throw duplicate();
    return this.withDependencies(planRow(row));
  }

  change(channelId, agentId, operation, args) {
    const apply = () => this.#change(channelId, agentId, operation, args);
    return operation === "resume" ? apply() : this.write(apply);
  }

  #change(channelId, agentId, operation, args) {
    const plan = this.open(channelId, agentId);
    if (!plan || plan.id !== args.id) throw Object.assign(new Error("open plan not found in this thread"), { status: 404 });
    if (plan.revision !== args.revision) throw Object.assign(new Error("plan changed; read the latest revision before updating"), { status: 409 });
    if (operation === "resume") {
      if (plan.waitingOn?.length) throw new Error("the next step is waiting for a plan dependency");
      if (plan.status !== "active") throw new Error("clear the blocker before continuing");
      return plan;
    }
    if (operation === "advance") {
      if (plan.waitingOn?.length) throw new Error("the next step is waiting for a plan dependency");
      if (plan.status !== "active") throw new Error("clear the blocker before continuing");
      if (args.step !== plan.next) throw new Error(`only step ${plan.next} can be completed now`);
      plan.done += 1;
      if (plan.done === plan.items.length) plan.status = "completed";
    } else if (operation === "close") {
      plan.status = "closed";
    } else {
      const { name, remaining, blocked_reason: blocker, dependencies } = args;
      if (name === undefined && remaining === undefined && blocker === undefined && dependencies === undefined) throw new Error("no plan changes supplied");
      if (name !== undefined) plan.name = planText(name, MAX_NAME, "Plan name");
      if (remaining !== undefined) {
        const open = new Map();
        for (const item of plan.items.slice(plan.done)) {
          if (!open.has(item.text)) open.set(item.text, []);
          open.get(item.text).push(item);
        }
        const revised = checklist(remaining, MAX_STEPS - plan.done).map((text) => open.get(text)?.shift() || { id: randomUUID(), text });
        plan.items = [...plan.items.slice(0, plan.done), ...revised];
        const itemIds = new Set(plan.items.map(({ id }) => id));
        plan.dependencies = plan.dependencies?.filter((edge) => !edge.itemId || itemIds.has(edge.itemId));
      }
      if (blocker !== undefined) {
        plan.blockedReason = blocker === "" ? "" : planText(blocker, MAX_STEP, "Blocker");
        plan.status = plan.blockedReason ? "blocked" : "active";
      }
      if (remaining !== undefined || dependencies !== undefined) {
        this.validate(plan, { dependencies, itemsChanged: remaining !== undefined });
      }
    }
    const row = this.db.prepare(`UPDATE thread_plans SET name = ?, status = ?, items = ?, dependencies = ?, done = ?, blocked_reason = ?,
      revision = revision + 1, updated_at = ? WHERE id = ? AND channel_id = ? AND agent_id = ? AND revision = ? RETURNING *`)
      .get(plan.name, plan.status, JSON.stringify(plan.items), JSON.stringify(plan.dependencies || []), plan.done, plan.blockedReason,
        new Date().toISOString(), plan.id, channelId, agentId, args.revision);
    if (!row) throw Object.assign(new Error("plan changed; read the latest revision before updating"), { status: 409 });
    return this.withDependencies(planRow(row));
  }

  changed(plan) {
    try { this.onChange?.(plan); } catch {}
    return plan;
  }

  record(traceId, task, step) {
    this.db.prepare("INSERT INTO thread_plan_reasoning (plan_id, task_id, task_text, trace_id, step) VALUES (?, ?, ?, ?, ?)")
      .run(task.planId, task.taskId, task.text, traceId, JSON.stringify(step));
  }

  tasks(planIds) {
    return this.db.prepare(`SELECT plan_id AS planId, task_id AS id, task_text AS text, COUNT(*) AS count
      FROM thread_plan_reasoning WHERE plan_id IN (SELECT value FROM json_each(?))
      GROUP BY plan_id, task_id, task_text ORDER BY MIN(seq)`).all(JSON.stringify(planIds));
  }

  traceTasks(traceIds) {
    return this.db.prepare(`SELECT trace_id AS traceId, plan_id AS planId, task_id AS taskId, task_text AS text
      FROM thread_plan_reasoning WHERE trace_id IN (SELECT value FROM json_each(?))
      GROUP BY trace_id, plan_id, task_id, task_text ORDER BY MIN(seq)`).all(JSON.stringify(traceIds));
  }

  reasoning(planId, taskId, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare(`SELECT r.seq, r.trace_id AS traceId, r.step, t.started_at AS startedAt
      FROM thread_plan_reasoning r LEFT JOIN traces t ON t.id = r.trace_id
      WHERE r.plan_id = ? AND r.task_id = ? AND r.seq < ? ORDER BY r.seq DESC LIMIT 100`)
      .all(planId, taskId, before).map((row) => ({ ...row, step: JSON.parse(row.step) }));
  }
}
