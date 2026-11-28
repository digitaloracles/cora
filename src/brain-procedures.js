import { searchText } from "./company-brain.js";

/**
 * When an agent hits a wall, the owner's Brain often already says how to get past it:
 * a procedure, or a rule such as "re-authenticate on your own". These helpers find those
 * pages for a failed tool call or for a reply that declares a block, so Cora can put them
 * in front of the agent instead of trusting it to search.
 */

/** Errors worth a lookup: access, credentials, sessions, refusals. */
export const ACCESS_ERROR = /\b(?:auth\w*|reauth\w*|credential\w*|credenzial\w*|rifiutat\w*|refused|rejected|log ?in|login|sign.?in|token\w*|expired|scadut\w+|permission\w*|permess\w+|denied|negat\w+|forbidden|unauthori[sz]ed|not allowed|non autorizzat\w+|invalid_grant|password|session\w*|sessione|keychain|hush|api.?key|access|accesso|401|403)\b/i;

/** A reply that says the work stopped on something the agent could not get past. */
export const BLOCK_WORDS = /\b(?:unverified|blocked|bloccat[oaie]|blocco|cannot (?:access|proceed|continue)|can't (?:access|proceed|continue)|unable to (?:access|authenticate|log ?in)|needs? (?:the )?owner|non (?:sono riuscit[oaie]|riesco|posso) (?:a |ad )?(?:accedere|autenticar\w*|entrare|leggere|proseguire|continuare|verificare)|(?:accesso|autenticazione|login|rinnovo)[^.\n]{0,60}(?:fallit[oa]|negat[oa]|rifiutat[oa]|scadut[oa])|serve (?:ripristinare|riattivare|rifare|il tuo|un tuo|la tua|che tu)|(?:ripristinare|riattivare) (?:l'|l’)?(?:autenticazione|accesso|login|profilo))/i;

const PROCEDURE_KINDS = new Set(["procedure", "decision"]);
const MIN_SCORE = 2;
const STOP = new Set(("error errore errori failed fallito fallita please run command comando output exit with from that this have there your when what will into then than were been only also more none null true false " +
  "della delle dello degli nella nelle sono essere fatto fare come anche ancora quindi perche oppure sulla sullo questo questa quello quella oggi ieri " +
  "the and for not you are was can could should would must cannot during current obtain shell http https home agent work tmp file files line lines code status message messages result results tool tools").split(" "));

/** The distinctive words of a text: no stop words, no numbers, at least four letters. */
export function salientWords(text) {
  const words = searchText(text).split(" ").filter((word) => word.length >= 4 && !/^\d+$/.test(word) && !STOP.has(word));
  return [...new Set(words)].slice(0, 40);
}

/** How many distinctive words of the problem a page carries, and how many of them in its slug or title. */
export function procedureScore(words, page) {
  const head = searchText(page.slug.replace(/-/g, " "), page.title);
  const all = `${head} ${searchText(page.summary || "", page.body || "")}`;
  const has = (text, word) => (word.length >= 6 ? text.includes(word) : new RegExp(`(?:^|\\s)${word}(?:\\s|$)`).test(text));
  const hits = words.filter((word) => has(all, word));
  return { score: hits.length, title: hits.filter((word) => has(head, word)).length, hits };
}

/**
 * The procedure and rule pages that answer a problem, best first: a page counts with at least
 * two distinctive words of the problem, one of them in its slug or title. Nothing above the bar,
 * nothing returned: a normal error adds no noise.
 */
export async function findProcedures(brain, query, { exclude = new Set(), limit = 3 } = {}) {
  if (!brain?.enabled || typeof brain.search !== "function") return [];
  const words = salientWords(query);
  if (words.length < MIN_SCORE) return [];
  const pages = await brain.search(String(query).slice(0, 1500), { limit: 12 });
  return pages
    .filter((page) => page?.slug && PROCEDURE_KINDS.has(page.kind) && !exclude.has(page.slug))
    .map((page) => ({ page, ...procedureScore(words, page) }))
    .filter((match) => match.score >= MIN_SCORE && match.title >= 1)
    .sort((a, b) => b.score - a.score || (a.page.kind === "procedure" ? -1 : 1) - (b.page.kind === "procedure" ? -1 : 1) || (a.page.pending ? 1 : 0) - (b.page.pending ? 1 : 0))
    .slice(0, limit)
    .map(({ page, score, hits }) => ({ slug: page.slug, title: page.title, kind: page.kind, summary: String(page.summary || "").slice(0, 300), reviewed: !page.pending, score, hits }));
}

/** The words of a failed call that say what failed: the tool, what it was asked, and the error lines. */
export function failureQuery(name, args, text) {
  const asked = name === "shell" ? String(args?.command || "") : Object.values(args || {}).filter((value) => typeof value === "string").join(" ");
  const lines = String(text || "").split("\n").filter((line) => ACCESS_ERROR.test(line) || /^error:/i.test(line)).slice(-6).join(" ");
  return `${name === "shell" ? "" : name.replace(/_/g, " ")} ${asked.slice(0, 400)} ${(lines || String(text || "").slice(-600)).slice(0, 800)}`.trim();
}

/** A real tool call that failed in a way the Brain may know how to fix; null otherwise. */
export function toolFailure(name, args, text) {
  const output = String(text || "");
  const exit = /^\[(?:exit (\d+)|timed out[^\]]*)\]/.exec(output);
  if (name === "shell" || exit) {
    if (!exit || exit[1] === "0" || !ACCESS_ERROR.test(output.slice(exit[0].length))) return null;
  } else if (!/^error:/i.test(output)) return null;
  return { query: failureQuery(name, args, output), signature: `${name}:${searchText(output).slice(0, 160)}` };
}

/** Whether a reply declares that the work stopped on a block. */
export const declaresBlock = (text) => BLOCK_WORDS.test(String(text || ""));

/** The sentences of a reply that carry the block: the query for the lookup. */
export function blockQuery(text) {
  const sentences = String(text || "").split(/(?<=[.!?:])\s+|\n+/).filter((sentence) => BLOCK_WORDS.test(sentence) || ACCESS_ERROR.test(sentence));
  const topic = String(text || "").replace(/\s+/g, " ").slice(0, 200);
  return `${topic} ${sentences.slice(0, 4).join(" ")}`.slice(0, 1000);
}

/** The pages, as the agent reads them. */
export const procedureLines = (pages) => pages.map((page) => `- [${page.slug}] ${page.title} (${page.kind}${page.reviewed ? ", reviewed" : ", not reviewed yet"}): ${page.summary}`).join("\n");
