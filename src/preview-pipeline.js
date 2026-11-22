import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { previewEmail } from "./preview-email.js";

/**
 * The custom agent preview pipeline (NOT-94), run on the host every minute:
 * usecora.space requests → the company's website → a briefing → one sealed preview space
 * per company site → one email with the link → the hour starts at the first message → removal.
 * Every outside effect goes through `deps`, so the tests drive the whole cycle.
 */

const RESERVED = new Set(["www", "api", "app", "admin", "auth", "login", "mail", "status", "docs", "help", "cloud", "cora", "up", "static", "assets", "share", "preview", "send", "p", "notseb", "dopamina", "oauth-review"]);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const TWO_PART = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
export const UNUSED_DAYS = 7;
export const GRACE_MS = 2 * 60000;
const COLORS = ["#264cd6", "#e36a3a", "#7b5cd6", "#1f9d74"];

/** The roles a preview agent can play; the briefing picks the three that fit the company best. */
export const ARCHETYPES = {
  manager: { name: "Mara", role: "Manager", does: "turns goals into plans, priorities, owners and weekly updates, and keeps track of what is late" },
  programmer: { name: "Theo", role: "Programmer", does: "writes and reviews code, scripts and automations, explains technical choices and drafts specs" },
  secretary: { name: "Sofia", role: "Secretary", does: "drafts emails and replies, organises agendas, meeting notes, reminders and follow-ups" },
  researcher: { name: "Iris", role: "Researcher", does: "researches markets, competitors and topics, and turns findings into short, sourced briefs" },
  "lead-generator": { name: "Leo", role: "Lead generator", does: "defines ideal customers, finds prospect segments and writes outreach sequences and follow-ups" },
  marketer: { name: "Mia", role: "Marketer", does: "writes posts, newsletters, landing copy and campaign ideas in the company's voice" },
  support: { name: "Nora", role: "Customer support", does: "answers customers' questions about the offer, drafts help articles and handles complaints kindly" },
  analyst: { name: "Otto", role: "Analyst", does: "reads numbers and reports, builds KPIs and simple dashboards, and explains what changed and why" },
};
const DEFAULT_ARCHETYPES = ["marketer", "lead-generator", "secretary"];
/** At most this many agents per company: each one costs model time. */
export const MAX_AGENTS = 3;
export const archetypeOf = (value) => { const id = String(value || "").toLowerCase().trim().replace(/[\s_]+/g, "-"); return ARCHETYPES[id] ? id : ""; };

export const siteHost = (site) => { try { return new URL(site).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

/** acme.com → acme, shop.acme.co.uk → acme; a taken or reserved name gets -2, -3… */
export function slugFor(site, taken = () => false) {
  const labels = siteHost(site).split(".").filter(Boolean);
  let base = labels.length >= 3 && TWO_PART.has(labels.at(-2)) && labels.at(-1).length === 2 ? labels.at(-3) : labels.length >= 2 ? labels.at(-2) : labels[0] || "company";
  base = String(base).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 26) || "company";
  if (base.length < 3) base = `${base}-co`;
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (SLUG.test(slug) && !RESERVED.has(slug) && !slug.includes("--") && !taken(slug)) return slug;
  }
  throw new Error("no free name");
}

const privateV4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
};
/** Only public addresses: the website comes from a stranger's form. */
export async function publicAddress(hostname, resolve = lookup) {
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname, { all: true });
  if (!records.length) throw new Error("no address");
  for (const { address, family } of records) {
    if (family === 4 && privateV4(address)) throw new Error("private address");
    if (family === 6 && !/^(2|3)[0-9a-f]{3}:/i.test(address)) throw new Error("private address");
  }
  return true;
}

const decode = (text) => text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const meta = (html, name) => decode((new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html) || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i").exec(html) || [])[1] || "").trim();

/** Title, description, headings and readable text of one page. */
export function readPage(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "").replace(/\s+/g, " ").trim();
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter((item, i, all) => item && all.indexOf(item) === i).slice(0, 30);
  const text = decode(html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const links = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1], label: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));
  return { title, description: meta(html, "description") || meta(html, "og:description"), siteName: meta(html, "og:site_name"), headings, text, links };
}

export async function fetchPage(url, { fetchImpl = fetch, resolve = lookup, maxBytes = 1_500_000 } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (!["http:", "https:"].includes(current.protocol)) throw new Error("bad scheme");
    await publicAddress(current.hostname, resolve);
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "CoraPreview/1.0 (+https://usecora.space)", Accept: "text/html" } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) { current = new URL(response.headers.get("location"), current); continue; }
    if (!response.ok) throw new Error(`site answered ${response.status}`);
    const reader = response.body?.getReader?.();
    if (!reader) return { url: current.href, html: (await response.text()).slice(0, maxBytes) };
    const chunks = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; if (size > maxBytes) { await reader.cancel(); break; } }
    return { url: current.href, html: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("too many redirects");
}

/** The home page and up to two pages about the company or what it sells. */
export async function readSite(site, deps = {}) {
  const home = await fetchPage(site, deps);
  const first = readPage(home.html);
  const origin = new URL(home.url).origin;
  const wanted = first.links.map((link) => { try { return { ...link, url: new URL(link.href, home.url) }; } catch { return null; } })
    .filter((link) => link && link.url.origin === origin && /about|chi-siamo|azienda|company|product|prodott|servic|solution|soluzion|qui-sommes|ueber|uber-uns|empresa|nosotros/i.test(`${link.url.pathname} ${link.label}`))
    .map((link) => link.url.href.replace(/#.*$/, "")).filter((href, i, all) => all.indexOf(href) === i && href !== home.url).slice(0, 2);
  const pages = [{ url: home.url, ...first }];
  for (const href of wanted) { try { const page = await fetchPage(href, deps); pages.push({ url: page.url, ...readPage(page.html) }); } catch {} }
  return pages.map(({ links, ...page }) => ({ ...page, text: page.text.slice(0, 5000) }));
}

const clip = (value, size) => String(value || "").replace(/\s+/g, " ").trim().slice(0, size);

/** The model's briefing, or one made from the page itself when the model does not answer. */
/** The company from its website, and the agent it chose (or, when it did not, the one that fits it best). */
/** The card the onboarding drafted, as the company saw it: a first name, a pitch and up to three first messages. */
export function cleanCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = clip(value.name, 24).replace(/[^\p{L}\p{M}' -]/gu, "").trim();
  const pitch = clip(value.pitch, 280);
  const starters = (Array.isArray(value.starters) ? value.starters : []).map((item) => clip(item, 120)).filter(Boolean).slice(0, 3);
  return name && pitch ? { name, pitch, starters } : null;
}

const LANGUAGE_NAMES = { en: "English", it: "Italian", es: "Spanish", de: "German" };

/**
 * The onboarding's small agent (usecora.space/try asks it through the demo host): the role a company picked,
 * made theirs from its website and what it wrote it wants. The pipeline later builds the sealed agent from this card.
 */
export async function draftCard({ company, site, archetype, lang = "en", wish = "" }, { chat, read = readSite }) {
  const id = archetypeOf(archetype);
  if (!id) throw new Error("archetype");
  let source = "";
  try { source = (await read(site)).map((page) => `URL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\nHeadings: ${page.headings.join(" | ")}\nText: ${page.text}`).join("\n\n").slice(0, 8000); }
  catch { source = "(the website could not be read: use only the company name and website address, and say nothing specific about the offer)"; }
  const answer = await chat([
    { role: "system", content: `You set up one AI teammate for a company trying Cora for one hour. The company chose this role: ${ARCHETYPES[id].role}, who ${ARCHETYPES[id].does}. From the company's public website and what the company wrote it wants, make that role theirs. Answer with JSON only: {"name": a short, friendly first name for the agent, "pitch": one or two sentences, at most 240 characters, addressed to the company ("you"), saying what this agent will do for them first (start from what they asked for, within the role), naming their real products, customers or market when the website shows them, "starters": three short first messages (at most 90 characters each) the company could send this agent to see it work}. Write "pitch" and "starters" in ${LANGUAGE_NAMES[lang] || "English"}. Never invent facts that are not on the website. No markdown.` },
    { role: "user", content: `Company: ${clip(company, 80)}\nWebsite: ${site}\nWhat the company wants from this agent: ${clip(wish, 500) || "(not said)"}\n\n${source}` },
  ]);
  let card = null;
  try { card = cleanCard(JSON.parse(String(answer).replace(/^```(?:json)?|```$/g, "").trim())); } catch {}
  if (!card) throw new Error("empty draft");
  return card;
}

export async function briefing({ company, site, lang, pages, chat, archetype = "", wish = "", card = null }) {
  const source = pages.map((page) => `URL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\nHeadings: ${page.headings.join(" | ")}\nText: ${page.text}`).join("\n\n").slice(0, 14000);
  const chosen = archetypeOf(archetype);
  const catalog = Object.entries(ARCHETYPES).map(([id, item]) => `${id}: ${item.role}, ${item.does}`).join("\n");
  const task = chosen
    ? `The company chose this agent: ${chosen} (${ARCHETYPES[chosen].role}, ${ARCHETYPES[chosen].does}).`
    : `Pick the one archetype from this list that would help this company most:\n${catalog}`;
  let parsed = null;
  try {
    const answer = await chat([
      { role: "system", content: `You prepare the briefing for a short Cora agent preview for one company, only from its public website. ${task}\nAnswer with JSON only: {"summary": string (2-3 sentences), "products": [string], "audience": string, "tone": string, "archetype": the archetype id, "focus": string (one sentence: what this agent would do for this company first)}. Do not invent facts that are not on the website.` },
      { role: "user", content: `Company: ${company}\nWebsite: ${site}\nPreferred language of the visitor: ${lang}${wish ? `\nWhat the company wants from this agent: ${clip(wish, 500)}` : ""}\n\n${source}` },
    ]);
    parsed = JSON.parse(String(answer).replace(/^```(?:json)?|```$/g, "").trim());
  } catch {}
  const page = pages[0] || {};
  const id = chosen || archetypeOf(parsed?.archetype) || DEFAULT_ARCHETYPES[0];
  const drafted = cleanCard(card);
  return {
    company: clip(company, 80), site,
    summary: clip(parsed?.summary, 600) || clip(page.description || page.title, 600) || `${clip(company, 80)} (${siteHost(site)}).`,
    products: (Array.isArray(parsed?.products) ? parsed.products : page.headings || []).map((item) => clip(item, 120)).filter(Boolean).slice(0, 8),
    audience: clip(parsed?.audience, 200), tone: clip(parsed?.tone, 200),
    agents: [{ archetype: id, name: drafted?.name || ARCHETYPES[id].name, role: ARCHETYPES[id].role, does: ARCHETYPES[id].does, focus: drafted?.pitch || clip(parsed?.focus, 240), wish: clip(wish, 500), starters: drafted?.starters || [] }],
  };
}

export function agentSpecs(brief, offset = 0) {
  const facts = [`Company: ${brief.company} (${brief.site}).`, `What it does: ${brief.summary}`, brief.products.length ? `Products and services: ${brief.products.join("; ")}.` : "", brief.audience ? `Customers: ${brief.audience}.` : "", brief.tone ? `Tone of voice: ${brief.tone}.` : ""].filter(Boolean).join("\n");
  return brief.agents.map((agent, i) => ({
    name: agent.name, role: agent.role, archetype: agent.archetype, color: COLORS[(i + offset) % COLORS.length], starters: agent.starters || [], focus: agent.focus || "",
    personality: `You are ${agent.name}, the ${agent.role.toLowerCase()} of ${brief.company}, in a one-hour Cora preview prepared from the company's public website. As ${agent.role.toLowerCase()} you ${agent.does}.\n${agent.wish ? `The company asked you for this: ${agent.wish}\n` : ""}${agent.focus ? `Start from this: ${agent.focus}\n` : ""}\n${facts}\n\nBe concrete and useful from the first answer: propose drafts, plans and examples built on this company. Keep answers short and ask one question when you need context.`,
  }));
}

export { previewEmail, roleWord } from "./preview-email.js";
// The card's own pitch, in the company's language, says more than the archetype's English line: one or the other.
const mailAgent = (agent) => agent && { ...agent, does: agent.focus ? "" : agent.does || ARCHETYPES[agent.archetype]?.does || "" };

export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

/** Agent names are unique in the space: "Ava · Acme", then "Ava · Acme 2". */
export function agentName(name, company, taken) {
  const short = String(company || "").replace(/discord|clyde/gi, "").replace(/\s+/g, " ").trim().slice(0, 14).trim();
  const base = `${name}${short ? ` · ${short}` : ""}`.slice(0, 29).trim();
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (!taken(candidate.toLowerCase())) return candidate;
  }
  throw new Error("no free agent name");
}

/**
 * One pass of the pipeline inside the demo space. `deps`: cloud {list(status), update(id, body), firstMessage(id)},
 * groups {load(), save(entries), create(entry, guest), addGuest(entry, guest), addAgents(entry, specs), remove(entry), window(entry)},
 * space ("demo"), base ("https://demo.usecora.space"), site(url), chat(messages), mail(message), now(), log(event).
 * A group is one company site: its guests, its sealed agents and its hour.
 */
export async function runOnce(deps) {
  const entries = deps.groups.load();
  const save = () => deps.groups.save(entries);
  const live = () => entries.filter((entry) => !entry.removedAt);
  const link = (token) => `${deps.base}/auth/preview?token=${token}`;

  const requests = [...await deps.cloud.list("requested"), ...await deps.cloud.list("building")];
  for (const request of requests) {
    if (entries.some((entry) => entry.previews?.includes(request.id))) continue;
    const host = siteHost(request.site);
    const same = live().find((entry) => entry.host === host && entry.ready);
    const email = String(request.email || "").trim().toLowerCase();
    try {
      if (same) {
        // One group per company site: a second request joins it. A new address gets a link of its own;
        // an agent it chose that the group lacks is added, up to MAX_AGENTS.
        same.previews.push(request.id);
        const wanted = archetypeOf(request.archetype);
        const known = same.guests.some((guest) => guest.email === email);
        let token = null;
        if (!known) {
          token = newToken();
          const guest = { email, tokenHash: tokenHash(token), mailedAt: null };
          same.guests.push(guest);
          deps.groups.addGuest(same, guest);
        }
        let added = null;
        const missing = Boolean(wanted) && !same.agents.some((agent) => agent.archetype === wanted);
        if (missing && same.agents.length < MAX_AGENTS) {
          const pages = await deps.site(request.site);
          const brief = await briefing({ company: same.company, site: same.site, lang: request.lang, pages, chat: deps.chat, archetype: wanted, wish: request.wish, card: request.draft });
          added = agentSpecs(brief, same.agents.length);
          same.agentIds.push(...deps.groups.addAgents(same, added));
          same.agents.push(...added);
        }
        const capped = missing && !added ? { agents: same.agents, wantedRole: ARCHETYPES[wanted]?.role || wanted } : null;
        save();
        await deps.cloud.update(request.id, { status: "ready", space: deps.space, note: capped ? `same site: ${MAX_AGENTS} agents already, ${wanted} not added` : added ? `same site: ${wanted} added to its preview` : "same site: joined its existing preview" });
        if (token) {
          await deps.mail({ to: email, ...previewEmail({ company: same.company, lang: request.lang, link: link(token), site: same.site, agent: mailAgent(added?.[0] || same.agents[0]), capped }) });
          same.guests.find((guest) => guest.email === email).mailedAt = deps.now(); save();
        }
        deps.log({ type: "preview-joined", id: request.id, group: same.id, added: Boolean(added), capped: Boolean(capped) });
        continue;
      }
      await deps.cloud.update(request.id, { status: "building" });
      const pages = await deps.site(request.site);
      const brief = await briefing({ company: request.company, site: request.site, lang: request.lang, pages, chat: deps.chat, archetype: request.archetype, wish: request.wish, card: request.draft });
      const id = slugFor(request.site, (name) => entries.some((entry) => entry.id === name && !entry.removedAt));
      const token = newToken();
      const guest = { email, tokenHash: tokenHash(token), mailedAt: null };
      const entry = { id, host, company: brief.company, site: request.site, lang: request.lang, previews: [request.id], guests: [guest], agents: agentSpecs(brief), agentIds: [], createdAt: deps.now(), ready: false };
      entries.push(entry); save();
      entry.agentIds = deps.groups.create(entry, guest);
      entry.ready = true; save();
      await deps.cloud.update(request.id, { status: "ready", space: deps.space });
      await deps.mail({ to: email, ...previewEmail({ company: brief.company, lang: request.lang, link: link(token), site: request.site, agent: mailAgent(brief.agents[0]) }) });
      guest.mailedAt = deps.now(); save();
      deps.log({ type: "preview-ready", id: request.id, group: id });
    } catch (error) {
      deps.log({ type: "preview-failed", id: request.id, error: error.message });
      const entry = entries.find((item) => item.previews?.includes(request.id) && !item.ready);
      if (entry) { try { deps.groups.remove(entry); } catch {} entry.removedAt = deps.now(); entry.failed = clip(error.message, 200); save(); }
      try { await deps.cloud.update(request.id, { status: "failed", note: clip(error.message, 200) }); } catch {}
    }
  }

  // The hour: the company's first message starts it, usecora.space hears it once, and the group goes after it.
  for (const entry of live().filter((item) => item.ready)) {
    const window = deps.groups.window(entry);
    if (window?.startedAt && !entry.startReported) {
      for (const id of entry.previews) { try { await deps.cloud.firstMessage(id); } catch {} }
      entry.startReported = deps.now(); save();
    }
    const over = window?.startedAt ? deps.now() >= window.startedAt + (window.minutes || 60) * 60000 + GRACE_MS : deps.now() >= entry.createdAt + UNUSED_DAYS * 86400000;
    if (!over) continue;
    deps.groups.remove(entry);
    entry.removedAt = deps.now(); entry.ended = window?.startedAt ? "hour" : "unused"; save();
    if (!window?.startedAt) for (const id of entry.previews) { try { await deps.cloud.update(id, { status: "failed", note: "not used within 7 days; preview removed" }); } catch {} }
    deps.log({ type: "preview-removed", group: entry.id, reason: entry.ended });
  }
  return entries;
}
