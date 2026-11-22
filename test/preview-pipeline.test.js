import assert from "node:assert/strict";
import { test } from "node:test";
import { agentName, agentSpecs, briefing, cleanCard, draftCard, previewEmail, publicAddress, readPage, readSite, runOnce, slugFor, tokenHash } from "../src/preview-pipeline.js";
import { startDraftDoor } from "../src/preview-demo.js";

function world({ chat = async () => JSON.stringify({ summary: "Acme makes rockets.", products: ["Rockets"], audience: "Space fans", tone: "Bold", archetype: "support", focus: "answers" }), siteFails = false } = {}) {
  let clock = Date.parse("2026-11-22T08:00:00Z");
  const previews = new Map();
  const calls = { first: [], mails: [], created: [], guests: [], removed: [] };
  const windows = new Map();
  let groups = [];
  const deps = {
    now: () => clock, log: () => {}, chat, space: "demo", base: "https://demo.usecora.space",
    site: async () => { if (siteFails) throw new Error("site answered 500"); return [{ url: "https://acme.com/", title: "Acme", description: "Rockets", headings: ["Rockets"], text: "Acme rockets" }]; },
    mail: async (message) => { calls.mails.push(message); },
    cloud: {
      list: async (status) => [...previews.values()].filter((item) => item.status === status),
      update: async (id, body) => { Object.assign(previews.get(id), { status: body.status, space: body.space || previews.get(id).space, note: body.note ?? previews.get(id).note }); },
      firstMessage: async (id) => { calls.first.push(id); },
    },
    groups: {
      load: () => structuredClone(groups), save: (entries) => { groups = structuredClone(entries); },
      create: (entry) => { calls.created.push(entry.id); return entry.agents.map((_, i) => `ag_${entry.id}_${i}`); },
      addGuest: (entry, guest) => calls.guests.push([entry.id, guest.email]),
      addAgents: (entry, specs) => { calls.added = [...(calls.added || []), ...specs.map((spec) => spec.archetype)]; return specs.map((_, i) => `ag_${entry.id}_x${entry.agentIds.length + i}`); },
      remove: (entry) => calls.removed.push(entry.id),
      window: (entry) => windows.get(entry.id) || null,
    },
  };
  const request = (id, email, site, company = "Acme", archetype = "marketer") => previews.set(id, { id, email, site, company, archetype, lang: "en", status: "requested", space: "" });
  return { deps, calls, previews, windows, request, groups: () => groups, tick: (ms) => { clock += ms; }, now: () => clock };
}

test("one request makes one group of sealed agents and one email; the same site never makes a second one", async () => {
  const w = world();
  w.request("pv_1", "Anna@acme.com", "https://www.acme.com");
  await runOnce(w.deps);
  assert.deepEqual(w.calls.created, ["acme"]);
  assert.equal(w.previews.get("pv_1").status, "ready");
  assert.equal(w.previews.get("pv_1").space, "demo");
  assert.equal(w.calls.mails.length, 1);
  assert.equal(w.calls.mails[0].to, "anna@acme.com");
  const link = /https:\/\/demo\.usecora\.space\/auth\/preview\?token=([\w-]+)/.exec(w.calls.mails[0].text)[1];
  assert.equal(w.groups()[0].guests[0].tokenHash, tokenHash(link), "only the hash of the mailed link is kept");
  assert.ok(!JSON.stringify(w.groups()).includes(link));
  assert.deepEqual(w.groups()[0].agents.map((agent) => [agent.archetype, agent.name, agent.role]), [["marketer", "Mia", "Marketer"]], "the archetype the company chose");
  assert.equal(w.groups()[0].agentIds.length, 1);
  assert.equal(w.calls.mails[0].subject, "Meet Mia, your agent for Acme");
  assert.match(w.calls.mails[0].text, /Mia · Marketer/);
  assert.match(w.calls.mails[0].html, /Start the chat with Mia/);
  assert.match(w.calls.mails[0].html, /Up to 3 agents/);

  await runOnce(w.deps);
  assert.equal(w.calls.created.length, 1);
  assert.equal(w.calls.mails.length, 1);

  w.request("pv_2", "anna@acme.com", "https://acme.com/");
  await runOnce(w.deps);
  assert.equal(w.calls.created.length, 1);
  assert.equal(w.previews.get("pv_2").space, "demo");
  assert.equal(w.calls.mails.length, 1, "the same address gets nothing new");

  w.request("pv_3", "bo@acme.com", "https://acme.com");
  await runOnce(w.deps);
  assert.equal(w.calls.created.length, 1);
  assert.deepEqual(w.calls.guests, [["acme", "bo@acme.com"]]);
  assert.equal(w.calls.mails.length, 2);
  assert.equal(w.calls.mails[1].to, "bo@acme.com");

  // Other archetypes join the group up to three agents; then the group stays as it is.
  for (const [id, archetype] of [["pv_4", "analyst"], ["pv_5", "programmer"], ["pv_6", "secretary"], ["pv_7", "analyst"]]) w.request(id, "anna@acme.com", "https://acme.com", "Acme", archetype);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.added, ["analyst", "programmer"]);
  assert.deepEqual(w.groups()[0].agents.map((agent) => agent.archetype), ["marketer", "analyst", "programmer"]);
  assert.equal(w.previews.get("pv_6").status, "ready", "a fourth choice still gets an answer, without a fourth agent");
  assert.equal(w.calls.mails.length, 2);
});

test("the hour starts at the first message, is told to usecora.space once and the group goes after it", async () => {
  const w = world();
  w.request("pv_1", "anna@acme.com", "https://acme.com");
  await runOnce(w.deps);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.first, []);
  w.windows.set("acme", { startedAt: w.now(), minutes: 60 });
  await runOnce(w.deps);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.first, ["pv_1"]);
  w.tick(59 * 60000);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.removed, []);
  w.tick(4 * 60000);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.removed, ["acme"]);
  assert.equal(w.groups()[0].ended, "hour");
  w.request("pv_9", "anna@acme.com", "https://acme.com");
  await runOnce(w.deps);
  assert.deepEqual(w.calls.created, ["acme", "acme"], "after removal the same site can ask again");
});

test("a group nobody opens goes after seven days, and a failed build leaves nothing behind", async () => {
  const w = world();
  w.request("pv_1", "anna@acme.com", "https://acme.com");
  await runOnce(w.deps);
  w.tick(7 * 86400000 + 1000);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.removed, ["acme"]);
  assert.equal(w.previews.get("pv_1").status, "failed");

  const broken = world({ siteFails: true });
  broken.request("pv_2", "x@broken.com", "https://broken.com");
  await runOnce(broken.deps);
  assert.equal(broken.previews.get("pv_2").status, "failed");
  assert.deepEqual(broken.calls.created, []);
  assert.deepEqual(broken.calls.mails, []);
});

test("names, briefing fallback, page reading and public addresses", async () => {
  assert.equal(slugFor("https://www.acme.com"), "acme");
  assert.equal(slugFor("https://shop.acme.co.uk"), "acme");
  assert.equal(slugFor("https://taken.io", (slug) => slug === "taken"), "taken-2");
  assert.equal(slugFor("https://notseb.com"), "notseb-2", "our own spaces' names are never given away");
  assert.equal(slugFor("https://ab.io"), "ab-co");
  assert.equal(agentName("Ava", "Acme", () => false), "Ava · Acme");
  assert.equal(agentName("Ava", "Acme", (name) => name === "ava · acme"), "Ava · Acme 2");
  assert.equal(agentName("Ava", "Discord Corp", () => false), "Ava · Corp");

  const fallback = await briefing({ company: "Acme", site: "https://acme.com", lang: "en", pages: [{ url: "https://acme.com", title: "Acme", description: "Rockets for everyone", headings: ["Rockets"], text: "" }], chat: async () => { throw new Error("down"); } });
  assert.deepEqual(fallback.agents.map((agent) => agent.role), ["Marketer"], "without the model and without a choice, the default archetype");
  const home = [{ url: "https://acme.com", title: "Acme", description: "", headings: [], text: "" }];
  const chosen = await briefing({ company: "Acme", site: "https://acme.com", lang: "en", pages: home, archetype: "Lead_generator", chat: async () => JSON.stringify({ archetype: "programmer", focus: "SaaS buyers" }) });
  assert.deepEqual(chosen.agents.map((agent) => [agent.archetype, agent.name]), [["lead-generator", "Leo"]], "the company's choice wins over the model's");
  const picked = await briefing({ company: "Acme", site: "https://acme.com", lang: "en", pages: home, chat: async () => JSON.stringify({ archetype: "programmer", focus: "an API" }) });
  assert.deepEqual(picked.agents.map((agent) => agent.archetype), ["programmer"]);
  assert.match(agentSpecs(picked)[0].personality, /programmer of Acme[\s\S]*Start from this: an API/);
  assert.equal((await briefing({ company: "Acme", site: "https://acme.com", lang: "en", pages: home, chat: async () => JSON.stringify({ archetype: "astronaut" }) })).agents[0].archetype, "marketer");
  assert.equal(fallback.summary, "Rockets for everyone");
  assert.match(agentSpecs(fallback)[0].personality, /Acme/);

  const page = readPage(`<html><head><title>Acme &amp; Co</title><meta name="description" content="We build rockets"><script>var x="secret"</script></head><body><h1>Rockets</h1><p>Fast</p><a href="/about">About us</a></body></html>`);
  assert.equal(page.title, "Acme & Co");
  assert.equal(page.description, "We build rockets");
  assert.deepEqual(page.headings, ["Rockets"]);
  assert.doesNotMatch(page.text, /secret/);

  await assert.rejects(publicAddress("10.0.0.5"), /private/);
  await assert.rejects(publicAddress("internal.test", async () => [{ address: "192.168.1.4", family: 4 }]), /private/);
  await assert.rejects(publicAddress("v6.test", async () => [{ address: "fd00::1", family: 6 }]), /private/);
  assert.equal(await publicAddress("acme.test", async () => [{ address: "93.184.216.34", family: 4 }]), true);

  // A redirect to a private address is refused like a direct one.
  const fetchImpl = async (url) => new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  await assert.rejects(readSite("https://acme.test", { fetchImpl, resolve: async () => [{ address: "93.184.216.34", family: 4 }] }), /private/);

  for (const lang of ["en", "it", "es", "de", "fr"]) {
    const mail = previewEmail({ company: "Acme <b>", lang, link: "https://acme.usecora.space/auth/preview?token=abc" });
    assert.match(mail.text, /https:\/\/acme\.usecora\.space\/auth\/preview\?token=abc/);
    assert.doesNotMatch(mail.html, /<b>/);
    assert.match(mail.html, /^<!doctype html>/);
    assert.match(mail.html, /href="https:\/\/acme\.usecora\.space\/auth\/preview\?token=abc"/);
  }
  const it = previewEmail({ company: "Acme", lang: "it", site: "https://www.acme.com/", link: "https://demo.usecora.space/auth/preview?token=abc", agent: { name: "Leo · Acme", role: "Lead generator", archetype: "lead-generator", does: "finds prospects", focus: "Write to <script>x</script> clinics" } });
  assert.equal(it.subject, "Ecco Leo, il tuo agente per Acme");
  assert.match(it.html, /Abbiamo letto acme\.com/);
  assert.match(it.html, /Fino a 3 agenti/);
  assert.match(it.html, /1 ora/);
  assert.match(it.html, /#e5533d/);
  assert.doesNotMatch(it.html, /<script>/);
  assert.match(it.text, /Da dove parte: Write to <script>x<\/script> clinics/);
});

test("the onboarding's card becomes the sealed agent: its name, its pitch, the company's wish and its first messages", async () => {
  const seen = [];
  const chat = async (messages) => { seen.push(messages); return '{"name":"Iris 2","pitch":"I watch Rival   prices for you.","starters":["What changed?","b","c","d"]}'; };
  const card = await draftCard({ company: "Acme", site: "https://acme.com", archetype: "researcher", lang: "it", wish: "Watch competitors" }, { chat, read: async () => [{ url: "https://acme.com/", title: "Acme", description: "Rockets", headings: ["Rockets"], text: "Acme rockets" }] });
  assert.deepEqual(card, { name: "Iris", pitch: "I watch Rival prices for you.", starters: ["What changed?", "b", "c"] });
  assert.match(seen[0][0].content, /Researcher/);
  assert.match(seen[0][0].content, /in Italian/);
  assert.match(seen[0][1].content, /Watch competitors/);
  await draftCard({ company: "Acme", site: "https://acme.com", archetype: "marketer" }, { chat, read: async () => { throw new Error("down"); } });
  assert.match(seen[1][1].content, /could not be read/, "an unreadable site still gets a card, told to say nothing specific");
  await assert.rejects(draftCard({ company: "Acme", site: "https://acme.com", archetype: "boss" }, { chat }), /archetype/);
  await assert.rejects(draftCard({ company: "Acme", site: "https://acme.com", archetype: "marketer" }, { chat: async () => "nope", read: async () => [] }), /empty draft/);
  assert.equal(cleanCard({ name: "", pitch: "x" }), null);

  const brief = await briefing({ company: "Acme", site: "https://acme.com", lang: "en", pages: [{ url: "https://acme.com", title: "Acme", description: "", headings: [], text: "" }], archetype: "researcher", wish: "Watch competitors", card: { name: "Iris", pitch: "I watch Rival prices.", starters: ["What changed?"] }, chat: async (messages) => { seen.push(messages); return JSON.stringify({ summary: "Acme.", focus: "something else" }); } });
  assert.match(seen.at(-1)[1].content, /What the company wants from this agent: Watch competitors/);
  assert.deepEqual([brief.agents[0].name, brief.agents[0].focus, brief.agents[0].starters], ["Iris", "I watch Rival prices.", ["What changed?"]], "the agent is the one the company saw");
  const [spec] = agentSpecs(brief);
  assert.match(spec.personality, /The company asked you for this: Watch competitors/);
  assert.match(spec.personality, /Start from this: I watch Rival prices\./);
  assert.deepEqual(spec.starters, ["What changed?"]);
  const plain = await briefing({ company: "Acme", site: "https://acme.com", lang: "en", pages: [], archetype: "researcher", card: { name: "<b>", pitch: "" }, chat: async () => "{}" });
  assert.equal(plain.agents[0].name, "Iris", "a broken card falls back to the archetype");
});

test("the draft door answers only usecora.space with the pipeline token", async (t) => {
  const token = "t".repeat(40);
  const server = startDraftDoor({ token, port: 0, chat: async () => '{"name":"Leo","pitch":"I find buyers.","starters":["Who?"]}', read: async () => [] });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/_draft`;
  const ask = (body, auth = `Bearer ${token}`) => fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ok = await ask({ company: "Acme", site: "acme.com", archetype: "lead-generator", lang: "en", wish: "Buyers" });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).draft, { name: "Leo", pitch: "I find buyers.", starters: ["Who?"] });
  assert.equal((await ask({ archetype: "lead-generator" }, "Bearer wrong")).status, 404);
  assert.equal((await ask({ site: "acme.com", archetype: "boss" })).status, 400);
});

test("a colleague who joins with another role gets the mail of that agent, with its card's pitch in their language", async () => {
  const w = world();
  w.request("pv_1", "anna@acme.com", "https://acme.com", "Acme", "secretary");
  await runOnce(w.deps);
  w.request("pv_2", "luca@acme.com", "https://acme.com", "Acme", "researcher");
  Object.assign(w.previews.get("pv_2"), { lang: "it", wish: "Guarda i concorrenti", draft: { name: "Luca", pitch: "Monitoro i concorrenti di Acme.", starters: ["Cosa è cambiato?"] } });
  await runOnce(w.deps);
  const mail = w.calls.mails[1];
  assert.equal(mail.to, "luca@acme.com");
  assert.match(mail.subject, /Luca/);
  assert.match(mail.text, /Da dove parte: Monitoro i concorrenti di Acme\./);
  assert.doesNotMatch(mail.text, /Researches markets/, "no English role line when the card says it in Italian");
  assert.deepEqual(w.groups()[0].agents[1].starters, ["Cosa è cambiato?"]);
});

test("the preview email ends a long agent pitch on a whole word", async () => {
  const { previewEmail } = await import("../src/preview-email.js");
  const focus = "You want more subscribers for your weekly Catania Buzz newsletter, so I'll draft in-language promo posts and sign-up copy that turn readers across Catania and provincia into subscribers. I'll start with a few newsletter promo variants and sign-up page copy you can test this week across your channels and site, then a short weekly report on which version brought more sign-ups.";
  const mail = previewEmail({ company: "Catania Buzz", lang: "en", link: "https://demo.example/auth/preview?token=t", role: "Marketer", agent: { name: "Nina", role: "Marketer", focus }, site: "catania.buzz" });
  const shown = (/Where it starts:<\/b>\s*([^<]*)</.exec(mail.html)?.[1] || "").replace(/&#39;/g, "'");
  assert.ok(shown.endsWith("…"), shown);
  assert.ok(focus.includes(shown.slice(0, -1)), "a prefix of the pitch");
  assert.ok(focus[shown.length - 1] === " " || /[,.;]/.test(focus[shown.length - 1]), "cut at a word boundary");
test("a fourth role for a company that already has three is refused in words, not silently", async () => {
  const w = world();
  w.request("pv_1", "anna@acme.com", "https://acme.com", "Acme", "marketer");
  await runOnce(w.deps);
  for (const [id, archetype] of [["pv_2", "analyst"], ["pv_3", "programmer"]]) w.request(id, "anna@acme.com", "https://acme.com", "Acme", archetype);
  await runOnce(w.deps);
  w.request("pv_4", "bo@acme.com", "https://acme.com", "Acme", "secretary");
  await runOnce(w.deps);
  assert.equal(w.calls.created.length, 1, "still one preview per company");
  assert.deepEqual(w.groups()[0].agents.map((agent) => agent.archetype), ["marketer", "analyst", "programmer"]);
  assert.equal(w.previews.get("pv_4").status, "ready");
  assert.match(w.previews.get("pv_4").note, /3 agents already, secretary not added/);
  const mail = w.calls.mails[1];
  assert.equal(mail.to, "bo@acme.com");
  const existing = w.groups()[0].agents.map((agent) => `${agent.name} (${agent.role})`).join(", ");
  assert.ok(mail.text.includes(`This demo already has its three agents: ${existing}.`), "names what is there");
  assert.match(mail.text, /The role you asked for, Secretary, was not added: three agents per company is the limit/);
  assert.doesNotMatch(mail.html, /Up to 3 agents/, "no promise of a fourth role");
  assert.match(mail.html, /Three agents already/);
});
