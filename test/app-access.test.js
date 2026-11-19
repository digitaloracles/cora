import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { panelHarness } from "./panel.js";

const PLAIN = "claude/claude-opus-5-5";

async function appWorld(t) {
  const f = await knowledgeWorld(); t.after(f.close);
  const pair = async (actor, state = "") => {
    const response = await f.request(actor, "/api/app/pairings", { method: "POST", body: state ? { state } : {} });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  const codeOf = (link) => new URL(link).searchParams.get("code");
  const exchange = async (code, name = "MacBook di prova") => {
    const response = await fetch(f.base + "/app/v1/session", { method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" }, body: JSON.stringify({ code, name, platform: "macOS 26" }) });
    return { status: response.status, data: await response.json() };
  };
  const read = async (token, path, extra = {}) => {
    const response = await fetch(f.base + path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const connect = async (actor) => (await exchange(codeOf((await pair(actor)).link))).data.token;
  return { ...f, pair, codeOf, exchange, read, connect };
}

function sse(base, token) {
  const controller = new AbortController(), events = [];
  const ready = fetch(base + "/app/v1/events", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200);
    const decoder = new TextDecoder(); let buffer = "";
    (async () => {
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
            if (data) events.push(JSON.parse(data));
          }
        }
      } catch {}
    })();
  });
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { if (events.some(check)) return events.find(check); await new Promise((resolve) => setTimeout(resolve, 20)); }
    throw new Error(`missing event: ${what}`);
  };
  return { ready, events, until, close: () => controller.abort() };
}

test("the panel pairs the macOS app once and the device token reads only that person's agents, quotas and usage", async (t) => {
  const f = await appWorld(t);
  const subscription = f.app.store.createSubscription({ provider: "claude", label: "Claude Max", connectedBy: { id: f.alice.user.id, name: "alice" } });
  f.app.store.updateSubscription(subscription.id, { status: "ready", email: "alice@claude.test", plan: "max" });
  const own = f.app.store.createAgent({ name: "Alice agent", brainOwnerId: f.alice.user.id, tools: false, enabled: true, model: PLAIN, subscriptionId: subscription.id });
  const other = f.app.store.createAgent({ name: "Bob agent", brainOwnerId: f.bob.user.id, tools: false, enabled: true });
  const spare = f.app.store.createSubscription({ provider: "codex", label: "ChatGPT", connectedBy: { id: f.alice.user.id, name: "alice" } });
  f.app.store.updateSubscription(spare.id, { status: "ready", email: "alice@openai.test" });
  const dropped = f.app.store.createSubscription({ provider: "grok", label: "Grok", connectedBy: { id: f.alice.user.id, name: "alice" } });
  f.app.store.updateSubscription(dropped.id, { status: "disconnected" });
  const bobs = f.app.store.createSubscription({ provider: "claude", label: "Claude", connectedBy: { id: f.bob.user.id, name: "bob" } });
  f.app.store.updateSubscription(bobs.id, { status: "ready", email: "bob@claude.test" });
  const record = f.app.store.subscription(subscription.id);
  f.app.store.setValue(`subscriptionUsage:${subscription.id}`, { identity: f.app.subscriptions.usage.identity(record), state: "ready", fetchedAt: new Date().toISOString(),
    windows: [{ id: "five_hour", kind: "session", group: "", usedPercent: 42, resetsAt: new Date(Date.now() + 3600000).toISOString(), minutes: null }], balances: [] });
  const done = f.app.traces.start({ agentId: own.id, kind: "chat", channelId: "web-" + own.id, model: PLAIN });
  done.spent({ in: 1200, out: 300 }); done.finish({ status: "ok", output: "fatto" });
  const foreign = f.app.traces.start({ agentId: other.id, kind: "chat", channelId: "web-" + other.id, model: PLAIN });
  foreign.spent({ in: 999, out: 1 }); foreign.finish({ status: "ok", output: "privato" });

  assert.equal((await fetch(f.base + "/api/app/pairings", { method: "POST", headers: { "X-Cora": "1", "Content-Type": "application/json" }, body: "{}" })).status, 401, "pairing needs the panel session");
  assert.equal((await f.request(f.alice, "/api/app/pairings", { method: "POST", body: { state: "short" } })).status, 400);
  const pairing = await f.pair(f.alice, "state-from-the-app-0123456789");
  const link = new URL(pairing.link);
  assert.equal(link.protocol, "cora:"); assert.equal(link.host, "connect");
  assert.equal(link.searchParams.get("server"), f.base); assert.equal(link.searchParams.get("state"), "state-from-the-app-0123456789");
  assert.ok(Date.parse(pairing.expiresAt) - Date.now() <= 120000);
  assert.ok(!JSON.stringify(f.app.store.value("appPairings")).includes(f.codeOf(pairing.link)), "codes are stored hashed");

  const paired = await f.exchange(f.codeOf(pairing.link));
  assert.equal(paired.status, 201); assert.match(paired.data.token, /^cora_app_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(paired.data.user.id, f.alice.user.id); assert.equal(paired.data.device.name, "MacBook di prova");
  assert.equal(paired.data.device.hash, undefined);
  assert.equal((await f.exchange(f.codeOf(pairing.link))).status, 401, "a code works once");
  assert.ok(!JSON.stringify(f.app.store.value("appDevices")).includes(paired.data.token), "tokens are stored hashed");

  const token = paired.data.token;
  assert.equal((await f.read(null, "/app/v1/snapshot")).status, 401);
  assert.equal((await f.read(null, "/app/v1/snapshot", f.alice.headers)).status, 401, "the panel cookie does not replace the device token");
  const snapshot = await f.read(token, "/app/v1/snapshot");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.user.id, f.alice.user.id);
  assert.deepEqual(snapshot.data.agents.map((agent) => agent.name), ["Alice agent"]);
  const agent = snapshot.data.agents[0];
  assert.deepEqual(agent.accountIds, [subscription.id]);
  assert.deepEqual(agent.usage.today, { tokensIn: 1200, tokensOut: 300, turns: 1 });
  assert.equal(agent.usage.month.tokensIn, 1200);
  assert.ok(agent.avatar.startsWith(`/avatars/${own.id}.png`));
  const account = snapshot.data.accounts.find((item) => item.id === subscription.id);
  assert.equal(account.email, "alice@claude.test"); assert.deepEqual(account.agentIds, [own.id]);
  assert.equal(account.usage.windows[0].usedPercent, 42);
  assert.deepEqual(snapshot.data.accounts.map((item) => item.id).sort(), [subscription.id, spare.id].sort(), "every active subscription of the person, none disconnected, none of someone else");
  assert.deepEqual(snapshot.data.accounts.find((item) => item.id === spare.id).agentIds, [], "a subscription without agents is listed too");
  assert.ok(!JSON.stringify(snapshot.data).includes("privato") && !JSON.stringify(snapshot.data).includes(other.id), "another owner's agent stays private");

  assert.equal((await f.read(token, `/app/v1/traces/${done.id}`)).data.output, "fatto");
  assert.equal((await f.read(token, `/app/v1/traces/${foreign.id}`)).status, 403);
  assert.equal((await f.read(token, `/app/v1/agents/${own.id}/traces`)).data[0].id, done.id);
  assert.equal((await f.read(token, `/app/v1/agents/${other.id}/traces`)).status, 403);
  const history = await f.read(token, "/app/v1/usage?days=365");
  assert.equal(history.status, 200);
  assert.equal(history.data.days, 365); assert.match(history.data.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(history.data.usage.map((row) => [row.agentId, row.tokensIn, row.tokensOut, row.turns]), [[own.id, 1200, 300, 1]], "a year of daily usage, only the person's own agents");
  const write = await fetch(f.base + "/app/v1/snapshot", { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Cora": "1" } });
  assert.equal(write.status, 405, "the app only reads");

  const devices = await f.request(f.alice, "/api/app/devices");
  assert.equal(devices.data.devices.length, 1); assert.equal(devices.data.devices[0].hash, undefined);
  assert.equal((await f.request(f.bob, "/api/app/devices")).data.devices.length, 0);
  assert.equal((await f.request(f.bob, `/api/app/devices/${paired.data.device.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await f.request(f.alice, `/api/app/devices/${paired.data.device.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await f.read(token, "/app/v1/snapshot")).status, 401, "a revoked device stops at once");
});

test("the app stream carries live reasoning for its own agents only and closes when the device is revoked", async (t) => {
  const f = await appWorld(t);
  const own = f.app.store.createAgent({ name: "Live agent", brainOwnerId: f.alice.user.id, tools: false, enabled: true });
  const other = f.app.store.createAgent({ name: "Hidden agent", brainOwnerId: f.bob.user.id, tools: false, enabled: true });
  const token = await f.connect(f.alice);
  const stream = sse(f.base, token); t.after(stream.close);
  await stream.ready;
  await stream.until((event) => event.type === "hello", "hello");
  const hidden = f.app.traces.start({ agentId: other.id, kind: "chat", channelId: "web-" + other.id });
  hidden.add({ type: "thinking", text: "segreto di Bob" });
  const trace = f.app.traces.start({ agentId: own.id, kind: "chat", channelId: "web-" + own.id });
  trace.add({ type: "thinking", text: "Controllo le quote prima di rispondere" });
  const step = await stream.until((event) => event.type === "trace" && event.event === "step" && event.traceId === trace.id, "own step");
  assert.equal(step.step.text, "Controllo le quote prima di rispondere");
  const snapshot = await f.read(token, "/app/v1/snapshot");
  const live = snapshot.data.agents[0];
  assert.equal(live.state, "working");
  assert.equal(live.live[0].traceId, trace.id);
  assert.equal(live.live[0].lastStep.text, "Controllo le quote prima di rispondere");
  trace.finish({ status: "ok", output: "ok" }); hidden.finish({ status: "ok" });
  await stream.until((event) => event.type === "trace" && event.event === "end" && event.trace.id === trace.id, "own end");
  assert.ok(!stream.events.some((event) => JSON.stringify(event).includes("segreto di Bob") || JSON.stringify(event).includes(other.id)), "another owner's reasoning never reaches the app");
  const device = (await f.request(f.alice, "/api/app/devices")).data.devices[0];
  await f.request(f.alice, `/api/app/devices/${device.id}`, { method: "DELETE" });
  await stream.until((event) => event.type === "access-revoked", "revocation");
});

test("pairing codes expire, are refused to MCP tokens and throttle guesses", async (t) => {
  const f = await appWorld(t);
  const mcp = (await f.request(f.alice, "/api/mcp/tokens", { method: "POST", body: { name: "client" } })).data;
  const rpc = await fetch(f.base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cora_request", arguments: { method: "POST", path: "/api/app/pairings", body: {} } } }) });
  assert.equal((await rpc.json()).result.structuredContent.status, 403, "an MCP token cannot mint app access");
  const pairing = await f.pair(f.alice);
  const records = f.app.store.value("appPairings");
  f.app.store.setValue("appPairings", records.map((record) => ({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() })));
  assert.equal((await f.exchange(f.codeOf(pairing.link))).status, 401, "an expired code is refused");
  for (let i = 0; i < 9; i++) assert.equal((await f.exchange(`cora_pair_${"A".repeat(43)}`)).status, 401);
  const fresh = await f.pair(f.alice);
  assert.equal((await f.exchange(f.codeOf(fresh.link))).status, 429, "guessing is throttled");
});

test("the authorize page names the device it runs on and the account it authorizes, and warns when that account has no agents", async (t) => {
  const f = await appWorld(t);
  f.app.store.createAgent({ name: "Alice agent", brainOwnerId: f.alice.user.id, tools: false, enabled: true });
  const open = async (actor, userAgent, maxTouchPoints = 0) => {
    const posted = [];
    const panel = panelHarness({ language: "en", hash: "#/settings/app?state=state-from-the-app-0123456789", userAgent, maxTouchPoints, fetch: async (path, options = {}) => {
      if (options.method === "POST") posted.push(JSON.parse(options.body));
      const response = await f.request(actor, path, { method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
      return { ok: response.status < 400, status: response.status, json: async () => response.data };
    } });
    panel.run(`S.data = ${JSON.stringify((await f.request(actor, "/api/state")).data)}`);
    const pane = panel.run("(() => { const pane = macAppPane(); app.append(pane); return pane; })()");
    await pane.readyApp;
    return { pane, posted, primary: pane.querySelector(".primary") };
  };
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";

  const empty = await open(f.bob, iphone);
  assert.equal(empty.primary.textContent, "Authorize this iPhone");
  assert.match(empty.pane.textContent, /Cora app on your iPhone is asking/);
  assert.match(empty.pane.textContent, /Authorizing as/); assert.match(empty.pane.textContent, /bob@owner\.test/); assert.match(empty.pane.textContent, /0 agents/);
  assert.match(empty.pane.querySelector(".warn").textContent, /This account has no agents: the app would stay empty/);
  assert.ok(!empty.pane.textContent.includes("Mac"), "an iPhone is never called a Mac");
  assert.ok(!empty.pane.textContent.includes("Download the app"), "the Mac download is not offered on a phone");

  const ipad = await open(f.alice, mac, 5);
  assert.equal(ipad.primary.textContent, "Authorize this iPad", "iPadOS Safari reports a Mac but has touch");

  const own = await open(f.alice, mac);
  assert.equal(own.primary.textContent, "Authorize this Mac");
  assert.match(own.pane.textContent, /alice@owner\.test/); assert.match(own.pane.textContent, /1 agent(?!s)/);
  assert.equal(own.pane.querySelector(".warn"), null, "an account with agents gets no warning");
  await own.primary.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(own.posted, [{ state: "state-from-the-app-0123456789" }], "the button still starts the pairing for the app's state");
});
