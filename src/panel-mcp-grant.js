import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SEND_MARK, SEND_STYLE } from "./send-pages.js";

/**
 * An MCP gateway (usecora.space by default) asks this installation for an MCP access on someone's
 * behalf: the person signs in here, approves, and the gateway trades the one-time code (with PKCE)
 * for a personal MCP token limited to the public tool profile. Only listed gateways may ask.
 */
const CODES = "panelMcpGrantCodes";
const CODE_MS = 5 * 60000;
const DAYS = 365;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sha = (value) => createHash("sha256").update(value).digest("base64url");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const WORDS = {
  en: { title: "Connect Cora to an AI assistant", lead: "<b>{gateway}</b> asks to use this Cora as <b>{who}</b> for <b>{client}</b>.", can: "It can talk with your agents, delegate work to them and change the settings you can change in this panel. It never receives API keys, bot tokens or secret values.", allow: "Allow", deny: "Cancel", signin: "Sign in to this Cora first", signinLead: "Open the panel in this browser, sign in, then come back to this page.", open: "Open the panel", retry: "I signed in, continue", bad: "This request is not valid", badLead: "Start the connection again from your AI assistant." },
  it: { title: "Collega Cora a un assistente AI", lead: "<b>{gateway}</b> chiede di usare questa Cora come <b>{who}</b> per <b>{client}</b>.", can: "Potrà parlare con i tuoi agenti, affidare loro lavoro e cambiare le impostazioni che puoi cambiare in questo pannello. Non riceve mai chiavi API, token dei bot o valori dei segreti.", allow: "Consenti", deny: "Annulla", signin: "Prima entra in questa Cora", signinLead: "Apri il pannello in questo browser, entra, poi torna su questa pagina.", open: "Apri il pannello", retry: "Sono entrato, continua", bad: "Questa richiesta non è valida", badLead: "Riparti dal collegamento nel tuo assistente AI." },
};

export class McpGrants {
  constructor({ store, panelMcp, gateways, key, insecure = false }) {
    Object.assign(this, { store, panelMcp, key, insecure });
    this.gateways = gateways.map((value) => { try { return new URL(value).origin; } catch { return null; } }).filter(Boolean);
  }
  words() { return WORDS[this.store.settings?.language === "it" ? "it" : "en"]; }
  /** The request's fields when the redirect goes back to an allowed gateway; otherwise null. */
  request(params) {
    const get = (name, max) => String(params.get(name) || "").slice(0, max);
    const fields = { redirect_uri: get("redirect_uri", 500), state: get("state", 500), code_challenge: get("code_challenge", 128), client: get("client", 60).replace(/[\x00-\x1f]/g, "") || "an AI assistant" };
    let target;
    try { target = new URL(fields.redirect_uri); } catch { return null; }
    if (!this.gateways.includes(target.origin) || target.username || target.password || target.hash) return null;
    if (target.protocol !== "https:" && !(this.insecure && target.protocol === "http:")) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(fields.code_challenge) || !fields.state) return null;
    return { ...fields, gateway: target.host };
  }
  csrf(user, fields) { return createHmac("sha256", this.key).update(`mcp-grant.${user.id}.${fields.redirect_uri}.${fields.state}.${fields.code_challenge}`).digest("base64url"); }
  page(status, title, body, { action = "" } = {}) {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${action ? ` ${action}` : ""}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)} · Cora</title><style>${SEND_STYLE}form{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px}button{font:inherit;cursor:pointer}.ghost{background:transparent;color:inherit;border:1px solid currentColor;opacity:.75}</style></head><body><main>${SEND_MARK}<h1>${esc(title)}</h1>${body}</main></body></html>`;
    return { status, html, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": csp } };
  }
  /** GET: the consent page, or the way to sign in first. */
  show(user, url, loginUrl) {
    const w = this.words(), fields = this.request(url.searchParams);
    if (!fields) return this.page(400, w.bad, `<p>${esc(w.badLead)}</p>`);
    if (!user && !url.searchParams.has("hop")) {
      // Arriving from another site, the browser holds back this panel's SameSite=Strict cookie: one hop from this origin brings it.
      const again = new URL(url.pathname + url.search, "http://cora.internal");
      again.searchParams.set("hop", "1");
      const next = esc(again.pathname + again.search);
      const page = this.page(200, w.title, `<p><a href="${next}">${esc(w.retry)}</a></p>`);
      page.html = page.html.replace("<title>", `<meta http-equiv="refresh" content="0;url=${next}"><title>`);
      return page;
    }
    if (!user) {
      const back = url.pathname + url.search;
      if (loginUrl) return { status: 302, headers: { Location: `${loginUrl}?${new URLSearchParams({ next: back })}`, "Cache-Control": "no-store" } };
      return this.page(401, w.signin, `<p>${esc(w.signinLead)}</p><form method="get" action="/"><button class="button" type="submit">${esc(w.open)}</button></form><p><a href="${esc(back)}">${esc(w.retry)}</a></p>`);
    }
    const who = user.email || user.name || user.id;
    const hidden = Object.entries({ ...fields, csrf: this.csrf(user, fields) }).filter(([name]) => name !== "gateway").map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join("");
    const lead = w.lead.replace("{gateway}", esc(fields.gateway)).replace("{who}", esc(who)).replace("{client}", esc(fields.client));
    return this.page(200, w.title, `<p>${lead}</p><p>${esc(w.can)}</p><form method="post" action="/mcp/authorize">${hidden}<button class="button ghost" name="decision" value="deny" type="submit">${esc(w.deny)}</button><button class="button" name="decision" value="allow" type="submit">${esc(w.allow)}</button></form>`, { action: new URL(fields.redirect_uri).origin });
  }
  /** POST: the person's answer, sent back to the gateway with a one-time code or a refusal. */
  answer(user, form) {
    const fields = this.request(new URLSearchParams(form));
    if (!user || !fields || !same(form.csrf || "", this.csrf(user, fields))) return this.page(400, this.words().bad, `<p>${esc(this.words().badLead)}</p>`);
    const back = new URL(fields.redirect_uri);
    back.searchParams.set("state", fields.state);
    if (form.decision !== "allow") back.searchParams.set("error", "access_denied");
    else {
      const code = randomBytes(32).toString("base64url"), now = Date.now();
      const codes = this.store.value(CODES, []).filter((item) => item.expiresAt > now);
      this.store.setValue(CODES, [...codes, { hash: sha(code), userId: user.id, redirectUri: fields.redirect_uri, challenge: fields.code_challenge, client: fields.client, gateway: back.origin, expiresAt: now + CODE_MS }]);
      back.searchParams.set("code", code);
    }
    return { status: 302, headers: { Location: back.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } };
  }
  /** The gateway trades the code and its PKCE verifier for the MCP token, once. */
  exchange(body) {
    const now = Date.now(), codes = this.store.value(CODES, []).filter((item) => item.expiresAt > now);
    const found = typeof body.code === "string" ? codes.find((item) => same(item.hash, sha(body.code))) : null;
    this.store.setValue(CODES, codes.filter((item) => item !== found));
    if (!found || body.redirect_uri !== found.redirectUri || typeof body.code_verifier !== "string" || !same(sha(body.code_verifier), found.challenge)) throw fail("invalid_grant");
    const user = this.store.panelUser(found.userId);
    if (!user || !this.store.allowsPanelUser({ ...user, emailVerified: true })) throw fail("invalid_grant");
    const name = `${found.client} via ${new URL(found.gateway).host}`.slice(0, 80);
    for (const record of this.panelMcp.records().filter((item) => item.userId === user.id && item.name === name && item.profile === "public")) this.panelMcp.revoke(user, record.id);
    const access = this.panelMcp.create(user, { name, days: DAYS, profile: "public" });
    return { access_token: access.token, token_type: "Bearer", expires_in: DAYS * 86400, user: { name: user.name || user.email, email: user.email } };
  }
}
