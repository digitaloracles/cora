import { createHash, randomBytes } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const CLAIM_MS = 120000;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The mail that tells a person a secret is waiting for them. Only a send for named people mails,
 * one message per address, once it is armed (created active or approved). The instance hands the
 * cloud a one-time nonce; the cloud calls back with a signed pass and gets the recipient, who sent
 * it, the reason and the link. Nothing of it is written to disk: the link carries the send's key.
 */
export class SecretNotices {
  constructor({ cloud, space, store }) {
    Object.assign(this, { cloud, space, store });
    this.pending = new Map();
    this.active = new Set();
    this.closed = false;
  }

  get enabled() { return Boolean(this.cloud && this.space) && !this.closed; }

  /** The reason only: the secret's name never leaves the vault, even when the reason repeats it. */
  static reason(send) {
    const text = String(send.reason ?? send.note ?? "").replace(/[\r\n]+/g, " ").trim().replace(/^(per|for)\s+/i, "").slice(0, 300);
    return send.name ? text.replace(new RegExp(escapeRegExp(send.name), "gi"), "…").trim() : text;
  }

  static recipients(send) {
    const access = send.access || {};
    if (access.mode !== "people") return [];
    return [...new Set((access.emails || []).map((email) => String(email || "").trim().toLowerCase()).filter(Boolean))];
  }

  /** Mails every named address of an armed send; resolves to [{ email, status }]. */
  notify(send, url) {
    const emails = SecretNotices.recipients(send);
    if (!emails.length || !url) return Promise.resolve([]);
    if (!this.enabled) return Promise.resolve(emails.map((email) => ({ email, status: "unavailable" })));
    const details = {
      sender: String(send.by?.name || "").replace(/[\r\n]/g, " ").slice(0, 120), space: this.space, reason: SecretNotices.reason(send),
      url, views: send.views, expiresAt: send.expiresAt, language: this.store.settings.language === "en" ? "en" : "it",
    };
    return Promise.all(emails.map((email) => this.deliver({ ...details, email })));
  }

  claim(nonce) {
    if (this.closed || !/^[A-Za-z0-9_-]{43}$/.test(String(nonce || ""))) return null;
    const hash = digest(nonce);
    const entry = this.pending.get(hash);
    this.pending.delete(hash);
    return entry && entry.until > Date.now() ? entry.details : null;
  }

  async deliver(details) {
    const nonce = randomBytes(32).toString("base64url");
    const hash = digest(nonce);
    this.pending.set(hash, { details, until: Date.now() + CLAIM_MS });
    const controller = new AbortController();
    this.active.add(controller);
    let status = "uncertain";
    try {
      const response = await fetch(`${this.cloud.url}/spaces/${encodeURIComponent(this.space)}/secret-sends`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ nonce }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]), redirect: "error",
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.sent === true) status = "sent";
      else if (result.error === "mail_unavailable" || response.status === 404) status = "unavailable";
      else if ([400, 403, 409, 429].includes(response.status)) status = "failed";
    } catch {}
    this.pending.delete(hash);
    this.active.delete(controller);
    return { email: details.email, status };
  }

  async stop() {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.pending.clear();
  }
}
