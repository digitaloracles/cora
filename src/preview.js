import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A custom agent preview space (NOT-94): one company, sealed agents, open for a fixed time
 * from the company's first message. The window and the guests live in the space's own store;
 * the preview pipeline on the host reads them and reports to usecora.space.
 */
export const PREVIEW_WINDOW_KEY = "previewWindow";
export const PREVIEW_GUESTS_KEY = "previewGuests";

export const previewTokenHash = (token) => createHash("sha256").update(String(token || "")).digest("hex");
export const previewGuestId = (email) => `preview-${createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex").slice(0, 16)}`;

export class PreviewWindow {
  constructor({ store, minutes = 0, now = () => Date.now() }) {
    this.store = store;
    this.minutes = Number(minutes) > 0 ? Number(minutes) : 0;
    this.now = now;
  }

  get enabled() { return this.minutes > 0; }

  state() {
    if (!this.enabled) return null;
    const saved = this.store.value(PREVIEW_WINDOW_KEY, null);
    const startedAt = Number(saved?.startedAt) || null;
    const endsAt = startedAt ? startedAt + this.minutes * 60000 : null;
    return { minutes: this.minutes, startedAt, endsAt, ended: Boolean(endsAt && this.now() >= endsAt) };
  }

  /** The first message starts the clock; later ones leave it where it is. */
  start() {
    const current = this.state();
    if (!current || current.startedAt) return current;
    this.store.setValue(PREVIEW_WINDOW_KEY, { startedAt: this.now() });
    return this.state();
  }

  ended() { return Boolean(this.state()?.ended); }

  /** The guest whose link this is, or null. Links stop working when the window has ended. */
  guestFor(token) {
    if (!this.enabled || !token || this.ended()) return null;
    const hash = Buffer.from(previewTokenHash(token));
    for (const guest of this.store.value(PREVIEW_GUESTS_KEY, []) || []) {
      const expected = Buffer.from(String(guest.tokenHash || ""));
      if (expected.length === hash.length && timingSafeEqual(expected, hash) && (!guest.expiresAt || this.now() < guest.expiresAt)) {
        return { id: previewGuestId(guest.email), name: String(guest.name || guest.email || ""), email: String(guest.email || "").toLowerCase(), avatar: "", role: "member", emailVerified: true, source: "local" };
      }
    }
    return null;
  }
}
