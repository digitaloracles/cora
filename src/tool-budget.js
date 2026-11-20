/**
 * Some harnesses cap the total size of an MCP server's tool list and drop the largest tools
 * past the cap without a word: Antigravity (Gemini) keeps about 63 KB and lost artifact_push,
 * artifact_share, gmail_send and four more when Cora listed 77 KB. Fit the list under a budget
 * instead: every tool keeps its name, types, enums and required fields, and only text is cut.
 */

const METADATA = new Set(["$schema", "$id", "$comment", "title", "examples"]);
const MIN_TEXT = 24;
const CORE_WEIGHT = 3;

export function toolListSize(tools) {
  return tools.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)), 0);
}

const firstSentence = (text) => String(text ?? "").match(/^.*?[.:;](?=\s|$)/s)?.[0] || "";
const family = (tool) => `${String(tool.name).split("_")[0]}\n${firstSentence(tool.description)}`;

function clip(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf(": "), head.lastIndexOf("; "));
  if (stop >= limit * 0.5) return head.slice(0, stop + 1).trimEnd();
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > limit * 0.5 ? space : limit - 1).trimEnd()}…`;
}

function slim(schema, limit) {
  if (Array.isArray(schema)) return schema.map((item) => slim(item, limit));
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (METADATA.has(key) || (key === "additionalProperties" && typeof value === "boolean")) continue;
    if (key === "description" && typeof value === "string") {
      if (limit >= MIN_TEXT || value.length <= limit) out[key] = clip(value, limit);
    } else if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, slim(property, limit)]));
    } else out[key] = slim(value, limit);
  }
  return out;
}

function shorten(tool, limit, preambles) {
  let description = String(tool.description ?? "");
  if (description.length > limit && preambles.has(family(tool))) description = description.slice(firstSentence(description).length).trimStart();
  return { ...tool, description: clip(description, Math.max(limit, MIN_TEXT)), inputSchema: slim(tool.inputSchema, limit) };
}

function waterline(tools, budget, core, preambles, weight) {
  let low = 0;
  let high = Math.max(...tools.map((tool) => String(tool.description ?? "").length), 1);
  let best = null;
  while (low <= high) {
    const limit = Math.floor((low + high) / 2);
    const attempt = tools.map((tool) => core.has(tool.name) ? shorten(tool, limit * weight, new Set()) : shorten(tool, limit, preambles));
    if (toolListSize(attempt) <= budget) {
      best = attempt;
      low = limit + 1;
    } else high = limit - 1;
  }
  return best;
}

/**
 * The tools as they are when they fit. Otherwise schema metadata goes, then the longest texts of
 * the tools are cut to one length, their family's shared opening sentence first, while the
 * `core` tools (Cora's own, not the connectors' API docs) keep three times as much.
 * No tool is ever left out.
 */
export function fitToolList(tools, budget, core = []) {
  if (!budget || toolListSize(tools) <= budget) return tools;
  const counts = new Map();
  for (const tool of tools) if (firstSentence(tool.description)) counts.set(family(tool), (counts.get(family(tool)) || 0) + 1);
  const preambles = new Set([...counts].filter(([, count]) => count >= 3).map(([key]) => key));
  const stripped = tools.map((tool) => shorten(tool, Infinity, preambles));
  if (toolListSize(stripped) <= budget) return stripped;
  return waterline(tools, budget, new Set(core), preambles, CORE_WEIGHT) || tools.map((tool) => shorten(tool, 0, preambles));
}
