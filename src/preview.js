import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The demo space (NOT-94): each company that asks for a preview on usecora.space gets its own sealed
 * agents here, a personal link for each of its people, and one hour from its first message. A company
 * is a group: its guests, its agents and its clock. The pipeline (src/preview-pipeline.js) fills it.
 */
export const PREVIEW_WINDOWS_KEY = "previewWindows";
export const PREVIEW_GUESTS_KEY = "previewGuests";

export const previewTokenHash = (token) => createHash("sha256").update(String(token || "")).digest("hex");
export const previewGuestId = (email) => `preview-${createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex").slice(0, 16)}`;
const GUEST_WRITES = /^\/api\/rooms\/web-[\w-]+\/messages$/;

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

  state(user) {
    const guest = this.guestOf(user);
    return guest ? this.groupState(guest.group) : null;
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
    if (!guest || ["GET", "HEAD"].includes(method) || path === "/api/logout") return "";
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
