import { AsyncLocalStorage } from "node:async_hooks";
import de from "./prompt-lang/de.js";
import en from "./prompt-lang/en.js";
import es from "./prompt-lang/es.js";
import it from "./prompt-lang/it.js";

/**
 * The language an agent's instructions are written in. Cora's prompts are written in Italian (L``)
 * or, for the demo's company cards, in English (LE``); every other language reads them from
 * src/prompt-lang/<lang>.js, keyed by the source text with {0}, {1}… where the values go.
 * The language follows the agent's turn through async calls: withPromptLanguage(lang, fn).
 */
export const PROMPT_LANGUAGES = ["it", "en", "es", "de"];
const DICTIONARIES = { it, en, es, de };
const current = new AsyncLocalStorage();
const missing = new Set();

export const promptLanguageOf = (value) => {
  const code = String(value || "").slice(0, 2).toLowerCase();
  return PROMPT_LANGUAGES.includes(code) ? code : "";
};

export const withPromptLanguage = (lang, fn) => current.run(promptLanguageOf(lang) || "it", fn);
export const promptLanguage = () => current.getStore() || "it";

/** The key of a template: its fixed parts, with {n} where the n-th value goes. */
export const templateKey = (strings) => strings.reduce((key, part, i) => (i ? `${key}{${i - 1}}${part}` : part), "");
const fill = (template, values) => template.replace(/\{(\d+)\}/g, (match, i) => (Number(i) < values.length ? String(values[Number(i)]) : match));
const keys = new WeakMap();

function render(source, strings, values) {
  const lang = promptLanguage();
  if (lang === source) return strings.reduce((text, part, i) => (i ? text + String(values[i - 1]) + part : part), "");
  let key = keys.get(strings);
  if (key === undefined) { key = templateKey(strings); keys.set(strings, key); }
  const translated = DICTIONARIES[lang]?.[key];
  if (translated == null) {
    missing.add(`${lang}\u0000${key}`);
    return strings.reduce((text, part, i) => (i ? text + String(values[i - 1]) + part : part), "");
  }
  return fill(translated, values);
}

/** An Italian prompt text, in the language of the current agent turn. */
export const L = (strings, ...values) => render("it", strings, values);
/** An English prompt text (the demo's company cards), in the language of the current agent turn. */
export const LE = (strings, ...values) => render("en", strings, values);

function plain(sourceLang, text, values) {
  const lang = promptLanguage();
  const source = String(text ?? "");
  if (lang === sourceLang) return fill(source, values);
  const translated = DICTIONARIES[lang]?.[source];
  if (translated == null) { missing.add(`${lang}\u0000${source}`); return fill(source, values); }
  return fill(translated, values);
}

/** A plain Italian text with {n} placeholders (tables, shared modules), translated and filled. */
export const tf = (text, ...values) => plain("it", text, values);
/** A plain English text with {n} placeholders (the demo's archetypes), translated and filled. */
export const te = (text, ...values) => plain("en", text, values);

/** The prompts asked for in a language that has no text for them yet (tests). */
export const missingPrompts = () => [...missing].map((item) => { const [lang, key] = item.split("\u0000"); return { lang, key }; });
export const clearMissingPrompts = () => missing.clear();

/** The locale dates and times are written in, for the current agent turn. */
export const promptLocale = () => ({ it: "it-IT", en: "en-GB", es: "es-ES", de: "de-DE" })[promptLanguage()];
