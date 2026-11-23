import { randomBytes } from "node:crypto";

const KEY = "openChoices";
const OPEN_DAYS = 7;
const KEEP_DAYS = 2;
const MAX = 200;

/**
 * The questions agents asked with ask_owner and answers to choose from: kept so the native apps can show them
 * and press one. A question stays open until one of its answers is pressed anywhere, the person answers it in
 * words, or a week goes by; answered ones stay two days so an app that pressed late learns what was chosen.
 */
export class OpenChoices {
  constructor({ store, now = Date.now }) { Object.assign(this, { store, now }); }

  all() {
    const now = this.now();
    return this.store.value(KEY, []).map((record) => record.status === "open" && now - Date.parse(record.askedAt) > OPEN_DAYS * 86400000 ? { ...record, status: "expired" } : record)
      .filter((record) => record.status === "open" || now - Date.parse(record.answeredAt || record.askedAt) < KEEP_DAYS * 86400000);
  }

  open() { return this.all().filter((record) => record.status === "open"); }
  get(id) { return this.all().find((record) => record.id === id) || null; }

  add({ agentId, channelId, question, choices, ref = {} }) {
    const record = { id: `ch_${randomBytes(6).toString("hex")}`, agentId, channelId, question: String(question || "").slice(0, 1500), choices: [...choices],
      askedAt: new Date(this.now()).toISOString(), status: "open", ref };
    // A new question from the same agent in the same thread takes the place of the one still open there.
    const records = this.all().map((item) => item.status === "open" && item.agentId === agentId && item.channelId === channelId ? { ...item, status: "superseded", answeredAt: record.askedAt } : item);
    this.store.setValue(KEY, [...records, record].slice(-MAX));
    return record;
  }

  /** Closes the first open question that matches: by id, by the message it went out on, or the latest of an agent in a thread. */
  resolve(match, { answer = "", by = "", via = "", status = "answered" } = {}) {
    const records = this.all();
    const found = records.filter((record) => record.status === "open" && match(record)).at(-1);
    if (!found) return null;
    Object.assign(found, { status, answer: String(answer).slice(0, 200), answeredBy: String(by).slice(0, 80), via, answeredAt: new Date(this.now()).toISOString() });
    this.store.setValue(KEY, records);
    return found;
  }
}
