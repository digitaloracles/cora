import assert from "node:assert/strict";
import { test } from "node:test";
import { agentSpecs, briefing, previewEmail, publicAddress, readPage, readSite, runOnce, slugFor, tokenHash } from "../src/preview-pipeline.js";

function world({ chat = async () => JSON.stringify({ summary: "Acme makes rockets.", products: ["Rockets"], audience: "Space fans", tone: "Bold", agents: [{ name: "Ava", role: "writer", focus: "posts" }, { name: "Leo", role: "support", focus: "answers" }, { name: "Mia", role: "research", focus: "plans" }] }), siteFails = false } = {}) {
  let clock = Date.parse("2026-11-22T08:00:00Z");
  const previews = new Map();
  const calls = { updates: [], first: [], mails: [], started: [], restarted: [], stopped: [], registered: [], unregistered: [], specs: [] };
  const windows = new Map();
  let registry = [];
  const deps = {
    now: () => clock, log: () => {}, chat,
    site: async () => { if (siteFails) throw new Error("site answered 500"); return [{ url: "https://acme.com/", title: "Acme", description: "Rockets", headings: ["Rockets"], text: "Acme rockets" }]; },
    mail: async (message) => { calls.mails.push(message); },
    registry: { load: () => structuredClone(registry), save: (entries) => { registry = structuredClone(entries); } },
    cloud: {
      list: async (status) => [...previews.values()].filter((item) => item.status === status),
      update: async (id, body) => { calls.updates.push([id, body]); Object.assign(previews.get(id), { status: body.status, space: body.space || previews.get(id).space }); },
      firstMessage: async (id) => { calls.first.push(id); },
    },
    spaces: {
      taken: (slug) => slug === "taken", freePort: (used) => 4600 + used.length,
      write: (entry) => calls.specs.push(structuredClone(entry)),
      start: async (entry) => calls.started.push(entry.slug), restart: async (entry) => calls.restarted.push(entry.slug), healthy: async () => true,
      register: async (entry) => calls.registered.push(entry.slug), unregister: async (entry) => calls.unregistered.push(entry.slug),
      stop: async (entry) => calls.stopped.push(entry.slug), window: (entry) => windows.get(entry.slug) || null,
    },
  };
  const request = (id, email, site, company = "Acme") => previews.set(id, { id, email, site, company, lang: "en", status: "requested", space: "" });
  return { deps, calls, previews, windows, request, registry: () => registry, tick: (ms) => { clock += ms; }, now: () => clock };
}

test("one request makes one sealed space and one email; the same site never makes a second space", async () => {
  const w = world();
  w.request("pv_1", "anna@acme.com", "https://www.acme.com");
  await runOnce(w.deps);
  assert.deepEqual(w.calls.started, ["acme"]);
  assert.deepEqual(w.calls.registered, ["acme"]);
  assert.equal(w.previews.get("pv_1").status, "ready");
  assert.equal(w.previews.get("pv_1").space, "acme");
  assert.equal(w.calls.mails.length, 1);
  assert.equal(w.calls.mails[0].to, "anna@acme.com");
  const link = /https:\/\/acme\.usecora\.space\/auth\/preview\?token=([\w-]+)/.exec(w.calls.mails[0].text)[1];
  assert.equal(w.registry()[0].guests[0].tokenHash, tokenHash(link), "only the hash of the mailed link is kept");
  assert.ok(!JSON.stringify(w.registry()).includes(link));
  assert.equal(w.calls.specs[0].agents.length, 3);

  // Another pass changes nothing.
  await runOnce(w.deps);
  assert.equal(w.calls.started.length, 1);
  assert.equal(w.calls.mails.length, 1);

  // The same person asks again for the same site: same space, no second email.
  w.request("pv_2", "anna@acme.com", "https://acme.com/");
  await runOnce(w.deps);
  assert.equal(w.calls.started.length, 1);
  assert.equal(w.previews.get("pv_2").space, "acme");
  assert.equal(w.calls.mails.length, 1);

  // A colleague asks for the same site: joins that space with a link of their own.
  w.request("pv_3", "bo@acme.com", "https://acme.com");
  await runOnce(w.deps);
  assert.equal(w.calls.started.length, 1);
  assert.deepEqual(w.calls.restarted, ["acme"]);
  assert.equal(w.previews.get("pv_3").space, "acme");
  assert.equal(w.calls.mails.length, 2);
  assert.equal(w.calls.mails[1].to, "bo@acme.com");
  assert.deepEqual(w.registry()[0].guests.map((guest) => guest.email), ["anna@acme.com", "bo@acme.com"]);
});

test("the hour starts at the first message, is told to usecora.space once and the space goes after it", async () => {
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
  assert.deepEqual(w.calls.stopped, []);
  w.tick(4 * 60000);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.stopped, ["acme"]);
  assert.deepEqual(w.calls.unregistered, ["acme"]);
  assert.equal(w.registry()[0].ended, "hour");
  // Once removed, a new request for the same site gets a fresh space.
  w.request("pv_9", "anna@acme.com", "https://acme.com");
  await runOnce(w.deps);
  assert.deepEqual(w.calls.started, ["acme", "acme"]);
});

test("a space nobody opens goes after seven days, and a failed build leaves nothing behind", async () => {
  const w = world();
  w.request("pv_1", "anna@acme.com", "https://acme.com");
  await runOnce(w.deps);
  w.tick(7 * 86400000 + 1000);
  await runOnce(w.deps);
  assert.deepEqual(w.calls.stopped, ["acme"]);
  assert.equal(w.previews.get("pv_1").status, "failed");

  const broken = world({ siteFails: true });
  broken.request("pv_2", "x@broken.com", "https://broken.com");
  await runOnce(broken.deps);
  assert.equal(broken.previews.get("pv_2").status, "failed");
  assert.deepEqual(broken.calls.started, []);
  assert.deepEqual(broken.calls.mails, []);
});

test("names, briefing fallback, page reading and public addresses", async () => {
  assert.equal(slugFor("https://www.acme.com"), "acme");
  assert.equal(slugFor("https://shop.acme.co.uk"), "acme");
  assert.equal(slugFor("https://taken.io", (slug) => slug === "taken"), "taken-2");
  assert.equal(slugFor("https://notseb.com"), "notseb-2", "our own spaces' names are never given away");
  assert.equal(slugFor("https://ab.io"), "ab-co");

  const fallback = await briefing({ company: "Acme", site: "https://acme.com", lang: "en", pages: [{ url: "https://acme.com", title: "Acme", description: "Rockets for everyone", headings: ["Rockets"], text: "" }], chat: async () => { throw new Error("down"); } });
  assert.equal(fallback.agents.length, 3);
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
  }
});
