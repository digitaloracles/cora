// The demo chat a company opens from its email (NOT-94): its agents, the time left and nothing else of Cora.
const LANG = (["it", "es", "de"].find((code) => (navigator.language || "").toLowerCase().startsWith(code))) || "en";
const T = {
  en: { send: "Send", message: "Message", placeholder: (n) => `Write to ${n}…`, left: (m) => (m <= 1 ? "1 minute left" : `${m} minutes left`), notStarted: (m) => `${m} minutes from your first message`, over: "Preview ended", writing: (n) => `${n} is writing…`,
    hello: (n, r, c) => `Hi, I'm ${n}, the ${r.toLowerCase()} at ${c}.`, intro: "I already know your company from its website. Ask me something real: I'll answer with drafts and plans you can use.", ended: "Your hour is over. Write to us at usecora.space to keep your agent.", failed: "The message did not go through. Try again.", away: "This page is for the people a preview was sent to. Open the link in your email." },
  it: { send: "Invia", message: "Messaggio", placeholder: (n) => `Scrivi a ${n}…`, left: (m) => (m <= 1 ? "Manca 1 minuto" : `Mancano ${m} minuti`), notStarted: (m) => `${m} minuti dal tuo primo messaggio`, over: "Anteprima finita", writing: (n) => `${n} sta scrivendo…`,
    hello: (n, r, c) => `Ciao, sono ${n}: ${r.toLowerCase()} di ${c}.`, intro: "Conosco già la tua azienda dal suo sito. Chiedimi qualcosa di concreto: ti rispondo con bozze e piani che puoi usare.", ended: "La tua ora è finita. Scrivici su usecora.space per tenere il tuo agente.", failed: "Il messaggio non è partito. Riprova.", away: "Questa pagina è per chi ha ricevuto un'anteprima. Apri il link nella tua email." },
  es: { send: "Enviar", message: "Mensaje", placeholder: (n) => `Escribe a ${n}…`, left: (m) => (m <= 1 ? "Queda 1 minuto" : `Quedan ${m} minutos`), notStarted: (m) => `${m} minutos desde tu primer mensaje`, over: "Vista previa terminada", writing: (n) => `${n} está escribiendo…`,
    hello: (n, r, c) => `Hola, soy ${n}: ${r.toLowerCase()} de ${c}.`, intro: "Ya conozco tu empresa por su web. Pídeme algo real: te respondo con borradores y planes que puedes usar.", ended: "Tu hora ha terminado. Escríbenos en usecora.space para quedarte con tu agente.", failed: "El mensaje no se ha enviado. Inténtalo de nuevo.", away: "Esta página es para quien recibió una vista previa. Abre el enlace de tu correo." },
  de: { send: "Senden", message: "Nachricht", placeholder: (n) => `Schreib ${n}…`, left: (m) => (m <= 1 ? "Noch 1 Minute" : `Noch ${m} Minuten`), notStarted: (m) => `${m} Minuten ab deiner ersten Nachricht`, over: "Vorschau beendet", writing: (n) => `${n} schreibt…`,
    hello: (n, r, c) => `Hallo, ich bin ${n}: ${r} bei ${c}.`, intro: "Ich kenne dein Unternehmen schon von seiner Website. Frag mich etwas Konkretes: Ich antworte mit Entwürfen und Plänen, die du nutzen kannst.", ended: "Deine Stunde ist vorbei. Schreib uns auf usecora.space, um deinen Agenten zu behalten.", failed: "Die Nachricht wurde nicht gesendet. Versuch es noch einmal.", away: "Diese Seite ist für Empfänger einer Vorschau. Öffne den Link in deiner E-Mail." },
}[LANG];
const ROLES = { it: { Manager: "Manager", Programmer: "Programmatore", Secretary: "Segretaria", Researcher: "Ricercatore", "Lead generator": "Lead generator", Marketer: "Marketer", "Customer support": "Assistenza clienti", Analyst: "Analista" },
  es: { Manager: "Mánager", Programmer: "Programador", Secretary: "Secretaria", Researcher: "Investigador", "Lead generator": "Generador de leads", Marketer: "Marketer", "Customer support": "Atención al cliente", Analyst: "Analista" },
  de: { Manager: "Manager", Programmer: "Entwickler", Secretary: "Sekretariat", Researcher: "Recherche", "Lead generator": "Leadgenerierung", Marketer: "Marketing", "Customer support": "Kundensupport", Analyst: "Analyst" } };
const SUGGEST = {
  en: { Manager: ["Plan our next quarter in five priorities", "Draft this week's team update"], Programmer: ["Sketch a small integration for our website", "Write a script that turns a CSV of orders into a weekly summary"], Secretary: ["Draft a polite follow-up to a client who has not answered", "Prepare the agenda for our Monday meeting"], Researcher: ["Who are our three closest competitors, and how do we differ?", "Summarise the trends that matter for our customers"], "Lead generator": ["Describe our ideal customer in five lines", "Write a three-email outreach sequence for them"], Marketer: ["Write three LinkedIn posts about what we do", "Ideas for this month's newsletter"], "Customer support": ["Answer a customer asking what we offer", "Write an FAQ for our main service"], Analyst: ["Which five numbers should we watch every week?", "Design a simple monthly report for us"] },
  it: { Manager: ["Pianifica il prossimo trimestre in cinque priorità", "Scrivi l'aggiornamento settimanale per il team"], Programmer: ["Abbozza una piccola integrazione per il nostro sito", "Scrivi uno script che trasforma un CSV di ordini in un riepilogo settimanale"], Secretary: ["Scrivi un sollecito gentile a un cliente che non risponde", "Prepara l'ordine del giorno della riunione di lunedì"], Researcher: ["Chi sono i nostri tre concorrenti più vicini e in cosa siamo diversi?", "Riassumi le tendenze che contano per i nostri clienti"], "Lead generator": ["Descrivi il nostro cliente ideale in cinque righe", "Scrivi una sequenza di tre email per contattarli"], Marketer: ["Scrivi tre post LinkedIn su quello che facciamo", "Idee per la newsletter di questo mese"], "Customer support": ["Rispondi a un cliente che chiede cosa offriamo", "Scrivi le FAQ del nostro servizio principale"], Analyst: ["Quali cinque numeri dovremmo guardare ogni settimana?", "Disegna un report mensile semplice per noi"] },
  es: { Manager: ["Planifica el próximo trimestre en cinco prioridades", "Redacta la actualización semanal del equipo"], Programmer: ["Esboza una pequeña integración para nuestra web", "Escribe un script que convierta un CSV de pedidos en un resumen semanal"], Secretary: ["Redacta un recordatorio amable a un cliente que no responde", "Prepara el orden del día de la reunión del lunes"], Researcher: ["¿Quiénes son nuestros tres competidores más cercanos y en qué nos diferenciamos?", "Resume las tendencias que importan a nuestros clientes"], "Lead generator": ["Describe a nuestro cliente ideal en cinco líneas", "Escribe una secuencia de tres correos para contactarlos"], Marketer: ["Escribe tres posts de LinkedIn sobre lo que hacemos", "Ideas para el boletín de este mes"], "Customer support": ["Responde a un cliente que pregunta qué ofrecemos", "Escribe las preguntas frecuentes de nuestro servicio principal"], Analyst: ["¿Qué cinco cifras deberíamos mirar cada semana?", "Diseña un informe mensual sencillo para nosotros"] },
  de: { Manager: ["Plane unser nächstes Quartal in fünf Prioritäten", "Schreib das wöchentliche Team-Update"], Programmer: ["Skizziere eine kleine Integration für unsere Website", "Schreib ein Skript, das eine CSV mit Bestellungen in eine Wochenübersicht verwandelt"], Secretary: ["Schreib eine freundliche Erinnerung an einen Kunden, der nicht antwortet", "Bereite die Tagesordnung für Montag vor"], Researcher: ["Wer sind unsere drei nächsten Wettbewerber und worin unterscheiden wir uns?", "Fasse die Trends zusammen, die für unsere Kunden zählen"], "Lead generator": ["Beschreibe unseren idealen Kunden in fünf Zeilen", "Schreib eine Sequenz aus drei E-Mails, um sie anzusprechen"], Marketer: ["Schreib drei LinkedIn-Posts über das, was wir tun", "Ideen für den Newsletter dieses Monats"], "Customer support": ["Antworte einem Kunden, der fragt, was wir anbieten", "Schreib die FAQ für unseren wichtigsten Service"], Analyst: ["Welche fünf Zahlen sollten wir jede Woche verfolgen?", "Entwirf einen einfachen Monatsbericht für uns"] },
}[LANG];

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => { const node = document.createElement(tag); for (const [key, value] of Object.entries(attrs)) { if (key === "class") node.className = value; else if (key === "color") node.style.background = value; else if (key.startsWith("on")) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value); } node.append(...children.filter((child) => child !== null && child !== undefined)); return node; };
const role = (value) => ROLES[LANG]?.[value] || value;
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
/** A little Markdown, after escaping: paragraphs, lists, bold and code. */
function render(text) {
  const blocks = String(text || "").trim().split(/\n{2,}/);
  return blocks.map((block) => {
    const inline = (line) => escape(line).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

const S = { preview: null, agent: null, messages: [], running: false, sending: false, failed: false, poll: null };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "x-cora": "1", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || String(response.status)), { status: response.status });
  return data;
}

function clock() {
  const p = S.preview, node = $("pv-clock");
  if (!p) return;
  const left = p.endsAt ? Math.max(0, Math.ceil((p.endsAt - Date.now()) / 60000)) : null;
  const over = p.ended || (p.endsAt && Date.now() >= p.endsAt);
  node.textContent = over ? T.over : left === null ? T.notStarted(p.minutes) : T.left(left);
  node.className = `pv-clock${over ? " over" : left !== null && left <= 5 ? " low" : ""}`;
  document.body.classList.toggle("pv-ended", Boolean(over));
  $("pv-input").disabled = Boolean(over); $("pv-send").disabled = Boolean(over) || S.sending;
  if (over || !S.failed) $("pv-fine").textContent = over ? T.ended : "";
}

function agents() {
  const nav = $("pv-agents");
  nav.replaceChildren(...(S.preview.agents.length > 1 ? S.preview.agents.map((agent) => el("button", { class: "pv-agent", type: "button", "aria-current": String(agent.id === S.agent?.id), onclick: () => choose(agent) },
    el("span", { class: "pv-face", color: agent.color }, agent.name.slice(0, 1)), el("b", {}, agent.name), el("small", {}, role(agent.role)))) : []));
}

/** Keeps the nodes already on screen and adds only what is new, so nothing redraws or animates again. */
const NODES = new Map();
const keyOf = (message) => message.key || (message.id ? `m:${message.id}` : `t:${message.at}`);
function node(key, make) {
  let item = NODES.get(key);
  if (!item) { item = make(); item.dataset.key = key; NODES.set(key, item); }
  return item;
}

function thread() {
  const box = $("pv-thread"), agent = S.agent;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const items = [];
  if (!S.messages.length && agent) {
    items.push(node(`intro:${agent.id}`, () => el("section", { class: "pv-intro" }, el("h1", {}, T.hello(agent.name, role(agent.role), S.preview.company)), el("p", {}, T.intro),
      el("div", { class: "pv-suggest" }, ...(agent.starters?.length ? agent.starters : SUGGEST[agent.role] || []).map((text) => el("button", { type: "button", onclick: () => send(text) }, text))))));
  }
  for (const message of S.messages) {
    const item = node(keyOf(message), () => el("div", { class: `pv-msg ${message.agentId ? "agent" : "me"}` }));
    if (item.dataset.content !== message.content) { item.innerHTML = render(message.content); item.dataset.content = message.content; }
    items.push(item);
  }
  if (S.running || S.sending) items.push(node(`writing:${agent?.id || ""}`, () => el("div", { class: "pv-msg agent writing" }, T.writing(agent?.name || ""))));
  items.forEach((item, i) => { if (box.children[i] !== item) box.insertBefore(item, box.children[i] || null); });
  while (box.children.length > items.length) box.lastElementChild.remove();
  const kept = new Set(items);
  for (const [key, item] of NODES) if (!kept.has(item)) NODES.delete(key);
  if (atBottom || S.sending) box.scrollTop = box.scrollHeight;
}

async function load() {
  if (!S.agent) return;
  const data = await api(`/api/rooms/web-${encodeURIComponent(S.agent.id)}/messages?limit=100`);
  const fresh = (data.messages || []).filter((message) => message.content && (!message.agentId || message.agentId === S.agent.id));
  for (const sent of S.messages.filter((message) => message.key)) {
    const match = fresh.find((message) => !message.agentId && message.content === sent.content && !message.key && message.at >= sent.at - 60000);
    if (match) { const item = NODES.get(sent.key); NODES.delete(sent.key); if (item) NODES.set(keyOf(match), item); }
  }
  S.messages = fresh;
  const last = S.messages.at(-1);
  S.running = Boolean((data.running || []).length) || Boolean(last && !last.agentId && Date.now() - last.at < 180000);
  thread();
  clearTimeout(S.poll);
  S.poll = setTimeout(() => load().catch(() => {}), S.running ? 2500 : 12000);
}

function choose(agent) {
  S.agent = agent; S.messages = []; NODES.clear(); $("pv-thread").replaceChildren();
  $("pv-input").placeholder = T.placeholder(agent.name);
  agents(); thread(); load().catch(() => {});
}

async function send(text) {
  const value = String(text || "").trim();
  if (!value || S.sending || !S.agent) return;
  S.sending = true; clock();
  const at = Date.now();
  S.messages.push({ content: value, agentId: null, at, key: `local:${at}` }); thread();
  try {
    S.failed = false;
    await api(`/api/rooms/web-${encodeURIComponent(S.agent.id)}/messages`, { method: "POST", body: JSON.stringify({ text: value }) });
    $("pv-input").value = ""; grow();
  } catch (error) {
    const lost = S.messages.pop(); NODES.get(lost?.key)?.remove(); NODES.delete(lost?.key);
    S.failed = true; $("pv-fine").textContent = T.failed;
  } finally {
    S.sending = false;
    await refresh().catch(() => {});
    await load().catch(() => {});
  }
}

async function refresh() {
  const state = await api("/api/state");
  if (!state.preview) { $("pv-thread").replaceChildren(el("section", { class: "pv-intro" }, el("p", {}, T.away))); $("pv-form").hidden = true; return; }
  S.preview = state.preview;
  $("pv-company").textContent = S.preview.company;
  document.title = `${S.preview.company} · Cora`;
  if (!S.agent || !S.preview.agents.some((agent) => agent.id === S.agent.id)) { if (S.preview.agents[0]) choose(S.preview.agents[0]); }
  else agents();
  clock();
}

function grow() { const input = $("pv-input"); input.style.height = "auto"; input.style.height = `${Math.min(180, input.scrollHeight)}px`; }

document.documentElement.lang = LANG;
$("pv-send").textContent = T.send;
$("pv-label").textContent = T.message;
$("pv-input").addEventListener("input", grow);
$("pv-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send($("pv-input").value); } });
$("pv-form").addEventListener("submit", (event) => { event.preventDefault(); send($("pv-input").value); });
refresh().catch((error) => { if (error.status === 401) $("pv-thread").replaceChildren(el("section", { class: "pv-intro" }, el("p", {}, T.away))); });
setInterval(clock, 15000);
setInterval(() => refresh().catch(() => {}), 60000);
