import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { storeGroups } from "../src/preview-demo.js";
import { runOnce } from "../src/preview-pipeline.js";
import { PREVIEW_WINDOWS_KEY } from "../src/preview.js";

const BRIEF = JSON.stringify({ summary: "Makes things.", products: ["Things"], audience: "People", tone: "Plain", agents: [{ name: "Ava", role: "writer", focus: "posts" }, { name: "Leo", role: "support", focus: "answers" }, { name: "Mia", role: "research", focus: "plans" }] });

test("the demo space: each company sees only its sealed agents, may only write to them, and loses them one hour after its first message", async (t) => {
  const f = await knowledgeWorld({ previewMinutes: 60 }); t.after(f.close);
  let clock = Date.now();
  const previews = new Map();
  const mails = [];
  const first = [];
  const request = (id, email, company, site) => previews.set(id, { id, email, company, site, lang: "en", status: "requested", space: "" });
  const deps = {
    now: () => clock, log: () => {}, space: "demo", base: f.base, chat: async () => BRIEF,
    site: async (url) => [{ url, title: "Home", description: "A company", headings: [], text: "" }],
    mail: async (message) => { mails.push(message); },
    groups: storeGroups(f.app, { model: "ollama/gpt-oss:120b", minutes: 60 }),
    cloud: { list: async (status) => [...previews.values()].filter((item) => item.status === status), update: async (id, body) => { Object.assign(previews.get(id), body); }, firstMessage: async (id) => { first.push(id); } },
  };
  const linkOf = (to) => new URL(/https?:\/\/\S+\/auth\/preview\?token=[\w-]+/.exec(mails.find((mail) => mail.to === to).text)[0]);
  const signIn = async (path) => {
    const res = await fetch(`${f.base}${path}`, { redirect: "manual", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    return { status: res.status, cookie: (res.headers.get("set-cookie") || "").split(";")[0], body: await res.text() };
  };
  const call = async (cookie, path, { method = "GET", body } = {}) => {
    const res = await fetch(`${f.base}${path}`, { method, headers: { cookie, "x-cora": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch {}
    return { status: res.status, data };
  };

  request("pv_a", "anna@acme.com", "Acme", "https://acme.com");
  request("pv_g", "gina@globex.com", "Globex", "https://www.globex.com");
  await runOnce(deps);
  assert.equal(previews.get("pv_a").status, "ready"); assert.equal(previews.get("pv_a").space, "demo");
  assert.equal(previews.get("pv_g").status, "ready");
  assert.equal(mails.length, 2);

  assert.equal((await signIn("/auth/preview?token=wrong")).status, 403);
  const anna = await signIn(linkOf("anna@acme.com").pathname + linkOf("anna@acme.com").search);
  assert.equal(anna.status, 200);
  assert.match(anna.body, /http-equiv="refresh" content="0;url=\/"/);
  const gina = await signIn(linkOf("gina@globex.com").pathname + linkOf("gina@globex.com").search);

  const annaState = (await call(anna.cookie, "/api/state")).data;
  const ginaState = (await call(gina.cookie, "/api/state")).data;
  assert.deepEqual(annaState.agents.map((agent) => [agent.name, agent.sealed]), [["Ava · Acme", true], ["Leo · Acme", true], ["Mia · Acme", true]]);
  assert.deepEqual(ginaState.agents.map((agent) => agent.name), ["Ava · Globex", "Leo · Globex", "Mia · Globex"]);
  assert.deepEqual(annaState.preview, { minutes: 60, startedAt: null, endsAt: null, ended: false });
  assert.equal((await call(f.admin.headers.Cookie, "/api/state")).data.preview, null, "the space's own people have no clock");

  const acmeAgent = annaState.agents[0].id;
  const globexAgent = ginaState.agents[0].id;
  // Another company's agents and chats stay closed; a guest writes only to its own agents.
  assert.notEqual((await call(anna.cookie, `/api/rooms/web-${globexAgent}/messages`)).status, 200);
  assert.notEqual((await call(anna.cookie, `/api/rooms/web-${globexAgent}/messages`, { method: "POST", body: { text: "hi" } })).status, 201);
  await f.app.knowledge.ownerBrain(f.alice.user.id).write({ slug: "secret-plan", kind: "project", title: "Secret plan", body: "OWNER_ONLY", author: "librarian" });
  const pages = await call(anna.cookie, "/api/brain/pages");
  assert.doesNotMatch(JSON.stringify(pages.data), /OWNER_ONLY|secret-plan/, "the space owner's brain never reaches a guest");
  const create = await call(anna.cookie, "/api/agents", { method: "POST", body: { name: "Mine", tools: false } });
  assert.equal(create.status, 403); assert.match(create.data.error, /solo scrivere ai tuoi agenti/);
  assert.equal((await call(anna.cookie, `/api/agents/${acmeAgent}`, { method: "PUT", body: { model: "deepseek/deepseek-v4-pro" } })).status, 403);

  // Acme's first message starts Acme's hour only, once.
  assert.equal((await call(anna.cookie, `/api/rooms/web-${acmeAgent}/messages`, { method: "POST", body: { text: "Hello" } })).status, 201);
  const started = (await call(anna.cookie, "/api/state")).data.preview;
  assert.ok(started.startedAt && started.endsAt === started.startedAt + 3600000);
  assert.equal((await call(gina.cookie, "/api/state")).data.preview.startedAt, null);
  await runOnce(deps); await runOnce(deps);
  assert.deepEqual(first, ["pv_a"]);

  // A colleague at Acme asks too: same agents, a link of their own, no second set.
  request("pv_b", "bo@acme.com", "Acme", "https://acme.com/");
  await runOnce(deps);
  assert.equal(previews.get("pv_b").space, "demo");
  assert.equal(f.app.store.agents().filter((agent) => agent.name.endsWith("· Acme")).length, 3);
  const bo = await signIn(linkOf("bo@acme.com").pathname + linkOf("bo@acme.com").search);
  assert.deepEqual((await call(bo.cookie, "/api/state")).data.agents.map((agent) => agent.id), annaState.agents.map((agent) => agent.id));

  // Minute 59 still writes; minute 61 is refused for Acme, while Globex and the owner carry on.
  const setStart = (at) => f.app.store.setValue(PREVIEW_WINDOWS_KEY, { ...f.app.store.value(PREVIEW_WINDOWS_KEY, {}), acme: at });
  setStart(Date.now() - 59 * 60000);
  assert.equal((await call(anna.cookie, `/api/rooms/web-${acmeAgent}/messages`, { method: "POST", body: { text: "Minute 59" } })).status, 201);
  setStart(Date.now() - 61 * 60000);
  const late = await call(anna.cookie, `/api/rooms/web-${acmeAgent}/messages`, { method: "POST", body: { text: "Minute 61" } });
  assert.equal(late.status, 403); assert.match(late.data.error, /anteprima è finita/);
  assert.equal((await call(bo.cookie, "/api/state")).data.preview.ended, true);
  assert.equal((await signIn(linkOf("anna@acme.com").pathname + linkOf("anna@acme.com").search)).status, 410);
  assert.equal((await call(gina.cookie, `/api/rooms/web-${globexAgent}/messages`, { method: "POST", body: { text: "Still here" } })).status, 201);

  // Two minutes after the hour the pipeline removes Acme: agents, chats, links and access.
  clock = Date.now() + 3 * 60000;
  await runOnce(deps);
  assert.equal(f.app.store.agents().filter((agent) => agent.name.endsWith("· Acme")).length, 0);
  assert.equal(f.app.store.recentMessages(`web-${acmeAgent}`, 10).length, 0);
  assert.equal((await call(anna.cookie, "/api/state")).status, 401);
  assert.equal((await call(bo.cookie, "/api/state")).status, 401);
  assert.ok(!f.app.store.accessPolicy().emails.includes("anna@acme.com"));
  assert.equal((await call(gina.cookie, "/api/state")).data.agents.length, 3, "Globex keeps its agents");
});
