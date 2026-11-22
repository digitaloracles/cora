import { signPass } from "../../src/pass.js";

const esc = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const line = (value, max) => String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A space tells a person that a secret waits for them. The space hands over a one-time nonce; the
 * cloud calls the registered upstream back with a signed pass and mails what it answers: who sent it,
 * the reason and the send's own protected link, on the space's v- host. Never the secret's name.
 */
export async function sendSecretNotice({ space, nonce, audience, origin, privateKey, mailer, allowSend }) {
  if (!space || !/^[A-Za-z0-9_-]{43}$/.test(String(nonce || ""))) return { status: 403, error: "secret_notice_refused" };
  if (!mailer.enabled) return { status: 503, error: "mail_unavailable" };
  let notice;
  try {
    const response = await fetch(`${space.upstream}/api/cloud/secret-send`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Cora": "1" },
      body: JSON.stringify({ pass: signPass(privateKey, { aud: `secret-send:${audience}`, nonce }) }),
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (!response.ok) return { status: 403, error: "secret_notice_refused" };
    notice = await response.json();
  } catch { return { status: 502, error: "secret_notice_unconfirmed" }; }
  const email = String(notice.email || "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email) || email.length > 254) return { status: 403, error: "secret_notice_refused" };
  // Only the space's own send address: the cloud is no relay for any other link.
  const host = new RegExp(`^https://v-[a-f0-9]{12}--${escapeRegExp(space.slug)}\\.${escapeRegExp(new URL(origin).host)}/#[A-Za-z0-9_-]{43}$`);
  const link = String(notice.url || "");
  if (!host.test(link)) return { status: 403, error: "secret_notice_refused" };
  if (!allowSend("email", email) || !allowSend("host", `secret:${space.slug}`) || !allowSend("day", "all")) return { status: 429, error: "secret_notice_rate_limited" };
  const english = notice.language === "en";
  const sender = line(notice.sender, 120) || (english ? "Someone" : "Qualcuno");
  const reason = line(notice.reason, 300);
  const views = Math.min(Math.max(Math.round(Number(notice.views) || 1), 1), 20);
  const until = Number(notice.expiresAt) > 0 ? new Date(Number(notice.expiresAt)).toLocaleDateString(english ? "en-GB" : "it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
  const title = english ? `${sender} sent you a secret on Cora` : `${sender} ti ha mandato un segreto su Cora`;
  const intro = english
    ? `${sender} (space ${space.slug}) sent you a secret${reason ? ` for ${reason}` : ""}.`
    : `${sender} (spazio ${space.slug}) ti ha mandato un segreto${reason ? ` per ${reason}` : ""}.`;
  const opens = english
    ? `The link opens ${views === 1 ? "once" : `${views} times`}${until ? `, until ${until}` : ""}. To open it, sign in with the address ${email}.`
    : `Il link si apre ${views === 1 ? "una volta" : `${views} volte`}${until ? `, fino al ${until}` : ""}. Per aprirlo accedi con l'indirizzo ${email}.`;
  const kept = english ? "The secret is not in this email: you see it only by opening the link. If you were not expecting it, you can ignore this email." : "Il segreto non è in questa e-mail: lo vedi solo aprendo il link. Se non lo aspettavi, puoi ignorare questa e-mail.";
  const button = english ? "Open the secret" : "Apri il segreto";
  const text = `${intro}\n\n${opens}\n\n${button}: ${link}\n\n${kept}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#050505;color:#f5f5f3;font-family:Manrope,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;table-layout:fixed;margin:auto;background:#0f0f0f;border:1px solid #232323;border-radius:16px"><tr><td style="padding:32px;overflow-wrap:anywhere;word-break:break-word"><p style="margin:0 0 24px;color:#f2a93b;font-size:24px;font-weight:600">Cora</p><h1 style="font-size:26px;line-height:1.3">${esc(title)}</h1><p style="line-height:1.6">${esc(intro)}</p><p style="line-height:1.6">${esc(opens)}</p><p style="margin:28px 0"><a href="${esc(link)}" style="display:inline-block;background:#f2a93b;color:#1d1b18;text-decoration:none;border-radius:6px;padding:14px 22px;font-weight:600">${esc(button)}</a></p><p style="margin-top:28px;font-size:12px;line-height:1.6;color:#8f8f8a">${esc(kept)}</p></td></tr></table></td></tr></table></body></html>`;
  try {
    const sent = await mailer.send({ to: email, subject: title, text, html });
    return sent ? { status: 200, sent: true } : { status: 503, error: "mail_unavailable" };
  } catch { return { status: 502, error: "secret_notice_unconfirmed" }; }
}
