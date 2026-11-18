import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PAIRINGS = "appPairings";
const DEVICES = "appDevices";
const PAIRING_MS = 2 * 60 * 1000;
const DEVICE_DAYS = 180;
const MAX_DEVICES = 20;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const same = (stored, value) => /^[a-f0-9]{64}$/.test(stored || "") && timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(hash(value), "hex"));
const publicDevice = ({ hash: _hash, userId: _userId, ...record }) => record;
const cleanName = (value, fallback) => {
  const name = String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || fallback;
};

/**
 * The native apps' access to a space. The panel issues a one-time code for the person signed in and hands it
 * to the app through its cora:// link; the app trades it for a device token that only reads. Codes and tokens
 * are stored as SHA-256 hashes, a code lives two minutes and works once, a device lasts 180 days or until revoked.
 */
export class AppAccess {
  constructor({ store, now = Date.now }) { Object.assign(this, { store, now, failures: [] }); }

  pairings() { return this.store.value(PAIRINGS, []).filter((record) => Date.parse(record.expiresAt) > this.now()); }
  devices() { return this.store.value(DEVICES, []); }

  pair(user, { state = "", origin }) {
    if (state && !/^[A-Za-z0-9_-]{16,128}$/.test(String(state))) throw fail("Stato dell’app non valido.");
    const code = `cora_pair_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(this.now() + PAIRING_MS).toISOString();
    const pending = this.pairings(), own = pending.filter((record) => record.userId === user.id).slice(-4);
    this.store.setValue(PAIRINGS, [...pending.filter((record) => record.userId !== user.id), ...own, { hash: hash(code), userId: user.id, expiresAt }]);
    const link = new URL("cora://connect");
    link.searchParams.set("server", origin);
    link.searchParams.set("code", code);
    if (state) link.searchParams.set("state", state);
    return { link: link.href, expiresAt };
  }

  /** Trades a pairing code for a device token: once, within its two minutes, for a person still admitted. */
  exchange({ code, name, platform }) {
    const now = this.now();
    while (this.failures.length && now - this.failures[0] > 60000) this.failures.shift();
    if (this.failures.length >= 10) throw fail("Troppi tentativi, riprova tra un minuto.", 429);
    const value = String(code || "");
    const pairings = this.pairings();
    const found = /^cora_pair_[A-Za-z0-9_-]{43}$/.test(value) ? pairings.find((record) => same(record.hash, value)) : null;
    if (!found) { this.failures.push(now); throw fail("Codice di collegamento non valido o scaduto: riaprilo dal pannello.", 401); }
    this.store.setValue(PAIRINGS, pairings.filter((record) => record !== found));
    const user = this.store.panelUser(found.userId);
    if (!user || !this.store.allowsPanelUser({ ...user, emailVerified: true })) throw fail("Questo account non entra più in questo spazio.", 403);
    const devices = this.devices().filter((record) => Date.parse(record.expiresAt) > now);
    const own = devices.filter((record) => record.userId === user.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const kept = own.length >= MAX_DEVICES ? devices.filter((record) => record.id !== own[0].id) : devices;
    const id = randomBytes(8).toString("hex"), token = `cora_app_${id}.${randomBytes(32).toString("base64url")}`;
    const record = { id, userId: user.id, name: cleanName(name, "Mac"), platform: cleanName(platform, "macOS").slice(0, 40), hash: hash(token),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + DEVICE_DAYS * 86400000).toISOString(), lastUsedAt: null };
    this.store.setValue(DEVICES, [...kept, record]);
    return { token, user, device: publicDevice(record) };
  }

  authenticate(req) {
    const token = /^Bearer (cora_app_[a-f0-9]{16}\.[A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ""))?.[1];
    if (!token) return null;
    const id = token.slice(9, 25), devices = this.devices(), record = devices.find((item) => item.id === id);
    if (!record || !same(record.hash, token) || !(Date.parse(record.expiresAt) > this.now())) return null;
    const user = this.store.panelUser(record.userId);
    if (!user || !this.store.allowsPanelUser({ ...user, emailVerified: true })) return null;
    if (!record.lastUsedAt || this.now() - Date.parse(record.lastUsedAt) > 60000) {
      record.lastUsedAt = new Date(this.now()).toISOString(); this.store.setValue(DEVICES, devices);
    }
    return { user, device: record };
  }

  list(user) { return this.devices().filter((record) => record.userId === user.id).map(publicDevice); }

  revoke(user, id) {
    const devices = this.devices();
    if (!devices.some((record) => record.id === id && record.userId === user.id)) throw fail("Dispositivo non trovato.", 404);
    this.store.setValue(DEVICES, devices.filter((record) => record.id !== id));
  }

  active(id) { return this.devices().some((record) => record.id === id && Date.parse(record.expiresAt) > this.now()); }
}
