import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { answerLeftovers, storeGroups } from "../src/preview-demo.js";
import { tempHome } from "./helpers.js";
import { runOnce } from "../src/preview-pipeline.js";
import { PREVIEW_TOOLS, PREVIEW_WINDOWS_KEY, previewGuestId } from "../src/preview.js";

const BRIEF = JSON.stringify({ summary: "Makes things.", products: ["Things"], audience: "People", tone: "Plain", focus: "plans" });

test("the demo space: each company sees only its sealed agents, may only write to them, and loses them one hour after its first message", async (t) => {
  const f = await knowledgeWorld({ previewMinutes: 60 }); t.after(f.close);
  let clock = Date.now();
  const previews = new Map();
  const mails = [];
  const first = [];
  const request = (id, email, company, site, archetype = "manager") => previews.set(id, { id, email, company, site, archetype, lang: "en", status: "requested", space: "" });
  const deps = {
    now: () => clock, log: () => {}, space: "demo", base: f.base, chat: async () => BRIEF,
    site: async (url) => [{ url, title: "Home", description: "A company", headings: [], text: "" }],
    mail: async (message) => { mails.push(message); },
    groups: storeGroups(f.app, { model: "ollama/gpt-oss:120b", minutes: 60 }),
    cloud: { list: async (status) => [...previews.values()].filter((item) => item.status === status), update: async (id, body) => { Object.assign(previews.get(id), body); }, firstMessage: async (id) => { first.push(id); } },
  };
  const linkOf = (to) => new URL(/https?:\/\/\S+\/auth\/preview\?token=[\w-]+/.exec(mails.find((mail) => mail.to === to).text)[0]);
  const linkOf2 = (to) => new URL(/https?:\/\/\S+\/auth\/preview\?token=[\w-]+/.exec(mails.findLast((mail) => mail.to === to).text)[0]);
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
  request("pv_g", "gina@globex.com", "Globex", "https://www.globex.com", "marketer");
  await runOnce(deps);
  assert.equal(previews.get("pv_a").status, "ready"); assert.equal(previews.get("pv_a").space, "demo");
  assert.equal(previews.get("pv_g").status, "ready");
  assert.equal(mails.length, 2);

  assert.equal((await signIn("/auth/preview?token=wrong")).status, 403);
  const anna = await signIn(linkOf("anna@acme.com").pathname + linkOf("anna@acme.com").search);
  assert.equal(anna.status, 200);
  assert.match(anna.body, /http-equiv="refresh" content="0;url=\/preview"/);
  const gina = await signIn(linkOf("gina@globex.com").pathname + linkOf("gina@globex.com").search);

  const annaState = (await call(anna.cookie, "/api/state")).data;
  const ginaState = (await call(gina.cookie, "/api/state")).data;
  assert.deepEqual(annaState.preview.agents.map((agent) => [f.app.store.agent(agent.id).name, Boolean(f.app.store.agent(agent.id).sealed)]), [["Mara · Acme", true]], "the agent of the archetype Acme chose");
  assert.deepEqual(ginaState.preview.agents.map((agent) => agent.name), ["Mia"]);
  assert.deepEqual(annaState.preview, { minutes: 60, startedAt: null, endsAt: null, ended: false, company: "Acme", agents: [{ id: annaState.preview.agents[0].id, name: "Mara", role: "Manager", color: "#264cd6", starters: [] }] });
  assert.deepEqual(Object.keys(annaState).sort(), ["currentUser", "preview"], "a guest's state carries its clock and agents, not the space's models, providers or agents");

  // The company only ever sees the demo chat: the panel sends it there, and the chat page is served.
  const home = await fetch(`${f.base}/`, { redirect: "manual", headers: { cookie: anna.cookie } });
  assert.equal(home.status, 302); assert.equal(home.headers.get("location"), "/preview");
  assert.equal((await fetch(`${f.base}/`, { redirect: "manual", headers: { cookie: f.admin.headers.Cookie } })).status, 200, "the space's own people keep the panel");
  const chat = await (await fetch(`${f.base}/preview`, { headers: { cookie: anna.cookie } })).text();
  assert.match(chat, /\/assets\/v\/[0-9a-f]{16}\/preview\.js/);
  assert.equal((await fetch(`${f.base}${/\/assets\/v\/[0-9a-f]{16}\/preview\.css/.exec(chat)[0]}`)).status, 200);
  assert.equal((await call(f.admin.headers.Cookie, "/api/state")).data.preview, null, "the space's own people have no clock");

  const acmeAgent = annaState.preview.agents[0].id;
  const globexAgent = ginaState.preview.agents[0].id;
  // Another company's agents and chats stay closed; a guest writes only to its own agents.
  assert.notEqual((await call(anna.cookie, `/api/rooms/web-${globexAgent}/messages`)).status, 200);
  assert.notEqual((await call(anna.cookie, `/api/rooms/web-${globexAgent}/messages`, { method: "POST", body: { text: "hi" } })).status, 201);
  await f.app.knowledge.ownerBrain(f.alice.user.id).write({ slug: "secret-plan", kind: "project", title: "Secret plan", body: "OWNER_ONLY", author: "librarian" });
  const pages = await call(anna.cookie, "/api/brain/pages");
  assert.doesNotMatch(JSON.stringify(pages.data), /OWNER_ONLY|secret-plan/, "the space owner's brain never reaches a guest");
  // A guest reads only its clock, its agents' chats and their files: the space's people and folders stay closed.
  for (const closed of ["/api/artifacts", "/api/brain/pages", "/api/agents", "/api/secrets", "/api/routines", "/api/connectors"]) {
    const read = await call(anna.cookie, closed);
    assert.equal(read.status, 403, `${closed} is closed to a guest`);
    assert.doesNotMatch(JSON.stringify(read.data), /gina@globex\.com|alice/i, `${closed} never lists the space's people`);
  }
  assert.equal((await call(anna.cookie, "/api/state")).status, 200);
  assert.equal((await call(anna.cookie, `/api/rooms/web-${acmeAgent}/messages`)).status, 200, "its own agent's chat stays readable");
  assert.equal((await call(f.admin.headers.Cookie, "/api/artifacts")).status, 200, "the space's own people still read their folders");
  const create = await call(anna.cookie, "/api/agents", { method: "POST", body: { name: "Mine", tools: false } });
  assert.equal(create.status, 403); assert.match(create.data.error, /solo scrivere ai tuoi agenti/);
  assert.equal((await call(anna.cookie, `/api/agents/${acmeAgent}`, { method: "PUT", body: { model: "deepseek/deepseek-v4-pro" } })).status, 403);

  // A colleague's different choice adds that agent, up to three per company; no more after that.
  request("pv_a2", "anna@acme.com", "Acme", "https://acme.com", "researcher");
  request("pv_a3", "anna@acme.com", "Acme", "https://acme.com", "analyst");
  request("pv_a4", "anna@acme.com", "Acme", "https://acme.com", "programmer");
  await runOnce(deps);
  assert.deepEqual(f.app.store.agents().filter((agent) => agent.name.endsWith("· Acme")).map((agent) => agent.name), ["Mara · Acme", "Iris · Acme", "Otto · Acme"]);
  assert.equal(mails.filter((mail) => mail.to === "anna@acme.com").length, 1, "the same person is not mailed again");
  assert.deepEqual((await call(anna.cookie, "/api/state")).data.preview.agents.map((agent) => agent.role), ["Manager", "Researcher", "Analyst"]);
  // Preview agents can only use their own memory and pictures: no routines, mail, files or connectors.
  for (const name of ["set_routine", "set_reminder", "email_send", "artifact_push", "ask_owner", "say", "shell"]) assert.equal(PREVIEW_TOOLS.has(name), false, name);

  // Acme's first message starts Acme's hour only, once.
  assert.equal((await call(anna.cookie, `/api/rooms/web-${acmeAgent}/messages`, { method: "POST", body: { text: "Hello" } })).status, 201);
  const started = (await call(anna.cookie, "/api/state")).data.preview;
  assert.ok(started.startedAt && started.endsAt === started.startedAt + 3600000);
  assert.equal((await call(gina.cookie, "/api/state")).data.preview.startedAt, null);
  await runOnce(deps); await runOnce(deps);
  assert.deepEqual(first, ["pv_a", "pv_a2", "pv_a3", "pv_a4"]);

  // A colleague at Acme asks too: same agents, a link of their own, no second set.
  request("pv_b", "bo@acme.com", "Acme", "https://acme.com/");
  await runOnce(deps);
  assert.equal(previews.get("pv_b").space, "demo");
  assert.equal(f.app.store.agents().filter((agent) => agent.name.endsWith("· Acme")).length, 3, "the same archetype is not made twice");
  const bo = await signIn(linkOf("bo@acme.com").pathname + linkOf("bo@acme.com").search);
  assert.deepEqual((await call(bo.cookie, "/api/state")).data.preview.agents.map((agent) => agent.id), (await call(anna.cookie, "/api/state")).data.preview.agents.map((agent) => agent.id));

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
  assert.equal((await call(gina.cookie, "/api/state")).data.preview.agents.length, 1, "Globex keeps its agent");

  // The same address asks for a second company: its new link opens that company only, never the first one's chats.
  request("pv_gi", "gina@globex.com", "Initech", "https://initech.com", "programmer");
  await runOnce(deps);
  const ginaInitech = await signIn(linkOf2("gina@globex.com").pathname + linkOf2("gina@globex.com").search);
  const initechState = (await call(ginaInitech.cookie, "/api/state")).data.preview;
  assert.equal(initechState.company, "Initech");
  for (const [method, body] of [["GET"], ["POST", { text: "hi" }]]) {
    const other = await call(ginaInitech.cookie, `/api/rooms/web-${globexAgent}/messages`, { method, body });
    assert.equal(other.status, 403, `${method} on another company's chat`);
    assert.doesNotMatch(JSON.stringify(other.data), /Still here/);
  }
  assert.equal((await call(ginaInitech.cookie, `/api/rooms/web-${initechState.agents[0].id}/messages`)).status, 200);
});

test("a restart never leaves a guest's message unanswered: the demo answers it on start, while the hour is open", async (t) => {
  const home = tempHome();
  const first = await knowledgeWorld({ previewMinutes: 60, home });
  const previews = new Map([["pv_r", { id: "pv_r", email: "rita@rest.com", company: "Rest", site: "https://rest.com", archetype: "manager", lang: "en", status: "requested", space: "" }],
    ["pv_o", { id: "pv_o", email: "olga@old.com", company: "Old", site: "https://old.com", archetype: "analyst", lang: "en", status: "requested", space: "" }]]);
  await runOnce({
    now: () => Date.now(), log: () => {}, space: "demo", base: first.base, chat: async () => BRIEF, mail: async () => {},
    site: async (url) => [{ url, title: "Home", description: "A company", headings: [], text: "" }],
    groups: storeGroups(first.app, { model: "ollama/gpt-oss:120b", minutes: 60 }),
    cloud: { list: async (status) => [...previews.values()].filter((item) => item.status === status), update: async (id, body) => { Object.assign(previews.get(id), body); }, firstMessage: async () => {} },
  });
  const groups = first.app.store.value("previewGroups", []);
  const rest = `web-${groups.find((entry) => entry.company === "Rest").agentIds[0]}`;
  const old = `web-${groups.find((entry) => entry.company === "Old").agentIds[0]}`;
  // The restart came while the agent was answering: the guest's message is stored, the answer never was.
  first.app.store.appendArchive(rest, { id: "web_cut", at: Date.now() - 20000, authorId: previewGuestId("rita@rest.com"), authorName: "rita@rest.com", kind: "owner", agentId: null, content: "Plan our launch" });
  first.app.store.appendArchive(old, { id: "web_old", at: Date.now() - 20 * 60000, authorId: previewGuestId("olga@old.com"), authorName: "olga@old.com", kind: "owner", agentId: null, content: "Too long ago" });
  first.app.store.setValue(PREVIEW_WINDOWS_KEY, { rest: Date.now() - 60000 });
  await first.close();

  const again = await knowledgeWorld({ previewMinutes: 60, home }); t.after(again.close);
  again.state.answer = () => ({ content: "Here is the launch plan." });
  assert.deepEqual(answerLeftovers(again.app, { minutes: 60 }), [rest], "only the recent unanswered message, not the one from twenty minutes ago");
  const until = Date.now() + 15000;
  while (Date.now() < until && !again.app.store.recentMessages(rest, 5).some((message) => message.agentId)) await new Promise((resolve) => setTimeout(resolve, 100));
  const answered = again.app.store.recentMessages(rest, 5);
  assert.equal(answered.at(-1).content, "Here is the launch plan.");
  assert.deepEqual(answered.map((message) => message.content), ["Plan our launch", "Here is the launch plan."], "the guest's message is kept, answered once");
  assert.deepEqual(answerLeftovers(again.app, { minutes: 60 }), [], "an answered room is left alone");

  again.app.store.appendArchive(rest, { id: "web_late", at: Date.now(), authorId: previewGuestId("rita@rest.com"), authorName: "rita@rest.com", kind: "owner", agentId: null, content: "After the hour" });
  again.app.store.setValue(PREVIEW_WINDOWS_KEY, { rest: Date.now() - 61 * 60000 });
  assert.deepEqual(answerLeftovers(again.app, { minutes: 60 }), [], "no answer after the company's hour");
});

test("a person who asks for a second company gets that company's chat, not the first one's", async (t) => {
  const f = await knowledgeWorld({ previewMinutes: 60 }); t.after(f.close);
  const previews = new Map();
  const mails = [];
  const request = (id, email, company, site, archetype = "manager") => previews.set(id, { id, email, company, site, archetype, lang: "en", status: "requested", space: "" });
  const deps = {
    now: () => Date.now(), log: () => {}, space: "demo", base: f.base, chat: async () => BRIEF,
    site: async (url) => [{ url, title: "Home", description: "A company", headings: [], text: "" }],
    mail: async (message) => { mails.push(message); },
    groups: storeGroups(f.app, { model: "ollama/gpt-oss:120b", minutes: 60 }),
    cloud: { list: async (status) => [...previews.values()].filter((item) => item.status === status), update: async (id, body) => { Object.assign(previews.get(id), body); }, firstMessage: async () => {} },
  };
  const linkOf = (to) => new URL(/https?:\/\/\S+\/auth\/preview\?token=[\w-]+/.exec(mails.filter((mail) => mail.to === to).at(-1).text)[0]);
  const signIn = async (url) => {
    const res = await fetch(`${f.base}${url.pathname}${url.search}`, { redirect: "manual", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    return { status: res.status, cookie: (res.headers.get("set-cookie") || "").split(";")[0], body: await res.text() };
  };
  const call = async (cookie, path) => (await (await fetch(`${f.base}${path}`, { headers: { cookie, "x-cora": "1" } })).json());

  request("pv_1", "anna@acme.com", "Acme", "https://acme.com");
  await runOnce(deps);
  request("pv_2", "anna@acme.com", "Beta", "https://beta.com");
  await runOnce(deps);

  const records = f.app.store.value("previewGuests", []).filter((guest) => guest.email === "anna@acme.com");
  assert.equal(records.length, 1, "one record per address");
  assert.equal(records[0].group, "beta", "the link follows the company she asked for last");

  const beta = await signIn(linkOf("anna@acme.com"));
  assert.equal(beta.status, 200);
  const state = await call(beta.cookie, "/api/state");
  assert.equal(state.preview.company, "Beta", "the demo shows the company of the link she opened");
  assert.deepEqual(state.preview.agents.map((agent) => agent.name), ["Mara"], "and only its own agent");
  const room = async (name) => (await fetch(`${f.base}/api/rooms/web-${f.app.store.agents().find((agent) => agent.name === name).id}/messages`, { headers: { cookie: beta.cookie, "x-cora": "1" } })).status;
  assert.equal(await room("Mara · Beta"), 200, "and her own agent is reachable");
  assert.equal(await room("Mara · Acme"), 403, "the first company's chat stays closed to the second link");

  request("pv_3", "anna@acme.com", "Beta", "https://beta.com", "researcher");
  await runOnce(deps);
  assert.equal(mails.length, 2, "a known address gets no second mail");
  const again = await signIn(linkOf("anna@acme.com"));
  assert.equal((await call(again.cookie, "/api/state")).preview.company, "Beta", "the same link still opens Beta");
});
