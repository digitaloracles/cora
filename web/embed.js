// Embed agent (NOT-117): an agent's public chat inside someone else's page. The visitor is a random key kept by
// this browser (storage partitioned by the site that frames us, which also works where third-party cookies do not).
const TEXTS = {
  en: { send: "Send", message: "Message", placeholder: (n) => `Write to ${n}…`, writing: (n) => `${n} is writing`, hello: (n) => `Hi, I'm ${n}.`, intro: "Ask me anything: I answer here, right away.",
    failed: "The message did not go through. Try again.", noReply: "I could not answer this one. Try again in a moment.", limit: "You have reached today's message limit for this chat.", busy: "Too many conversations right now: try again in a minute.",
    offline: (n) => `${n} is offline right now.`, gone: "This chat is not available.", mark: "Agent on Cora", close: "Close the chat",
    lead: "Before we start, leave your details.", leadOptional: "If you like, leave your details so you can be contacted.", name: "Name", email: "Email", phone: "Mobile", optional: "optional",
    start: "Start the chat", skip: "Skip", note: "They go to whoever runs this chat.", bad: { name: "Write your name (at most 80 characters).", email: "Check the email address.", phone: "Check the number: digits only, with the country code if you like.", missing: "Fill in the required fields." }, details: "Fill in the form first.", },
  it: { send: "Invia", message: "Messaggio", placeholder: (n) => `Scrivi a ${n}…`, writing: (n) => `${n} sta scrivendo`, hello: (n) => `Ciao, sono ${n}.`, intro: "Chiedimi pure: ti rispondo qui, subito.",
    failed: "Il messaggio non è partito. Riprova.", noReply: "Non sono riuscito a rispondere. Riprova tra poco.", limit: "Hai raggiunto il limite di messaggi di oggi per questa chat.", busy: "Troppe conversazioni in corso: riprova tra un minuto.",
    offline: (n) => `${n} adesso non è disponibile.`, gone: "Questa chat non è disponibile.", mark: "Agente su Cora", close: "Chiudi la chat",
    lead: "Prima di iniziare, lasciaci i tuoi dati.", leadOptional: "Se vuoi, lasciaci i tuoi dati per essere ricontattato.", name: "Nome", email: "Email", phone: "Cellulare", optional: "facoltativo",
    start: "Inizia la chat", skip: "Salta", note: "Li riceve chi gestisce questa chat.", bad: { name: "Scrivi il tuo nome (al massimo 80 caratteri).", email: "Controlla l'indirizzo email.", phone: "Controlla il numero: solo cifre, con il prefisso se vuoi.", missing: "Compila i campi obbligatori." }, details: "Compila prima il modulo.", },
  es: { send: "Enviar", message: "Mensaje", placeholder: (n) => `Escribe a ${n}…`, writing: (n) => `${n} está escribiendo`, hello: (n) => `Hola, soy ${n}.`, intro: "Pregúntame lo que quieras: te respondo aquí mismo.",
    failed: "El mensaje no se ha enviado. Inténtalo de nuevo.", noReply: "No he podido responder. Inténtalo de nuevo en un momento.", limit: "Has alcanzado el límite de mensajes de hoy en este chat.", busy: "Demasiadas conversaciones ahora: inténtalo en un minuto.",
    offline: (n) => `${n} no está disponible ahora.`, gone: "Este chat no está disponible.", mark: "Agente en Cora", close: "Cerrar el chat",
    lead: "Antes de empezar, déjanos tus datos.", leadOptional: "Si quieres, déjanos tus datos para que te contacten.", name: "Nombre", email: "Email", phone: "Móvil", optional: "opcional",
    start: "Empezar el chat", skip: "Omitir", note: "Los recibe quien gestiona este chat.", bad: { name: "Escribe tu nombre (máximo 80 caracteres).", email: "Revisa la dirección de email.", phone: "Revisa el número: solo cifras, con el prefijo si quieres.", missing: "Rellena los campos obligatorios." }, details: "Rellena antes el formulario.", },
  de: { send: "Senden", message: "Nachricht", placeholder: (n) => `Schreib ${n}…`, writing: (n) => `${n} schreibt`, hello: (n) => `Hallo, ich bin ${n}.`, intro: "Frag mich, was du willst: Ich antworte hier, sofort.",
    failed: "Die Nachricht wurde nicht gesendet. Versuch es noch einmal.", noReply: "Ich konnte nicht antworten. Versuch es gleich noch einmal.", limit: "Du hast das heutige Nachrichtenlimit für diesen Chat erreicht.", busy: "Gerade zu viele Gespräche: versuch es in einer Minute.",
    offline: (n) => `${n} ist gerade nicht erreichbar.`, gone: "Dieser Chat ist nicht verfügbar.", mark: "Agent auf Cora", close: "Chat schließen",
    lead: "Bevor wir anfangen, hinterlass bitte deine Daten.", leadOptional: "Wenn du magst, hinterlass deine Daten, damit man dich kontaktieren kann.", name: "Name", email: "E-Mail", phone: "Handy", optional: "optional",
    start: "Chat starten", skip: "Überspringen", note: "Sie gehen an die Person, die diesen Chat betreut.", bad: { name: "Schreib deinen Namen (höchstens 80 Zeichen).", email: "Prüf die E-Mail-Adresse.", phone: "Prüf die Nummer: nur Ziffern, gern mit Ländervorwahl.", missing: "Füll die Pflichtfelder aus." }, details: "Füll zuerst das Formular aus.", },
};
const LANG = (["it", "es", "de"].find((code) => (navigator.language || "").toLowerCase().startsWith(code))) || "en";
const T = TEXTS[LANG];
const TOKEN = (/^\/embed\/([A-Za-z0-9_-]{24})$/.exec(location.pathname) || [])[1] || "";
const BASE = `/embed/${TOKEN}`;

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => { const node = document.createElement(tag); for (const [key, value] of Object.entries(attrs)) { if (key === "class") node.className = value; else if (key.startsWith("on")) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value); } node.append(...children.filter((child) => child !== null && child !== undefined)); return node; };
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
/** A little Markdown, after escaping: paragraphs, lists, bold and code. */
function render(text) {
  return String(text || "").trim().split(/\n{2,}/).map((block) => {
    const inline = (line) => escape(line).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

/** This browser's key for this chat; kept in memory only where the site's storage is closed to us. */
function visitorKey() {
  const name = `cora.embed.${TOKEN}`;
  const make = () => { const bytes = new Uint8Array(24); crypto.getRandomValues(bytes); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  try {
    let key = localStorage.getItem(name);
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(key || "")) { key = make(); localStorage.setItem(name, key); }
    return key;
  } catch { return (visitorKey.memory ||= make()); }
}

const S = { agent: null, ask: {}, details: { needed: false }, messages: [], running: false, sending: false, poll: null, visitor: visitorKey() };
const ASKED = ["name", "email", "phone"];

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { credentials: "omit", cache: "no-store", ...options, headers: { "x-cora": "1", "x-cora-visitor": S.visitor, ...(options.body ? { "content-type": "application/json" } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || String(response.status)), { status: response.status });
  return data;
}

/** The owner's colours: the four they pick, and the shades the chat draws from them. */
const HEX = /^#[0-9a-f]{6}$/i;
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function applyTheme(theme = {}) {
  const pick = (key, fallback) => (HEX.test(theme[key] || "") ? theme[key] : fallback);
  const accent = pick("accent", "#264cd6"), background = pick("background", "#f5f3ec"), card = pick("card", "#ffffff"), text = pick("text", "#0f1a3d");
  const root = document.documentElement.style;
  const set = (name, value) => root.setProperty(name, value);
  set("--cobalt", accent); set("--paper", background); set("--card", card); set("--ink", text);
  set("--on-accent", luminance(accent) > 0.45 ? "#0f1a3d" : "#ffffff");
  set("--slate", `color-mix(in srgb, ${text} 72%, ${background})`);
  set("--faint", `color-mix(in srgb, ${text} 50%, ${background})`);
  set("--line", `color-mix(in srgb, ${text} 13%, ${background})`);
  const dark = luminance(background) < 0.2;
  set("--red", dark ? "#ff9b8f" : "#b42318");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}
// The panel's preview repaints while the owner picks colours, before they are saved.
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data?.type === "cora-embed-theme") applyTheme(event.data.theme);
});

function notice(text) { $("pv-fine").textContent = text || ""; }

/** The compose box opens once the visitor has answered the form, when the owner asks for details. */
function compose() {
  const closed = !S.agent?.online || S.details.needed;
  $("pv-input").disabled = closed; $("pv-send").disabled = closed || S.sending;
  $("pv-input").placeholder = S.details.needed ? T.details : T.placeholder(S.agent?.name || "");
}

/** The details the owner asks for, before the first message: name, email and mobile, each optional or required. */
function detailsForm() {
  const fields = ASKED.filter((key) => S.ask[key] === "optional" || S.ask[key] === "required");
  const required = fields.some((key) => S.ask[key] === "required");
  const inputs = {};
  const error = el("p", { class: "em-details-error", role: "alert" });
  const form = el("form", { class: "em-details", novalidate: "", autocomplete: "on" },
    el("p", { class: "em-details-lead" }, required ? T.lead : T.leadOptional),
    ...fields.map((key) => {
      inputs[key] = el("input", { id: `em-field-${key}`, name: key, type: key === "email" ? "email" : key === "phone" ? "tel" : "text", autocomplete: key === "phone" ? "tel" : key,
        inputmode: key === "phone" ? "tel" : key === "email" ? "email" : "text", maxlength: key === "email" ? "160" : key === "phone" ? "24" : "80", ...(S.ask[key] === "required" ? { required: "", "aria-required": "true" } : {}) });
      return el("label", { class: "em-field", for: `em-field-${key}` }, el("span", {}, T[key], S.ask[key] === "optional" ? el("small", {}, T.optional) : null), inputs[key]);
    }),
    error,
    el("div", { class: "em-details-actions" },
      el("button", { type: "submit", class: "em-start" }, T.start),
      required ? null : el("button", { type: "button", class: "em-skip", onclick: () => submit(true) }, T.skip)),
    el("p", { class: "em-details-note" }, T.note));
  const fail = (key) => {
    error.textContent = T.bad[key] || T.failed;
    for (const [name, input] of Object.entries(inputs)) input.toggleAttribute("aria-invalid", name === key || (key === "missing" && S.ask[name] === "required" && !input.value.trim()));
    (inputs[key] || Object.values(inputs).find((input) => input.hasAttribute("aria-invalid")))?.focus();
  };
  async function submit(skip = false) {
    error.textContent = "";
    if (!skip && fields.some((key) => S.ask[key] === "required" && !inputs[key].value.trim())) return fail("missing");
    const body = skip ? {} : Object.fromEntries(fields.map((key) => [key, inputs[key].value]));
    for (const button of form.querySelectorAll("button")) button.disabled = true;
    try {
      const data = await api("/visitor", { method: "POST", body: JSON.stringify(body) });
      S.details = data.details;
      thread(); compose();
      if (!S.details.needed) $("pv-input").focus();
    } catch (failure) {
      if (failure.status === 404) return gone();
      fail(failure.message);
    } finally {
      for (const button of form.querySelectorAll("button")) button.disabled = false;
    }
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
  return form;
}

const NODES = new Map();
function node(key, make) {
  let item = NODES.get(key);
  if (!item) { item = make(); NODES.set(key, item); }
  return item;
}

function thread() {
  const box = $("pv-thread"), name = S.agent?.name || "";
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const items = [];
  if (!S.messages.length) items.push(node("intro", () => el("section", { class: "pv-intro" }, el("h1", {}, T.hello(name)), el("p", {}, T.intro))));
  for (const message of S.messages) {
    const key = message.id || message.key;
    const item = node(key, () => message.role === "error" ? el("div", { class: "pv-msg failed" }, T.noReply) : el("div", { class: `pv-msg ${message.role === "agent" ? "agent" : "me"}` }));
    if (message.role !== "error" && item.dataset.content !== message.content) { item.innerHTML = render(message.content); item.dataset.content = message.content; }
    items.push(item);
  }
  if (S.details.needed) items.push(node("details", detailsForm));
  if (S.running || S.sending) items.push(node("writing", () => el("div", { class: "pv-msg agent writing", role: "status" }, el("span", {}, T.writing(name)), el("span", { class: "pv-dots", "aria-hidden": "true" }, el("i"), el("i"), el("i")))));
  items.forEach((item, i) => { if (box.children[i] !== item) box.insertBefore(item, box.children[i] || null); });
  while (box.children.length > items.length) box.lastElementChild.remove();
  const kept = new Set(items);
  for (const [key, item] of NODES) if (!kept.has(item)) NODES.delete(key);
  if (atBottom || S.sending) box.scrollTop = box.scrollHeight;
}

async function load() {
  clearTimeout(S.poll);
  try {
    const data = await api("/messages");
    const local = S.messages.filter((message) => message.key && !data.messages.some((item) => item.role === "visitor" && item.content === message.content && item.at >= message.at - 60000));
    S.messages = [...data.messages, ...local];
    S.running = Boolean(data.running);
    if (data.details) S.details = data.details;
    thread(); compose();
  } catch (error) {
    if (error.status === 404) return gone();
  }
  if (S.running) S.poll = setTimeout(load, 1500);
}

async function send(text) {
  const value = String(text || "").trim();
  if (!value || S.sending || !S.agent?.online || S.details.needed) return;
  S.sending = true; $("pv-send").disabled = true; notice("");
  const at = Date.now(), key = `local:${at}`;
  S.messages.push({ key, role: "visitor", content: value, at }); thread();
  try {
    await api("/messages", { method: "POST", body: JSON.stringify({ text: value }) });
    $("pv-input").value = ""; grow();
    S.running = true;
  } catch (error) {
    S.messages = S.messages.filter((message) => message.key !== key);
    if (error.status === 428) S.details = { needed: true };
    notice(error.status === 428 ? "" : error.status === 429 ? T.limit : error.status === 503 ? T.busy : error.status === 409 ? T.offline(S.agent.name) : error.status === 404 ? T.gone : T.failed);
  } finally {
    S.sending = false; compose();
    await load();
  }
}

function gone() {
  document.body.classList.add("em-off");
  $("pv-thread").replaceChildren(el("section", { class: "pv-intro" }, el("p", {}, T.gone)));
  $("pv-input").disabled = true; $("pv-send").disabled = true;
}

function grow() { const input = $("pv-input"); input.style.height = "auto"; input.style.height = `${Math.min(160, input.scrollHeight)}px`; }

async function start() {
  document.documentElement.lang = LANG;
  $("pv-send").textContent = T.send; $("pv-label").textContent = T.message; $("em-mark").textContent = T.mark;
  if (new URLSearchParams(location.search).get("floating") === "1" && window.parent !== window) {
    const close = $("em-close");
    close.hidden = false; close.setAttribute("aria-label", T.close); close.title = T.close;
    close.addEventListener("click", () => window.parent.postMessage({ type: "cora-embed-close" }, "*"));
  }
  if (!TOKEN) return gone();
  let state;
  try { state = await api("/state"); } catch { return gone(); }
  S.agent = state.agent;
  S.ask = state.ask || {};
  applyTheme(state.theme);
  document.title = S.agent.name;
  $("em-name").textContent = S.agent.name;
  $("em-desc").textContent = S.agent.description || "";
  const face = $("em-face");
  face.src = S.agent.avatar; face.hidden = false; face.addEventListener("error", () => { face.hidden = true; });
  $("pv-input").placeholder = T.placeholder(S.agent.name);
  if (!S.agent.online) { document.body.classList.add("em-off"); $("pv-input").disabled = true; $("pv-send").disabled = true; notice(T.offline(S.agent.name)); }
  thread();
  await load();
}

$("pv-input").addEventListener("input", grow);
$("pv-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send($("pv-input").value); } });
$("pv-form").addEventListener("submit", (event) => { event.preventDefault(); send($("pv-input").value); });
start();
