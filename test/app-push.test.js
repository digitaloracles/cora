import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http2";
import { test } from "node:test";
import { Apns } from "../src/apns.js";
import { QuotaAlerts } from "../src/quota-alerts.js";
import { knowledgeWorld } from "./knowledge-fixtures.js";

const TOKEN_A = "a".repeat(64), TOKEN_B = "b".repeat(64);

async function pushWorld(t) {
  const f = await knowledgeWorld(); t.after(f.close);
  const connect = async (actor, name) => {
    const pairing = await f.request(actor, "/api/app/pairings", { method: "POST", body: {} });
    const code = new URL(pairing.data.link).searchParams.get("code");
    const response = await fetch(f.base + "/app/v1/session", { method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify({ code, name, platform: "iOS 26" }) });
    return (await response.json()).token;
  };
  const register = async (token, body) => {
    const response = await fetch(f.base + "/app/v1/push", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const sent = [];
  const apns = { answers: new Map(), async send(token, notice, options) { sent.push({ token, ...notice, ...options }); return this.answers.get(token) || { status: 200, reason: "" }; } };
  f.app.push.apns = apns;
  return { ...f, connect, register, sent, apns };
}

test("an iPhone registers its APNs token and the owner's notifications reach only that person's devices", async (t) => {
  const f = await pushWorld(t);
  const alice = await f.connect(f.alice, "iPhone di Alice"), bob = await f.connect(f.bob, "iPhone di Bob");
  assert.equal((await f.register(alice, { token: "not-a-token" })).status, 400);
  const unauthorized = await fetch(f.base + "/app/v1/push", { method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify({ token: TOKEN_A }) });
  assert.equal(unauthorized.status, 401);
  const registered = await f.register(alice, { token: TOKEN_A.toUpperCase(), environment: "sandbox" });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.deepEqual(registered.data, { notifications: true, environment: "sandbox", enabled: true });
  assert.equal((await f.register(bob, { token: TOKEN_B })).status, 200);
  const devices = await f.request(f.alice, "/api/app/devices");
  assert.equal(devices.status, 200);
  assert.ok(devices.data.devices.every((device) => device.notifications === true && !("push" in device) && !JSON.stringify(device).includes(TOKEN_A)));

  const result = await f.app.push.notify({ userId: f.alice.user.id, title: "Planner", body: "Ti chiede una cosa", url: "/#/thread/1", tag: "request-1" });
  assert.equal(f.sent.length, 1);
  assert.deepEqual({ token: f.sent[0].token, title: f.sent[0].title, environment: f.sent[0].environment, url: f.sent[0].data.url }, { token: TOKEN_A, title: "Planner", environment: "sandbox", url: "/#/thread/1" });
  assert.ok(result.sent >= 1);
  await f.app.push.notify({ userId: "unavailable", title: "Nobody" });
  assert.equal(f.sent.length, 1, "a notice for nobody reaches no device");

  f.apns.answers.set(TOKEN_A, { status: 410, reason: "Unregistered" });
  await f.app.push.notify({ userId: f.alice.user.id, title: "Again" });
  assert.equal(f.sent.length, 2);
  await f.app.push.notify({ userId: f.alice.user.id, title: "Gone" });
  assert.equal(f.sent.length, 2, "a token APNs dropped is not used again");
  const after = await f.request(f.alice, "/api/app/devices");
  assert.equal(after.data.devices.length, 1, "the device itself stays paired");
  assert.equal(after.data.devices[0].notifications, false);
});

test("an agent's plan turning blocked notifies its owner once, again only after it was unblocked", async (t) => {
  const f = await pushWorld(t);
  const token = await f.connect(f.alice, "iPhone di Alice");
  await f.register(token, { token: TOKEN_A, environment: "sandbox" });
  const agent = f.app.store.createAgent({ name: "Planner", brainOwnerId: f.alice.user.id, tools: false, enabled: true });
  const plans = f.app.store.plans, channel = "800000000000000181";
  let plan = plans.create(channel, agent.id, { name: "Release the app", items: ["Server", "iOS"] });
  assert.equal(f.sent.length, 0);
  plan = plans.change(channel, agent.id, "update", { ...plan, blocked_reason: "Waiting for the APNs key" });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, "Planner è bloccato");
  assert.equal(f.sent[0].body, "Release the app · Waiting for the APNs key");
  assert.deepEqual([f.sent[0].data.planId, f.sent[0].data.channelId, f.sent[0].data.kind], [plan.id, channel, "plan-blocked"]);
  plan = plans.change(channel, agent.id, "update", { ...plan, blocked_reason: "Still waiting" });
  assert.equal(f.sent.length, 1, "a blocker reworded is not a new alert");
  plan = plans.change(channel, agent.id, "update", { ...plan, blocked_reason: "" });
  plan = plans.change(channel, agent.id, "update", { ...plan, blocked_reason: "Blocked again" });
  assert.equal(f.sent.length, 2);
});

test("quota alerts fire at 25% and 5% left, once per window period", () => {
  const values = {}, notices = [];
  const now = Date.parse("2026-11-19T10:00:00Z");
  const usage = { state: "ready", stale: false, windows: [] };
  const store = { settings: { language: "it" }, value: (key, fallback) => values[key] ?? fallback, setValue: (key, value) => { values[key] = value; } };
  const subscriptions = { list: () => [{ id: "sub_1", provider: "claude", label: "", status: "ready", connectedBy: { id: "owner-alice" } }], usage: { get: () => usage } };
  const alerts = new QuotaAlerts({ store, subscriptions, notify: (notice) => { notices.push(notice); return Promise.resolve(); }, ownerOf: (record) => record.connectedBy.id, timezone: "Europe/Rome", now: () => now });
  const set = (used, resetsAt = "2026-11-19T13:00:00.000Z", extra = {}) => { usage.windows = [{ id: "five_hour", kind: "session", group: "", usedPercent: used, resetsAt, ...extra }]; };

  set(50); alerts.check(); assert.equal(notices.length, 0);
  set(76); alerts.check(); assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "Claude: resta il 24%");
  assert.match(notices[0].body, /^finestra di 5 ore · si azzera alle 14:00$/);
  assert.equal(notices[0].userId, "owner-alice");
  set(80); alerts.check(); assert.equal(notices.length, 1, "still under 25%: no repeat");
  set(97); alerts.check(); assert.equal(notices.length, 2);
  assert.equal(notices[1].title, "Claude: resta il 3%");
  set(99); alerts.check(); assert.equal(notices.length, 2);
  set(10, "2026-11-19T18:00:00.000Z"); alerts.check(); assert.equal(notices.length, 2, "a new period starts clean");
  set(96, "2026-11-19T18:00:00.000Z"); alerts.check(); assert.equal(notices.length, 3, "jumping past both thresholds sends one alert, the lower");
  assert.equal(notices[2].data.threshold, 5);
  set(99, "2026-11-19T18:00:00.000Z", { group: "Fable" }); alerts.check(); assert.equal(notices.length, 3, "model-scoped windows do not alert");
  usage.stale = true; set(99, "2026-11-20T18:00:00.000Z"); alerts.check(); assert.equal(notices.length, 3, "a stale reading does not alert");
});

test("Apns signs an ES256 token and posts the alert over HTTP/2 with topic, collapse id and payload", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const seen = [];
  const server = createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { body += chunk; });
    stream.on("end", () => {
      seen.push({ headers, body: JSON.parse(body) });
      const gone = headers[":path"].endsWith("b".repeat(64));
      stream.respond({ ":status": gone ? 410 : 200 });
      stream.end(gone ? JSON.stringify({ reason: "Unregistered" }) : "");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${server.address().port}`;
  const apns = new Apns({ key: privateKey.export({ type: "pkcs8", format: "pem" }), keyId: "KEY1234567", teamId: "TEAM123456", topic: "space.usecora.ios", hosts: { sandbox: host, production: host } });
  t.after(() => apns.close());
  const ok = await apns.send(TOKEN_A, { title: "Planner è bloccato", body: "Release the app", tag: "plan-1", data: { url: "/#/thread/1", planId: "p1" } }, { environment: "sandbox" });
  assert.deepEqual(ok, { status: 200, reason: "" });
  const gone = await apns.send(TOKEN_B, { title: "x" });
  assert.deepEqual(gone, { status: 410, reason: "Unregistered" });
  const [first] = seen;
  assert.equal(first.headers[":path"], `/3/device/${TOKEN_A}`);
  assert.equal(first.headers["apns-topic"], "space.usecora.ios");
  assert.equal(first.headers["apns-push-type"], "alert");
  assert.equal(first.headers["apns-collapse-id"], "plan-1");
  assert.deepEqual(first.body, { aps: { alert: { title: "Planner è bloccato", body: "Release the app" }, sound: "default", "thread-id": "plan-1" }, url: "/#/thread/1", planId: "p1" });
  const [head, claims, signature] = first.headers.authorization.replace(/^bearer /, "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "ES256", kid: "KEY1234567" });
  assert.equal(JSON.parse(Buffer.from(claims, "base64url")).iss, "TEAM123456");
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  assert.equal(seen[1].headers.authorization, first.headers.authorization, "the token is reused within its 45 minutes");
});
