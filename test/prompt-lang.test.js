import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { characterSheet } from "../src/character.js";
import { agentSpecs, ARCHETYPES } from "../src/preview-pipeline.js";
import { L, PROMPT_LANGUAGES, clearMissingPrompts, missingPrompts, templateKey, tf, withPromptLanguage } from "../src/prompt-lang.js";
import de from "../src/prompt-lang/de.js";
import en from "../src/prompt-lang/en.js";
import es from "../src/prompt-lang/es.js";
import it from "../src/prompt-lang/it.js";

const DICTIONARIES = { en, es, de, it };
// Words only Italian has: an agent started in another language must not read them in its instructions.
const ITALIAN = /(?<![\p{L}])(il|della|delle|degli|che|non|tuo|tua|quando|rispondi|scrivi|questo|questa|anche|sono|nella|perché|già|segreti|sintesi|progressi|parli|torna|ricordi|scheda|ancora)(?![\p{L}])/giu;

/** Every L`` and LE`` template in the source, read without a parser: the fixed parts of each, cooked. */
function templates(source, tag) {
  const found = [];
  const opener = new RegExp(`(?<![\\w$.])${tag}\``, "g");
  let match;
  while ((match = opener.exec(source))) {
    let i = match.index + tag.length + 1;
    const parts = [""];
    const skipExpression = () => {
      let depth = 1;
      while (i < source.length && depth) {
        const c = source[i];
        if (c === "'" || c === "\"") { const q = c; i++; while (source[i] !== q) i += source[i] === "\\" ? 2 : 1; i++; continue; }
        if (c === "`") { i++; readTemplate(null); continue; }
        if (c === "{") depth++;
        if (c === "}") depth--;
        i++;
      }
    };
    const readTemplate = (into) => {
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") { if (into) into[into.length - 1] += source.slice(i, i + 2); i += 2; continue; }
        if (c === "`") { i++; return; }
        if (c === "$" && source[i + 1] === "{") { i += 2; skipExpression(); if (into) into.push(""); continue; }
        if (into) into[into.length - 1] += c;
        i++;
      }
    };
    readTemplate(parts);
    found.push(templateKey(parts.map((raw) => new Function(`return \`${raw}\`;`)())));
    opener.lastIndex = match.index + tag.length + 1;
  }
  return found;
}

const sources = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".js") && name !== "prompt-lang.js").map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"));

test("every Italian instruction has its English, Spanish and German text, and every demo card text its Italian, Spanish and German", () => {
  const italian = sources.flatMap((source) => templates(source, "L"));
  const english = sources.flatMap((source) => templates(source, "LE"));
  assert.ok(italian.length > 250, `found ${italian.length} Italian templates`);
  assert.ok(italian.includes("- Rispondi nella lingua di chi ti scrive."));
  for (const lang of ["en", "es", "de"]) assert.deepEqual(italian.filter((key) => DICTIONARIES[lang][key] == null), [], `Italian texts without ${lang}`);
  for (const lang of ["it", "es", "de"]) assert.deepEqual(english.filter((key) => DICTIONARIES[lang][key] == null), [], `English texts without ${lang}`);
});

test("a translation keeps every value, code span and word the code reads", () => {
  const kept = ["PASS", "LAVORO", "LAVORO per", "ESCI", "DONE", "<altrove", "</altrove>", "[Cora]", "★"];
  const holes = (text) => (text.match(/\{\d+\}/g) || []).sort().join();
  for (const [lang, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [source, text] of Object.entries(dictionary)) {
      assert.equal(holes(text), holes(source), `${lang}: ${source.slice(0, 60)}`);
      assert.equal((text.match(/`/g) || []).length, (source.match(/`/g) || []).length, `${lang} code spans: ${source.slice(0, 60)}`);
      for (const word of kept) assert.equal(text.split(word).length, source.split(word).length, `${lang} keeps ${word}: ${source.slice(0, 60)}`);
    }
  }
});

test("outside an agent's turn, and in Italian, the text is the one written in the code", () => {
  assert.equal(L`Tu (${"Mara"})`, "Tu (Mara)");
  assert.equal(withPromptLanguage("it", () => L`Tu (${"Mara"})`), "Tu (Mara)");
  assert.equal(withPromptLanguage("en", () => L`Tu (${"Mara"})`), "You (Mara)");
  assert.equal(withPromptLanguage("de", () => tf("{0} e {1}", "A", "B")), "A und B");
  assert.equal(withPromptLanguage("fr", () => L`Tu (${"Mara"})`), "Tu (Mara)", "a language Cora does not speak keeps Italian");
  assert.deepEqual(PROMPT_LANGUAGES, ["it", "en", "es", "de"]);
});

test("the character sheet reads in the agent's language for every trait, tie and style", () => {
  clearMissingPrompts();
  const sheets = [];
  for (const lang of ["en", "es", "de"]) withPromptLanguage(lang, () => {
    for (const high of [1, 5, 9, 12, 15, 18, 20]) for (const leader of ["initiative", "speed", "endurance", "analysis", "prudence", "warmth"]) for (const axis of [2, 8, 10, 12, 15, 19]) {
      const scores = { initiative: 10, speed: 10, endurance: 10, analysis: 10, prudence: 10, warmth: 10, [leader]: high };
      sheets.push(characterSheet({ enabled: true, scores, method: axis, focus: 20 - axis }, tf));
      sheets.push(characterSheet({ enabled: true, scores: { ...scores, warmth: high, analysis: high }, method: axis, focus: axis }, tf));
      sheets.push(characterSheet({ enabled: true, scores: Object.fromEntries(Object.keys(scores).map((key) => [key, high])), method: axis, focus: axis }, tf));
    }
  });
  assert.deepEqual(missingPrompts(), []);
  for (const sheet of sheets) assert.doesNotMatch(sheet, ITALIAN, sheet);
});

test("the demo's agent is written in the language of the request that made it", () => {
  const brief = { company: "Acme", site: "https://acme.com", summary: "Makes things.", products: ["Things"], audience: "People", tone: "Plain",
    agents: [{ archetype: "marketer", name: "Mia", role: ARCHETYPES.marketer.role, does: ARCHETYPES.marketer.does, focus: "posts", wish: "more visitors", starters: [] }] };
  clearMissingPrompts();
  const [english] = agentSpecs(brief, 0, "en");
  assert.equal(english.language, "en");
  assert.match(english.personality, /^You are Mia, the marketer of Acme[\s\S]*The company asked you for this: more visitors/);
  const [italian] = agentSpecs(brief, 0, "it");
  assert.equal(italian.language, "it");
  assert.match(italian.personality, /^Sei Mia/);
  assert.doesNotMatch(italian.personality, /\b(You are|The company|Start from this|Be concrete)\b/);
  for (const lang of ["es", "de"]) assert.doesNotMatch(agentSpecs(brief, 0, lang)[0].personality, /\b(You are|The company asked|Start from this|Be concrete)\b/);
  assert.deepEqual(missingPrompts(), []);
});

test("an agent started in English, Spanish or German reads all of its instructions in that language, Italian ones keep theirs", async (t) => {
  const f = await knowledgeWorld(); t.after(f.close);
  const turns = [];
  f.state.answer = (body) => {
    const system = String(body.messages[0]?.content || "");
    turns.push({ system, user: String(body.messages.filter((message) => message.role === "user").at(-1)?.content || "") });
    return { content: "Done." };
  };
  const agents = {};
  for (const [lang, name] of [["en", "Ava"], ["es", "Bea"], ["de", "Cleo"], ["it", "Dora"]]) {
    agents[lang] = f.app.store.createAgent({ name, model: "ollama/test-model", language: lang, gender: "female", enabled: true, tools: true, chattiness: 0,
      character: { enabled: true, scores: { initiative: 12, speed: 15, endurance: 13, analysis: 15, prudence: 17, warmth: 8 }, method: 15, focus: 4 } });
  }
  agents.sealed = f.app.store.createAgent({ name: "Eli", model: "ollama/test-model", language: "es", sealed: true, enabled: true, tools: false, chattiness: 0, personality: "Eres Eli." });
  clearMissingPrompts();
  for (const lang of ["en", "es", "de"]) {
    for (const options of [{ place: "test", computer: true }, { place: "test", withoutComputer: true }, { place: "", computer: false }]) {
      const prompt = f.app.brain.systemPrompt(f.app.store.agent(agents[lang].id), options);
      const leftovers = [...prompt.matchAll(ITALIAN)].map((m) => m[0]);
      assert.deepEqual(leftovers, [], `${lang} system prompt still has Italian: ${leftovers.join(", ")}`);
    }
  }
  assert.doesNotMatch(f.app.brain.systemPrompt(f.app.store.agent(agents.sealed.id), { place: "test" }), ITALIAN);
  assert.deepEqual(missingPrompts(), []);
  const italian = f.app.brain.systemPrompt(f.app.store.agent(agents.it.id), { place: "test", computer: true });
  assert.match(italian, /^Sei Dora\. Fai parte di Cora/);
  assert.match(italian, /- Rispondi nella lingua di chi ti scrive\./);

  for (const lang of ["en", "de"]) {
    const before = turns.length;
    await f.app.orchestrator.onWebMessage({ room: `web-${agents[lang].id}`, text: "Plan our launch" });
    const until = Date.now() + 15000;
    while (Date.now() < until && !turns.slice(before).some((turn) => turn.user.includes("Plan our launch"))) await new Promise((resolve) => setTimeout(resolve, 100));
    const turn = turns.slice(before).find((item) => item.user.includes("Plan our launch"));
    assert.ok(turn, `${lang}: the agent's turn reached the model`);
    const leftovers = [...`${turn.system}\n${turn.user}`.matchAll(ITALIAN)].map((m) => m[0]);
    assert.deepEqual(leftovers, [], `${lang} turn still has Italian: ${leftovers.join(", ")}`);
    assert.match(turn.user, lang === "en" ? /^Now: / : /^Jetzt: /);
  }
  assert.deepEqual(missingPrompts(), []);
});
