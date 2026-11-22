/**
 * The email that hands a company its preview (NOT-94). Same look as usecora.space and /try:
 * warm paper, navy ink, one cobalt action, the agent card tinted with its archetype's color.
 * Tables and inline styles only, so it holds in Gmail, Outlook and Apple Mail; a dark variant
 * for clients that honor prefers-color-scheme; plain text beside it.
 */

const LOGO = "https://usecora.space/assets/cora-app-icon-192.png";
const HOME = "https://usecora.space";


/** The archetype colors of /try, so the card in the email is the card they just built. */
const TINT = { manager: "#264cd6", secretary: "#e0789a", researcher: "#5cbfb0", "lead-generator": "#e5533d", marketer: "#f2a93b", support: "#8cc56a", programmer: "#6fa8dc", analyst: "#b39ddb" };

const ROLE_WORDS = {
  it: { Manager: "Manager", Programmer: "Programmatore", Secretary: "Segretaria", Researcher: "Ricercatore", "Lead generator": "Lead generator", Marketer: "Marketer", "Customer support": "Assistenza clienti", Analyst: "Analista" },
  es: { Manager: "Mánager", Programmer: "Programador", Secretary: "Secretaria", Researcher: "Investigador", "Lead generator": "Generador de leads", Marketer: "Marketer", "Customer support": "Atención al cliente", Analyst: "Analista" },
  de: { Manager: "Manager", Programmer: "Entwickler", Secretary: "Sekretariat", Researcher: "Recherche", "Lead generator": "Leadgenerierung", Marketer: "Marketing", "Customer support": "Kundensupport", Analyst: "Analyst" },
};
const roleTitle = (role, lang) => ROLE_WORDS[lang]?.[role] || String(role || "Agent");
export const roleWord = (role, lang) => (ROLE_WORDS[lang]?.[role] || String(role || "agent")).toLowerCase();

const COPY = {
  en: {
    subject: (c, n) => `Meet ${n}, your agent for ${c}`,
    preheader: (c, n) => `${n} already knows ${c} from your website. Open the chat and give it a real task.`,
    kicker: "Your Cora preview",
    title: (c) => `Your agent for ${c} is ready`,
    lead: (c, s) => `We read ${s} and prepared an agent that already knows ${c}: what you sell, who you sell to and how you talk.`,
    first: "Where it starts",
    cta: (n) => `Start the chat with ${n}`,
    asks: "Give it real work, not a quiz: a newsletter, a plan for next week, a reply to a customer, a short market brief. You keep what it writes.",
    facts: [
      ["1 hour", "The clock starts with your first message, not when you open the link."],
      ["Up to 3 agents", (c) => `Want another role for ${c}? Ask for it on usecora.space/try with the same website.`],
      ["Private", "Only you can open this chat: the link is personal, do not forward it."],
    ],
    fallback: "If the button does not work, copy this link:",
    why: "You get this email because someone asked for a Cora preview with this address on usecora.space. If it was not you, ignore it: nothing happens.",
    bye: "The Cora team",
  },
  it: {
    subject: (c, n) => `Ecco ${n}, il tuo agente per ${c}`,
    preheader: (c, n) => `${n} conosce già ${c} dal vostro sito. Apri la chat e chiedi un lavoro vero.`,
    kicker: "La tua anteprima di Cora",
    title: (c) => `Il tuo agente per ${c} è pronto`,
    lead: (c, s) => `Abbiamo letto ${s} e preparato un agente che conosce già ${c}: cosa vendete, a chi e con che tono.`,
    first: "Da dove parte",
    cta: (n) => `Inizia la chat con ${n}`,
    asks: "Chiedi un lavoro vero, non un quiz: una newsletter, il piano della prossima settimana, la risposta a un cliente, una ricerca di mercato breve. Quello che scrive resta tuo.",
    facts: [
      ["1 ora", "Il tempo parte dal tuo primo messaggio, non da quando apri il link."],
      ["Fino a 3 agenti", (c) => `Vuoi un altro ruolo per ${c}? Chiedilo su usecora.space/try con lo stesso sito.`],
      ["Riservata", "Solo tu puoi aprire questa chat: il link è personale, non inoltrarlo."],
    ],
    fallback: "Se il pulsante non funziona, copia questo link:",
    why: "Ricevi questa email perché su usecora.space è stata chiesta un'anteprima di Cora con questo indirizzo. Se non sei stato tu, ignorala: non succede nulla.",
    bye: "Il team di Cora",
  },
  es: {
    subject: (c, n) => `Te presentamos a ${n}, tu agente para ${c}`,
    preheader: (c, n) => `${n} ya conoce ${c} por vuestra web. Abre el chat y dale un trabajo real.`,
    kicker: "Tu vista previa de Cora",
    title: (c) => `Tu agente para ${c} está listo`,
    lead: (c, s) => `Hemos leído ${s} y preparado un agente que ya conoce ${c}: qué vendéis, a quién y con qué tono.`,
    first: "Por dónde empieza",
    cta: (n) => `Empezar el chat con ${n}`,
    asks: "Dale trabajo real, no un examen: una newsletter, el plan de la próxima semana, la respuesta a un cliente, un breve estudio de mercado. Lo que escribe es tuyo.",
    facts: [
      ["1 hora", "El tiempo empieza con tu primer mensaje, no cuando abres el enlace."],
      ["Hasta 3 agentes", (c) => `¿Quieres otro rol para ${c}? Pídelo en usecora.space/try con la misma web.`],
      ["Privada", "Solo tú puedes abrir este chat: el enlace es personal, no lo reenvíes."],
    ],
    fallback: "Si el botón no funciona, copia este enlace:",
    why: "Recibes este correo porque alguien pidió una vista previa de Cora con esta dirección en usecora.space. Si no fuiste tú, ignóralo: no pasa nada.",
    bye: "El equipo de Cora",
  },
  de: {
    subject: (c, n) => `Das ist ${n}, Ihr Agent für ${c}`,
    preheader: (c, n) => `${n} kennt ${c} schon von Ihrer Website. Öffnen Sie den Chat und geben Sie eine echte Aufgabe.`,
    kicker: "Ihre Cora-Vorschau",
    title: (c) => `Ihr Agent für ${c} ist bereit`,
    lead: (c, s) => `Wir haben ${s} gelesen und einen Agenten vorbereitet, der ${c} schon kennt: was Sie verkaufen, an wen und in welchem Ton.`,
    first: "Der erste Schritt",
    cta: (n) => `Chat mit ${n} starten`,
    asks: "Geben Sie echte Arbeit, kein Quiz: einen Newsletter, den Plan für nächste Woche, eine Antwort an einen Kunden, eine kurze Marktrecherche. Was dabei entsteht, gehört Ihnen.",
    facts: [
      ["1 Stunde", "Die Zeit läuft ab Ihrer ersten Nachricht, nicht ab dem Öffnen des Links."],
      ["Bis zu 3 Agenten", (c) => `Noch eine Rolle für ${c}? Auf usecora.space/try mit derselben Website anfragen.`],
      ["Privat", "Nur Sie können diesen Chat öffnen: Der Link ist persönlich, bitte nicht weiterleiten."],
    ],
    fallback: "Wenn der Button nicht funktioniert, kopieren Sie diesen Link:",
    why: "Sie erhalten diese E-Mail, weil auf usecora.space mit dieser Adresse eine Cora-Vorschau angefragt wurde. Wenn Sie das nicht waren, ignorieren Sie sie: Es passiert nichts.",
    bye: "Das Cora-Team",
  },
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
/** Longer text ends on a whole word with an ellipsis, never in the middle of one. */
const words = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max / 2))).replace(/[\s,;:.\u2014-]+$/, "")}…`;
};
const hostOf = (site) => { try { return new URL(site).hostname.replace(/^www\./, ""); } catch { return ""; } };
const firstName = (name) => line(String(name || "").split("·")[0], 40) || "Cora";

const BODY = "'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const DISPLAY = "Unbounded,'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * { company, lang, link, role, agent: { name, role, archetype, does, focus }, site } → { subject, text, html }.
 * `role` alone still works (older callers): the agent card then shows the role.
 */
export function previewEmail({ company, lang, link, role = "", agent = null, site = "" }) {
  const key = COPY[lang] ? lang : "en";
  const copy = COPY[key];
  const who = line(company, 80) || "your company";
  const name = firstName(agent?.name || "");
  const title = roleTitle(agent?.role || role, key);
  const tint = TINT[agent?.archetype] || "#264cd6";
  const host = hostOf(site) || (key === "it" ? "il vostro sito" : key === "es" ? "vuestra web" : key === "de" ? "Ihre Website" : "your website");
  const focus = words(agent?.focus, 320);
  const does = line(agent?.does, 200);
  const facts = copy.facts.map(([head, body]) => [head, typeof body === "function" ? body(who) : body]);
  const subject = copy.subject(who, name);

  const text = [
    copy.title(who), "", copy.lead(who, host), "",
    `${name} · ${title}${does ? `\n${does}` : ""}`,
    focus ? `${copy.first}: ${focus}` : "", focus ? "" : null,
    `${copy.cta(name)}:\n${link}`, "",
    copy.asks, "",
    ...facts.map(([head, body]) => `- ${head}: ${body}`), "",
    copy.bye, HOME, "", copy.why,
  ].filter((item) => item !== null && item !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");

  const fact = ([head, body]) => `<tr><td valign="top" width="14" style="padding:3px 12px 14px 0"><div style="width:8px;height:8px;margin-top:6px;border-radius:50%;background:#264cd6;font-size:0;line-height:0">&nbsp;</div></td><td valign="top" style="padding:0 0 14px"><p class="ink" style="margin:0;font:600 15px/1.45 ${BODY};color:#0f1a3d">${esc(head)}</p><p class="slate" style="margin:2px 0 0;font:400 14px/1.5 ${BODY};color:#4a5270">${esc(body)}</p></td></tr>`;

  const html = `<!doctype html>
<html lang="${key}" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
body,table,td{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table{border-collapse:collapse}img{border:0;outline:none;text-decoration:none}a{color:#264cd6}
@media (max-width:620px){.shell{padding:16px 10px!important}.pad{padding-left:22px!important;padding-right:22px!important}.h1{font-size:25px!important}.btn a{display:block!important}}
@media (prefers-color-scheme:dark){.page{background:#0b1230!important}.card{background:#121b3f!important;border-color:#26305a!important}.agent{background:#0e1637!important;border-top-color:#26305a!important;border-right-color:#26305a!important;border-bottom-color:#26305a!important}.ink{color:#f4f5fb!important}.slate{color:#b9bfd6!important}.faint{color:#8a91ad!important}.rule{border-color:#26305a!important}.link{color:#9db1ff!important}}
</style></head>
<body class="page" style="margin:0;padding:0;background:#f5f3ec;color:#0f1a3d">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(copy.preheader(who, name))}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ec"><tr><td class="shell" align="center" style="padding:36px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 6px 20px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="padding-right:10px"><a href="${HOME}" style="text-decoration:none"><img src="${LOGO}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border-radius:8px"></a></td><td valign="middle"><a href="${HOME}" class="ink" style="font:700 20px/1 ${DISPLAY};letter-spacing:-0.02em;color:#0f1a3d;text-decoration:none">Cora</a></td></tr></table></td></tr>
<tr><td class="card" style="background:#ffffff;border:1px solid #e4e1d6;border-radius:20px;overflow:hidden">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td class="pad" style="padding:34px 36px 6px;overflow-wrap:anywhere;word-break:break-word">
<p style="margin:0 0 12px;font:600 14px/1.3 ${BODY};color:#264cd6">${esc(copy.kicker)}</p>
<h1 class="h1 ink" style="margin:0 0 14px;font:700 28px/1.2 ${DISPLAY};letter-spacing:-0.025em;color:#0f1a3d">${esc(copy.title(who))}</h1>
<p class="slate" style="margin:0 0 24px;font:400 16px/1.6 ${BODY};color:#4a5270">${esc(copy.lead(who, host))}</p>
</td></tr>
<tr><td class="pad" style="padding:0 36px">
<table role="presentation" class="agent" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf6;border:1px solid #e4e1d6;border-left:5px solid ${tint};border-radius:14px">
<tr><td style="padding:18px 20px;overflow-wrap:anywhere;word-break:break-word">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" style="padding-right:14px"><div style="width:44px;height:44px;border-radius:50%;border:3px solid ${tint};background:#ffffff;text-align:center;font:700 19px/44px ${DISPLAY};color:#0f1a3d">${esc(name.charAt(0).toUpperCase())}</div></td>
<td valign="middle"><p class="ink" style="margin:0;font:700 18px/1.25 ${DISPLAY};letter-spacing:-0.02em;color:#0f1a3d">${esc(name)}</p><p class="slate" style="margin:3px 0 0;font:500 14px/1.4 ${BODY};color:#4a5270">${esc(title)} · ${esc(who)}</p></td>
</tr></table>
${does ? `<p class="slate" style="margin:14px 0 0;font:400 15px/1.5 ${BODY};color:#4a5270">${esc(does.charAt(0).toUpperCase() + does.slice(1))}.</p>` : ""}
${focus ? `<p class="ink rule" style="margin:14px 0 0;padding-top:14px;border-top:1px solid #e4e1d6;font:400 15px/1.5 ${BODY};color:#0f1a3d"><b style="font-weight:600">${esc(copy.first)}:</b> ${esc(focus)}</p>` : ""}
</td></tr></table>
</td></tr>
<tr><td class="pad btn" style="padding:26px 36px 8px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" bgcolor="#264cd6" style="border-radius:999px;background:#264cd6"><a href="${esc(link)}" style="display:block;padding:16px 26px;font:600 16px/1.2 ${BODY};color:#ffffff;text-decoration:none;border-radius:999px">${esc(copy.cta(name))} &rarr;</a></td></tr></table>
</td></tr>
<tr><td class="pad" style="padding:18px 36px 8px"><p class="slate" style="margin:0;font:400 15px/1.6 ${BODY};color:#4a5270">${esc(copy.asks)}</p></td></tr>
<tr><td class="pad" style="padding:14px 36px 10px"><table role="presentation" class="rule" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e4e1d6"><tr><td style="padding-top:20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${facts.map(fact).join("")}</table></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 36px 30px;overflow-wrap:anywhere;word-break:break-all"><p class="faint" style="margin:0;font:400 12px/1.5 ${BODY};color:#858aa0">${esc(copy.fallback)}<br><a class="link" href="${esc(link)}" style="color:#264cd6;text-decoration:underline">${esc(link)}</a></p></td></tr>
</table></td></tr>
<tr><td style="padding:22px 10px 0;text-align:center"><p class="slate" style="margin:0 0 6px;font:500 14px/1.5 ${BODY};color:#4a5270">${esc(copy.bye)} · <a class="link" href="${HOME}" style="color:#264cd6;text-decoration:none">usecora.space</a></p><p class="faint" style="margin:0 auto;max-width:440px;font:400 12px/1.5 ${BODY};color:#858aa0">${esc(copy.why)}</p></td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}


