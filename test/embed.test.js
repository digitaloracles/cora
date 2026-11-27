import assert from "node:assert/strict";
import { test } from "node:test";
import { startCora } from "../src/main.js";
import { EMBED_LIMITS, embedDomain, frameAncestors } from "../src/embed.js";
import { encodePng } from "../src/png.js";
import { passKeys, signPass } from "../src/pass.js";
import { fakeDocker, fakeOllama, tempHome, waitFor } from "./helpers.js";

const keys = passKeys("fixture-embed-agent-signing-seed-0123456789abcdef");
const VISITOR_A = "a".repeat(40);
const VISITOR_B = "b".repeat(40);

test("embed sites are plain hosts, and the chat may be framed only by them", () => {
  assert.equal(embedDomain("https://Shop.Example.com/page?x=1"), "shop.example.com");
  assert.equal(embedDomain("*.example.it"), "*.example.it");
  assert.equal(embedDomain("localhost:5173"), "localhost:5173");
  assert.equal(embedDomain("javascript:alert(1)"), "");
  assert.equal(embedDomain("exa mple.com"), "");
  assert.equal(frameAncestors([]), "*");
  assert.equal(frameAncestors(["example.com", "localhost:3000"]), "'self' https://example.com http://localhost:3000 https://localhost:3000");
});

test("an agent's public chat: one conversation per visitor, no private context, owner-only settings, limits", async (t) => {
  const ollama = await fakeOllama(async (body) => ({ content: `Risposta a: ${body.messages.at(-1).content}` }));
  const docker = fakeDocker();
  const app = startCora({ home: tempHome(), host: "127.0.0.1", port: 0, insecureCookies: true, adminPassword: "fixture-password", useResidentSubscriptions: false,
    cloudUrl: "https://usecora.test", cloudKey: keys.publicKey, cloudSpace: "embed", sessionKey: "fixture-embed", telegramToken: "", ollamaKey: "test-ollama-key", ollamaUrl: ollama.url, orcaKey: "",
    claudeBin: "/missing/claude", codexBin: "/missing/codex", hermesBin: "/missing/hermes", grokBin: "/missing/grok", museBin: "/missing/muse",
    botTokenFor: () => "", docker: docker.path, startBoxes: false, schedulerTickMs: 3600000, ownerInstructions: "/missing/instructions", sshAuthorizedKeys: "/missing/keys", discordToken: "" });
  await app.ready;
  t.after(async () => { await app.stop(); await ollama.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = async (who) => (await fetch(`${base}/auth/cloud?${new URLSearchParams({ pass: signPass(keys.privateKey, { aud: "embed.usecora.test", emailVerified: true, ...who }) })}`, { redirect: "manual" })).headers.get("set-cookie")?.split(";")[0] || "";
  const call = async (cookie, path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, "X-Cora": "1", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const visit = async (path, visitor, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "X-Cora": "1", "X-Cora-Visitor": visitor, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
  };

  const owner = await login({ sub: "ac_seb", role: "owner", name: "Sebastiano Rossi", email: "sebastiano@dopamina.test" });
  await call(owner, "/api/access", { method: "PUT", body: { domains: ["dopamina.test"] } });
  const member = await login({ sub: "ac_marta", role: "member", name: "Marta Bianchi", email: "marta@dopamina.test" });
  const agent = (await call(owner, "/api/agents", { method: "POST", body: { name: "Lumen", model: "ollama/test-model", tools: true, description: "Assistente del negozio", personality: "Gentile e preciso." } })).data;
  app.store.setCore(agent.id, "SEGRETO-CORE: il fatturato di Seb è riservato.");
  app.store.addMemory(agent.id, "SEGRETO-MEMORIA: la password del Wi-Fi è nel cassetto.", "manual", { pinned: true });
  app.store.setAvatarImage(agent.id, encodePng(64, 64, Buffer.alloc(64 * 64 * 4, 90)));

  assert.equal((await call(member, `/api/agents/${agent.id}/embed`)).status, 403, "a member who does not manage the agent cannot open its embed");
  const first = (await call(owner, `/api/agents/${agent.id}/embed`)).data;
  assert.equal(first.enabled, false);
  assert.match(first.token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(first.path, `/embed/${first.token}`);
  assert.equal((await fetch(`${base}${first.path}`)).status, 404, "off by default");

  const bad = await call(owner, `/api/agents/${agent.id}/embed`, { method: "PUT", body: { domains: ["not a site"] } });
  assert.equal(bad.status, 400);
  const on = (await call(owner, `/api/agents/${agent.id}/embed`, { method: "PUT", body: { enabled: true, domains: ["https://shop.example.com/", "*.example.it"], brief: "Il negozio apre alle 9. Spedizione gratuita sopra 50 euro." } })).data;
  assert.equal(on.enabled, true);
  assert.deepEqual(on.domains, ["shop.example.com", "*.example.it"]);

  assert.deepEqual(on.theme, { accent: "#264cd6", background: "#f5f3ec", card: "#ffffff", text: "#0f1a3d" }, "Cora's colours until the owner picks others");
  assert.equal((await call(owner, `/api/agents/${agent.id}/embed`, { method: "PUT", body: { theme: { accent: "red; background:url(x)" } } })).status, 400, "only #rrggbb colours");
  const painted = (await call(owner, `/api/agents/${agent.id}/embed`, { method: "PUT", body: { theme: { accent: "#E4572E", background: "#0F1420" } } })).data;
  assert.deepEqual(painted.theme, { accent: "#e4572e", background: "#0f1420", card: "#ffffff", text: "#0f1a3d" });
  assert.equal(painted.brief, on.brief, "saving colours keeps the rest");

  const page = await fetch(`${base}${on.path}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/shop\.example\.com https:\/\/\*\.example\.it$/);
  assert.equal(page.headers.get("x-frame-options"), null, "frame-ancestors decides who frames it");
  assert.match(await page.text(), /\/assets\/v\/[^/]+\/embed\.js/);
  assert.equal((await fetch(`${base}/assets/embed.js`)).status, 200, "the page's script opens without a session");
  assert.equal((await fetch(`${base}/assets/embed.css`)).status, 200);

  const state = (await visit(`${on.path}/state`, VISITOR_A)).data;
  assert.equal(state.agent.name, "Lumen");
  assert.deepEqual(state.theme, painted.theme, "the page paints itself with the owner's colours");
  assert.equal((await fetch(`${base}${state.agent.avatar}`)).status, 200, "the avatar opens without a session");
  assert.doesNotMatch(JSON.stringify(state), /SEGRETO|Gentile|personality|model/);

  assert.equal((await visit(`${on.path}/messages`, "short")).status, 400, "a visitor needs a key");
  assert.equal((await visit(`${on.path}/messages`, VISITOR_A, { method: "POST", body: { text: "ciao" }, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await visit(`${on.path}/messages`, VISITOR_A, { method: "POST", body: { text: "x".repeat(EMBED_LIMITS.text + 1) } })).status, 400);

  const sent = await visit(`${on.path}/messages`, VISITOR_A, { method: "POST", body: { text: "A che ora aprite?" } });
  assert.equal(sent.status, 201);
  await waitFor(async () => (await visit(`${on.path}/messages`, VISITOR_A)).data.messages.some((item) => item.role === "agent"), { what: "embed reply" });
  const thread = (await visit(`${on.path}/messages`, VISITOR_A)).data;
  assert.deepEqual(thread.messages.map((item) => [item.role, item.content]), [["visitor", "A che ora aprite?"], ["agent", "Risposta a: A che ora aprite?"]]);
  assert.equal(thread.running, false);

  const request = ollama.calls.filter((item) => item.messages).at(-1);
  const system = request.messages[0].content;
  assert.match(system, /Lumen/);
  assert.match(system, /Il negozio apre alle 9/);
  assert.doesNotMatch(JSON.stringify(request), /SEGRETO|Sebastiano|dopamina/, "no core, memories or owner in the public turn");
  assert.ok(!request.tools || request.tools.length === 0, "no tools in the public turn");

  assert.deepEqual((await visit(`${on.path}/messages`, VISITOR_B)).data.messages, [], "another visitor sees nothing of the first");
  const owned = (await call(owner, `/api/agents/${agent.id}/embed`)).data;
  assert.equal(owned.conversations.length, 1);
  assert.equal(owned.conversations[0].opener, "A che ora aprite?");
  assert.equal(owned.visitorsToday, 1);
  const log = (await call(owner, `/api/agents/${agent.id}/embed/conversations/${owned.conversations[0].visitor}`)).data;
  assert.equal(log.messages.length, 2);
  const archive = JSON.stringify((await call(owner, "/api/rooms/web/messages")).data || {});
  assert.doesNotMatch(archive, /A che ora aprite/, "visitors' messages stay out of the panel chat");

  const limit = EMBED_LIMITS.perVisitorDay;
  EMBED_LIMITS.perVisitorDay = 2;
  t.after(() => { EMBED_LIMITS.perVisitorDay = limit; });
  assert.equal((await visit(`${on.path}/messages`, VISITOR_A, { method: "POST", body: { text: "Spedite?" } })).status, 201);
  assert.equal((await visit(`${on.path}/messages`, VISITOR_A, { method: "POST", body: { text: "Ancora?" } })).status, 429, "a visitor's daily limit");
  EMBED_LIMITS.perVisitorDay = limit;

  const rotated = (await call(owner, `/api/agents/${agent.id}/embed/token`, { method: "POST" })).data;
  assert.notEqual(rotated.token, on.token);
  assert.equal((await fetch(`${base}${on.path}`)).status, 404, "the old link stops working");
  assert.equal((await fetch(`${base}${rotated.path}`)).status, 200);

  await call(owner, `/api/agents/${agent.id}/embed`, { method: "PUT", body: { enabled: false } });
  assert.equal((await visit(`${rotated.path}/state`, VISITOR_A)).status, 404, "off again");

  assert.equal((await call(owner, `/api/agents/${agent.id}`, { method: "DELETE" })).status, 200);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM embed_messages WHERE agent_id = ?").get(agent.id).n, 0, "deleting the agent deletes its visitors' conversations");
});
