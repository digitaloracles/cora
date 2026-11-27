/**
 * Threads opened in the panel itself (`web-t-<hex>`): a name, the person who opened it and the agents in it.
 * They have no Discord, Slack or Telegram channel behind them; the messages go through the orchestrator
 * like every panel room and land in the same archive. The records live in `store.value("appThreads")`.
 */
import { isAppThread, newAppThreadId } from "./rooms.js";

const KEY = "appThreads";
const MAX_AGENTS = 12;

export class AppThreads {
  constructor(store) {
    this.store = store;
  }

  all() {
    return this.store.value(KEY, {});
  }

  get(id) {
    return isAppThread(id) ? this.all()[id] || null : null;
  }

  list() {
    return Object.values(this.all());
  }

  /** Whether this person may read and write the thread: whoever opened it; in a shared space also its owner. */
  canUse(record, user, { ownerMemory = false } = {}) {
    if (!record || !user) return false;
    return record.ownerId === user.id || (!ownerMemory && user.role === "owner");
  }

  /** The agents of a thread, as ids, in the order they were chosen. */
  agentIds(id) {
    return this.get(id)?.agentIds || [];
  }

  static cleanName(name) {
    return String(name || "").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  static cleanAgents(agentIds) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).map(String).filter((id) => /^[\w-]{1,80}$/.test(id)))];
    if (!ids.length) throw Object.assign(new Error("Scegli almeno un agente."), { status: 400 });
    if (ids.length > MAX_AGENTS) throw Object.assign(new Error(`Al massimo ${MAX_AGENTS} agenti per thread.`), { status: 400 });
    return ids;
  }

  create({ name, agentIds, ownerId }) {
    const record = {
      id: newAppThreadId(),
      name: AppThreads.cleanName(name) || "Nuovo thread",
      named: Boolean(AppThreads.cleanName(name)),
      agentIds: AppThreads.cleanAgents(agentIds),
      ownerId: String(ownerId || ""),
      createdAt: new Date().toISOString(),
    };
    this.store.setValue(KEY, { ...this.all(), [record.id]: record });
    return record;
  }

  update(id, { name, agentIds } = {}) {
    const record = this.get(id);
    if (!record) throw Object.assign(new Error("thread non trovato"), { status: 404 });
    const next = { ...record };
    if (name !== undefined) {
      const clean = AppThreads.cleanName(name);
      if (!clean) throw Object.assign(new Error("manca il nome"), { status: 400 });
      next.name = clean;
      next.named = true;
    }
    if (agentIds !== undefined) next.agentIds = AppThreads.cleanAgents(agentIds);
    next.updatedAt = new Date().toISOString();
    this.store.setValue(KEY, { ...this.all(), [id]: next });
    return next;
  }

  /** A thread opened without a name takes the first words of its first message. */
  nameFromMessage(id, text) {
    const record = this.get(id);
    if (!record || record.named) return record;
    const words = String(text || "").replace(/\s+/g, " ").trim();
    if (!words) return record;
    const name = words.length > 60 ? `${words.slice(0, 60).replace(/\s+\S*$/, "")}…` : words;
    const next = { ...record, name, named: true };
    this.store.setValue(KEY, { ...this.all(), [id]: next });
    return next;
  }
}
