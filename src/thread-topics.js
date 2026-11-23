import { L } from "./prompt-lang.js";

/**
 * A thread named after an issue (REF-23, ACD-73, ...) is that issue's place. Its
 * keys are its topic and its channel is its subject: only the threads of the same channel are
 * its neighbours, a thread of another channel is another subject. Cora reads
 * this map in three places: the prompt (what this thread is about, where the other
 * issues live), the context from other threads (shown as pointers, not as work to
 * continue) and every message an agent sends (work on another thread's issue is
 * stopped and sent there).
 */

const KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9_]|-\d)/g;
// Codes that look like issue keys and never are.
const NOT_ISSUES = new Set(["UTF", "ISO", "SHA", "GPT", "RFC", "CVE", "TLS", "AES", "RSA", "HTTP", "MP", "ES", "ECMA", "COVID", "PDF", "ID", "IPV", "CP", "UTC", "GMT", "WCAG", "EN", "IT", "NO", "TOP", "PR", "TS", "LLAMA", "QWEN"]);

export function issueKeys(text) {
  const keys = [];
  for (const match of String(text || "").matchAll(KEY)) {
    if (NOT_ISSUES.has(match[1])) continue;
    const key = `${match[1]}-${Number(match[2])}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Words of a thread title that say nothing about its topic.
const PLAIN_WORDS = new Set(["lavoro", "lavori", "verifica", "controllo", "thread", "issue", "della", "delle", "dello", "degli", "nella", "nelle", "sulla", "sulle", "with", "from", "into", "about", "work", "check"]);
// Stems of the words any job uses, whatever its topic: they never tie a job to a place.
const PLAIN_STEMS = new Set(["verif", "contr", "ripor", "esito", "prove", "prova", "provan", "funzi", "siste", "guard", "hanno", "abbia", "quest", "quell", "perch", "anche", "sempr", "prima", "ancor", "tutto", "tutti", "tutte", "effet", "reale", "reali", "cerca", "fatto", "fare", "dopo", "come", "cosa", "dove", "quand", "sono", "esser", "deve", "devi", "ogni", "solo", "molto", "manda", "scriv", "repor", "verify", "make", "that", "this", "have", "shoul", "pleas"]);
const stems = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(KEY_TEXT, " ")
  .split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !PLAIN_WORDS.has(word)).map((word) => word.slice(0, 5)).filter((stem) => !PLAIN_STEMS.has(stem));
const KEY_TEXT = /\b[a-z][a-z0-9]{1,9}-\d{1,6}\b/gi;

/** A job without an issue key that still speaks of the thread's topic: it shares a word of the thread's title. */
export function sharesTopic(text, threadName) {
  const topic = new Set(stems(threadName));
  return Boolean(topic.size) && stems(text).some((word) => topic.has(word));
}

/** The channel a place belongs to: a thread's parent, otherwise the channel itself. */
export function channelOf(place) {
  return String(place?.parentId || place?.id || "");
}

/**
 * Whether two places are the same topic: the same channel, or that channel and its threads.
 * A thread of another channel is another topic, even on the same server and with a similar title.
 */
export function sameChannel(place, here) {
  return Boolean(place?.id && here?.id) && channelOf(place) === channelOf(here);
}

/**
 * The place whose title speaks of a job without an issue key: a thread of the same channel, or a
 * channel of the same server (a channel named after a project is that project). A thread of another
 * channel is never a candidate: words do not cross channels. It shares two words of the title, or
 * every word of a short one. The closest wins.
 */
export function topicPlace(places, here, text) {
  const words = new Set(stems(text));
  let best = null;
  for (const place of places || []) {
    if (!place?.id || place.id === here?.id || !here?.guildId || place.guildId !== here.guildId) continue;
    if ((place.thread || place.parentId) && !sameChannel(place, here)) continue;
    const title = [...new Set(stems(place.name))];
    const shared = title.filter((word) => words.has(word)).length;
    if (!shared || (shared < 2 && shared < title.length)) continue;
    if (!best || shared > best.shared || (shared === best.shared && place.thread && !best.place.thread)) best = { place, shared };
  }
  return best?.place || null;
}

export function threadLink(thread) {
  return thread.guildId ? `https://discord.com/channels/${thread.guildId}/${thread.id}` : `#${thread.name}`;
}

/**
 * The topic of `here`, with the channel it lives in, and the issues other threads own.
 * `others`: the threads of the same channel only, the ones an agent is shown as its neighbours.
 * `owners`: every thread of the server by its issue key, used only to send work on an exact key to
 * the thread of that issue, never as context.
 * `place`: `here` when it is a plain channel of a server (no thread): the channel itself is the topic.
 * `threads`: every known channel ({ id, name, guildId, thread, parentId }); `here` may carry `parentName`.
 */
export function threadTopics(threads, here) {
  const current = here?.thread || here?.parentId ? { id: here.id, name: here.name, parentId: here.parentId || "", parentName: here.parentName || "" } : null;
  // A channel of a server is a subject too, even without threads: its name is its topic.
  const place = !current && here?.guildId && here.name && here.name !== here.id ? { id: here.id, name: here.name, guildId: here.guildId } : null;
  const topic = current ? issueKeys(here.name) : [];
  const others = new Map();
  const owners = new Map();
  if (!here?.guildId) return { topic, others, owners, current, place };
  const seen = new Set();
  for (const thread of threads) {
    if (!thread?.id || seen.has(thread.id) || thread.id === here.id || thread.guildId !== here.guildId || !(thread.thread || thread.parentId)) continue;
    seen.add(thread.id);
    const near = sameChannel(thread, here);
    for (const key of issueKeys(thread.name)) {
      if (topic.includes(key)) continue;
      const entry = { id: thread.id, name: thread.name, guildId: thread.guildId, parentId: thread.parentId || "" };
      owners.set(key, [...(owners.get(key) || []), entry]);
      if (near) others.set(key, [...(others.get(key) || []), entry]);
    }
  }
  return { topic, others, owners, current, place };
}

/**
 * Work on another thread's issue written into a thread with its own topic. Passes:
 * a thread without a topic, a message that names this thread's issue too, an issue
 * the people here asked about by name (`asked`), and a short pointer that links the
 * other thread. Returns the first foreign issue and its threads, or null.
 */
export function threadLeak(text, { topic = [], others = new Map(), owners = null, asked = [] } = {}) {
  others = owners || others;
  if (!topic.length || !others.size) return null;
  const body = String(text || "");
  const mentioned = issueKeys(body);
  if (mentioned.some((key) => topic.includes(key))) return null;
  const allowed = new Set(asked);
  for (const key of mentioned) {
    const threads = others.get(key);
    if (!threads || allowed.has(key)) continue;
    const pointer = body.length <= 400 && threads.some((thread) => body.includes(`/${thread.id}`) || body.includes(`<#${thread.id}>`));
    if (pointer) continue;
    return { key, threads };
  }
  return null;
}

export function leakMessage(leak, topic) {
  const where = leak.threads.map((thread) => `«${thread.name}» (${threadLink(thread)}, channel_id "${thread.id}")`).join(" o ");
  return L`Questo thread è dedicato a ${topic.join(", ")}; ${leak.key} ha il suo thread: ${where}. Il lavoro su ${leak.key} va scritto là con say({text, channel_id: "${leak.threads[0].id}"}); qui al massimo un rimando breve con quel link. Non riportare qui il lavoro di quel thread.`;
}

export function leakPointer(leak) {
  return L`Questo riguarda ${leak.key}: ne parlo nel suo thread, ${threadLink(leak.threads[0])}`;
}
