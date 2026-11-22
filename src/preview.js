import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The demo space (NOT-94): each company that asks for a preview on usecora.space gets its own sealed
 * agents here, a personal link for each of its people, and one hour from its first message. A company
 * is a group: its guests, its agents and its clock. The pipeline (src/preview-pipeline.js) fills it.
 */
export const PREVIEW_WINDOWS_KEY = "previewWindows";
export const PREVIEW_GUESTS_KEY = "previewGuests";
export const PREVIEW_GROUPS_KEY = "previewGroups";
/** What a preview agent may use: its own memory and the pictures it is sent. No routines, mail, files or connectors. */
export const PREVIEW_TOOLS = new Set(["read_attachment", "remember", "recall", "forget", "create_file"]);

export const previewTokenHash = (token) => createHash("sha256").update(String(token || "")).digest("hex");
export const previewGuestId = (email) => `preview-${createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex").slice(0, 16)}`;
/** The language of the request a guest's link came from: the demo chat speaks it, whatever the browser says. */
export const previewLang = (value) => (["en", "it", "es", "de"].includes(String(value || "").slice(0, 2).toLowerCase()) ? String(value).slice(0, 2).toLowerCase() : "");
const GUEST_WRITES = /^\/api\/rooms\/web-[\w-]+\/messages$/;
/** All a guest reads: its clock and agents, their chats and the files they made. The rest of the space stays closed. */
const GUEST_READS = /^\/api\/(?:state|rooms\/web-[\w-]+\/messages|files\/[^/]+)$/;

export class PreviewWindow {
  constructor({ store, minutes = 0, now = () => Date.now() }) {
    this.store = store;
    this.minutes = Number(minutes) > 0 ? Number(minutes) : 0;
    this.now = now;
  }

  get enabled() { return this.minutes > 0; }
  guests() { return this.store.value(PREVIEW_GUESTS_KEY, []) || []; }

  /** The guest record behind a panel user, or null for anyone else (the space's own people). */
  guestOf(user) {
    if (!this.enabled || !user?.id?.startsWith("preview-")) return null;
    return this.guests().find((guest) => previewGuestId(guest.email) === user.id) || null;
  }

  groupState(group) {
    const startedAt = Number((this.store.value(PREVIEW_WINDOWS_KEY, {}) || {})[group]) || null;
    const endsAt = startedAt ? startedAt + this.minutes * 60000 : null;
    return { minutes: this.minutes, startedAt, endsAt, ended: Boolean(endsAt && this.now() >= endsAt) };
  }

  /** The agents of the company this guest's link opens: the only chats it reads or writes. */
  groupAgentIds(guest) {
    const group = (this.store.value(PREVIEW_GROUPS_KEY, []) || []).find((entry) => entry.id === guest?.group && !entry.removedAt);
    return (group?.agentIds || []).map(String);
  }

  /** The viewer's clock, company and agents; null for the space's own people. */
  state(user) {
    const guest = this.guestOf(user);
    if (!guest) return null;
    const group = (this.store.value(PREVIEW_GROUPS_KEY, []) || []).find((entry) => entry.id === guest.group && !entry.removedAt);
    const agents = (group?.agentIds || []).map((id, i) => ({ id, name: group.agents[i]?.name || "", role: group.agents[i]?.role || "", color: group.agents[i]?.color || "#264cd6", starters: group.agents[i]?.starters || [] })).filter((agent) => this.store.agent(agent.id));
    return { ...this.groupState(guest.group), company: group?.company || "", lang: previewLang(guest.lang || group?.lang), agents };
  }

  /** The company's first message starts its hour; later ones leave it where it is. */
  start(user) {
    const guest = this.guestOf(user);
    if (!guest) return null;
    const windows = this.store.value(PREVIEW_WINDOWS_KEY, {}) || {};
    if (!windows[guest.group]) this.store.setValue(PREVIEW_WINDOWS_KEY, { ...windows, [guest.group]: this.now() });
    return this.groupState(guest.group);
  }

  /** What a guest may not do: anything after the hour, and anything but writing to an agent before it. */
  refusal(user, method, path) {
    const guest = this.guestOf(user);
    if (!guest || path === "/api/logout") return "";
    const room = /^\/api\/rooms\/web-([\w-]+)\/messages$/.exec(path);
    if (room && !this.groupAgentIds(guest).includes(room[1])) return "Questa chat è di un'altra anteprima.";
    if (["GET", "HEAD"].includes(method)) return GUEST_READS.test(path) ? "" : "Nell'anteprima puoi solo leggere la chat dei tuoi agenti.";
    if (this.groupState(guest.group).ended) return "L'anteprima è finita: l'ora di prova è scaduta.";
    return GUEST_WRITES.test(path) ? "" : "Nell'anteprima puoi solo scrivere ai tuoi agenti.";
  }

  /** The guest whose link this is, or null; { ended: true } when that company's hour is over. */
  guestFor(token) {
    if (!this.enabled || !token) return null;
    const hash = Buffer.from(previewTokenHash(token));
    for (const guest of this.guests()) {
      const expected = Buffer.from(String(guest.tokenHash || ""));
      if (expected.length !== hash.length || !timingSafeEqual(expected, hash)) continue;
      if (this.groupState(guest.group).ended) return { ended: true };
      return { id: previewGuestId(guest.email), name: String(guest.name || guest.email || ""), email: String(guest.email || "").toLowerCase(), avatar: "", role: "member", emailVerified: true, source: "local" };
    }
    return null;
  }
}
