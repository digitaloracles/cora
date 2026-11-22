import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
const NAMES = ["Ava", "Leo", "Mia"];

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
export async function briefing({ company, site, lang, pages, chat }) {
  const source = pages.map((page) => `URL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\nHeadings: ${page.headings.join(" | ")}\nText: ${page.text}`).join("\n\n").slice(0, 14000);
  let parsed = null;
  try {
    const answer = await chat([
      { role: "system", content: "You prepare the briefing for a short Cora agent preview for one company, only from its public website. Answer with JSON only: {\"summary\": string (2-3 sentences), \"products\": [string], \"audience\": string, \"tone\": string, \"agents\": [{\"name\": string (one short first name), \"role\": string (what this agent does for the company, e.g. marketing writer, customer support, sales research), \"focus\": string (one sentence)}] with exactly 3 agents useful for this company. Do not invent facts that are not on the website." },
      { role: "user", content: `Company: ${company}\nWebsite: ${site}\nPreferred language of the visitor: ${lang}\n\n${source}` },
    ]);
    parsed = JSON.parse(String(answer).replace(/^```(?:json)?|```$/g, "").trim());
  } catch {}
  const page = pages[0] || {};
  const agents = (Array.isArray(parsed?.agents) ? parsed.agents : []).filter((agent) => clip(agent?.name, 24) && clip(agent?.role, 80)).slice(0, 3);
  const fallback = [{ name: "Ava", role: "marketing and content writer", focus: "drafts posts, emails and pages in the company's voice" }, { name: "Leo", role: "customer support", focus: "answers customers' questions about the company's offer" }, { name: "Mia", role: "research and planning", focus: "turns goals into plans, briefs and next steps" }];
  const used = new Set();
  return {
    company: clip(company, 80), site,
    summary: clip(parsed?.summary, 600) || clip(page.description || page.title, 600) || `${clip(company, 80)} (${siteHost(site)}).`,
    products: (Array.isArray(parsed?.products) ? parsed.products : page.headings || []).map((item) => clip(item, 120)).filter(Boolean).slice(0, 8),
    audience: clip(parsed?.audience, 200), tone: clip(parsed?.tone, 200),
    agents: (agents.length ? agents : fallback).map((agent, i) => {
      let name = clip(agent.name, 24).replace(/[^\p{L}\p{N} .'-]/gu, "").trim() || NAMES[i];
      if (/discord|clyde/i.test(name) || used.has(name.toLowerCase())) name = NAMES[i];
      used.add(name.toLowerCase());
      return { name, role: clip(agent.role, 80), focus: clip(agent.focus, 240) };
    }),
  };
}

export function agentSpecs(brief) {
  const facts = [`Company: ${brief.company} (${brief.site}).`, `What it does: ${brief.summary}`, brief.products.length ? `Products and services: ${brief.products.join("; ")}.` : "", brief.audience ? `Customers: ${brief.audience}.` : "", brief.tone ? `Tone of voice: ${brief.tone}.` : ""].filter(Boolean).join("\n");
  return brief.agents.map((agent, i) => ({
    name: agent.name, color: COLORS[i % COLORS.length],
    personality: `You are ${agent.name}, ${agent.role} for ${brief.company}, in a one-hour Cora preview prepared from the company's public website.\n${agent.focus ? `Your focus: ${agent.focus}\n` : ""}\n${facts}\n\nBe concrete and useful from the first answer: propose drafts, plans and examples built on this company. Keep answers short and ask one question when you need context.`,
  }));
}

const COPY = {
  en: { subject: (c) => `Your Cora agents for ${c} are ready`, hello: "Hi,", body: (c) => `we prepared three Cora agents for ${c}, from your website. They are sealed: they work only for you and see nothing else.`, cta: "Open your preview", hour: "The preview stays open for one hour from your first message. The link is personal: do not forward it.", bye: "The Cora team" },
  it: { subject: (c) => `I tuoi agenti Cora per ${c} sono pronti`, hello: "Ciao,", body: (c) => `abbiamo preparato tre agenti Cora per ${c} partendo dal vostro sito. Sono sealed: lavorano solo per voi e non vedono nient'altro.`, cta: "Apri la tua anteprima", hour: "L'anteprima resta aperta per un'ora dal tuo primo messaggio. Il link è personale: non inoltrarlo.", bye: "Il team di Cora" },
  es: { subject: (c) => `Tus agentes de Cora para ${c} están listos`, hello: "Hola:", body: (c) => `hemos preparado tres agentes de Cora para ${c} a partir de vuestra web. Están sellados: trabajan solo para vosotros y no ven nada más.`, cta: "Abrir tu vista previa", hour: "La vista previa queda abierta una hora desde tu primer mensaje. El enlace es personal: no lo reenvíes.", bye: "El equipo de Cora" },
  de: { subject: (c) => `Ihre Cora-Agenten für ${c} sind bereit`, hello: "Hallo,", body: (c) => `wir haben aus Ihrer Website drei Cora-Agenten für ${c} vorbereitet. Sie sind versiegelt: Sie arbeiten nur für Sie und sehen nichts anderes.`, cta: "Vorschau öffnen", hour: "Die Vorschau bleibt ab Ihrer ersten Nachricht eine Stunde lang offen. Der Link ist persönlich: bitte nicht weiterleiten.", bye: "Das Cora-Team" },
};
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

export function previewEmail({ company, lang, link }) {
  const copy = COPY[lang] || COPY.en;
  const text = `${copy.hello}\n\n${copy.body(company)}\n\n${copy.cta}: ${link}\n\n${copy.hour}\n\n${copy.bye}\nhttps://usecora.space`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#17202E;max-width:520px;line-height:1.55"><p>${escape(copy.hello)}</p><p>${escape(copy.body(company))}</p><p style="margin:28px 0"><a href="${escape(link)}" style="background:#264CD6;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;display:inline-block;font-weight:600">${escape(copy.cta)}</a></p><p style="color:#4a5568;font-size:14px">${escape(copy.hour)}</p><p>${escape(copy.bye)}<br><a href="https://usecora.space" style="color:#264CD6">usecora.space</a></p></div>`;
  return { subject: copy.subject(company), text, html };
}

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
 * groups {load(), save(entries), create(entry, guest), addGuest(entry, guest), remove(entry), window(entry)},
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
        // One group per company site: a second request joins it; a new address gets a link of its own.
        same.previews.push(request.id);
        const known = same.guests.some((guest) => guest.email === email);
        let token = null;
        if (!known) {
          token = newToken();
          const guest = { email, tokenHash: tokenHash(token), mailedAt: null };
          same.guests.push(guest);
          deps.groups.addGuest(same, guest);
        }
        save();
        await deps.cloud.update(request.id, { status: "ready", space: deps.space, note: "same site: joined its existing preview" });
        if (token) {
          await deps.mail({ to: email, ...previewEmail({ company: same.company, lang: request.lang, link: link(token) }) });
          same.guests.find((guest) => guest.email === email).mailedAt = deps.now(); save();
        }
        deps.log({ type: "preview-joined", id: request.id, group: same.id });
        continue;
      }
      await deps.cloud.update(request.id, { status: "building" });
      const pages = await deps.site(request.site);
      const brief = await briefing({ company: request.company, site: request.site, lang: request.lang, pages, chat: deps.chat });
      const id = slugFor(request.site, (name) => entries.some((entry) => entry.id === name && !entry.removedAt));
      const token = newToken();
      const guest = { email, tokenHash: tokenHash(token), mailedAt: null };
      const entry = { id, host, company: brief.company, site: request.site, lang: request.lang, previews: [request.id], guests: [guest], agents: agentSpecs(brief), agentIds: [], createdAt: deps.now(), ready: false };
      entries.push(entry); save();
      entry.agentIds = deps.groups.create(entry, guest);
      entry.ready = true; save();
      await deps.cloud.update(request.id, { status: "ready", space: deps.space });
      await deps.mail({ to: email, ...previewEmail({ company: brief.company, lang: request.lang, link: link(token) }) });
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
