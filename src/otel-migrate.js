import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { exporterConfig, otlpRequest, traceSpans } from "./otel.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const BATCH_TURNS = 32;
const BATCH_SPANS = 2000;

const json = (text, fallback) => {
  if (text === null || text === undefined || text === "") return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};

/** A row of the traces table as the turn src/traces.js recorded, without the system prompt. */
export function traceFromRow(row) {
  const steps = json(row.steps, null);
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    channelId: row.channel_id || null,
    model: row.model || "",
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    status: row.status,
    tokensIn: Number(row.tokens_in) || 0,
    tokensOut: Number(row.tokens_out) || 0,
    goal: row.goal || "",
    output: row.output || "",
    error: row.error || "",
    steps: Array.isArray(steps) ? steps : [],
    dropped: Array.isArray(steps) ? Math.max(0, (Number(row.step_count) || 0) - steps.length) : Number(row.step_count) || 0,
    requestOrigin: json(row.request_origin, null),
    unreadableSteps: !Array.isArray(steps),
  };
}

/** What would make a backend drop or misplace the spans of one turn; empty when they are sound. */
export function checkSpans(spans) {
  const problems = [];
  const [root, ...children] = spans;
  if (!root) return ["no root span"];
  const seen = new Set();
  const nano = (value) => BigInt(value);
  for (const span of spans) {
    if (!HEX32.test(span.traceId) || /^0+$/.test(span.traceId)) problems.push(`bad trace id on ${span.name}`);
    if (!HEX16.test(span.spanId) || /^0+$/.test(span.spanId)) problems.push(`bad span id on ${span.name}`);
    if (span.traceId !== root.traceId) problems.push(`${span.name} outside the turn's trace`);
    if (seen.has(span.spanId)) problems.push(`duplicate span id ${span.spanId}`);
    seen.add(span.spanId);
    if (nano(span.endTimeUnixNano) < nano(span.startTimeUnixNano)) problems.push(`${span.name} ends before it starts`);
  }
  if (root.parentSpanId) problems.push("root span has a parent");
  for (const child of children) {
    if (child.parentSpanId !== root.spanId) problems.push(`${child.name} not under the turn`);
    if (nano(child.startTimeUnixNano) < nano(root.startTimeUnixNano) || nano(child.endTimeUnixNano) > nano(root.endTimeUnixNano)) problems.push(`${child.name} outside the turn's time`);
  }
  for (const event of root.events || []) {
    if (nano(event.timeUnixNano) <= 0n) problems.push(`${event.name} without a time`);
  }
  return problems;
}

/** The agents' names, so spans read `invoke_agent Radix` as the live export does. */
function agentNames(db) {
  const names = new Map();
  try {
    for (const row of db.prepare("SELECT id, data FROM agents").all()) names.set(row.id, json(row.data, {})?.name || "");
  } catch {}
  return names;
}

function columns(db) {
  return new Set(db.prepare("PRAGMA table_info(traces)").all().map((column) => column.name));
}

/**
 * Every finished turn still in a Cora database, oldest first, after `from`
 * (a `{ startedAt, id }` cursor) and started before `before`.
 */
export function* storedTurns(db, { before = new Date().toISOString(), from = null } = {}) {
  const have = columns(db);
  const optional = ["goal", "request_origin", "step_count", "output", "error"].filter((name) => have.has(name));
  const select = ["id", "agent_id", "kind", "channel_id", "model", "started_at", "ended_at", "status", "tokens_in", "tokens_out", "steps", ...optional].join(", ");
  const cursor = from ? "AND (started_at > ? OR (started_at = ? AND id > ?))" : "";
  const statement = db.prepare(`SELECT ${select} FROM traces WHERE status != 'running' AND started_at < ? ${cursor} ORDER BY started_at, id`);
  const params = from ? [before, from.startedAt, from.startedAt, from.id] : [before];
  for (const row of statement.iterate(...params)) yield traceFromRow(row);
}

async function post(config, body, fetchImpl) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    try {
      const response = await fetchImpl(config.url, {
        method: "POST",
        headers: { ...config.headers, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      const text = await response.text();
      if (response.ok) {
        const partial = json(text, {})?.partialSuccess || {};
        return { rejected: Number(partial.rejectedSpans) || 0, message: partial.errorMessage || "" };
      }
      last = new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/**
 * Moves the turns a Cora database still holds into OpenTelemetry: each batch
 * goes to an OTLP/HTTP collector, to an OTLP/JSON lines file (what the
 * Collector's file exporter writes and its otlpjsonfile receiver reads), or
 * both. Ids come from the tr_ ids, so a rerun sends the same spans; `state`
 * remembers the last turn sent and a rerun resumes after it.
 */
export async function migrateTraces({
  dbPath,
  env = process.env,
  endpoint = "",
  out = "",
  state = "",
  before = null,
  content = null,
  dryRun = false,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  let config = null;
  if (!dryRun) {
    const exportEnv = endpoint ? { ...env, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint, OTEL_SDK_DISABLED: "", OTEL_TRACES_EXPORTER: "otlp" } : env;
    config = exporterConfig(exportEnv);
    if (config?.error) throw new Error(config.error);
    if (!config && !out) throw new Error("no destination: set OTEL_EXPORTER_OTLP_ENDPOINT, --endpoint or --out");
  }
  const withContent = content ?? Boolean(config?.content);
  const saved = state && existsSync(state) ? json(readFileSync(state, "utf8"), null) : null;
  const from = saved?.last || null;
  before = before || saved?.before || new Date().toISOString();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = agentNames(db);
  const totals = { turns: 0, spans: 0, toolSpans: 0, events: 0, rejected: 0, unreadable: 0, invalid: [], byStatus: {}, first: null, last: null, resumedAfter: from };
  let batch = [];
  let batchSpans = 0;
  const flush = async () => {
    if (!batch.length) return;
    const request = otlpRequest(batch, { env });
    const body = JSON.stringify(request);
    if (!dryRun) {
      if (out) appendFileSync(out, `${body}\n`);
      if (config) {
        const answer = await post(config, body, fetchImpl);
        totals.rejected += answer.rejected;
        if (answer.rejected) log(`collector rejected ${answer.rejected} spans: ${answer.message}`);
      }
      const tail = batch.at(-1).trace;
      if (state) writeFileSync(state, JSON.stringify({ last: { startedAt: tail.startedAt, id: tail.id }, before, at: new Date().toISOString() }));
    }
    log(`${totals.turns} turns, ${totals.spans} spans`);
    batch = [];
    batchSpans = 0;
  };
  try {
    for (const trace of storedTurns(db, { before, from })) {
      const agentName = names.get(trace.agentId) || "";
      const spans = traceSpans(trace, { agentName, content: withContent });
      const problems = checkSpans(spans);
      if (problems.length) totals.invalid.push({ id: trace.id, problems: [...new Set(problems)].slice(0, 5) });
      if (trace.unreadableSteps) totals.unreadable += 1;
      totals.turns += 1;
      totals.spans += spans.length;
      totals.toolSpans += spans.length - 1;
      totals.events += spans[0].events.length;
      totals.byStatus[trace.status] = (totals.byStatus[trace.status] || 0) + 1;
      totals.first ??= trace.startedAt;
      totals.last = trace.startedAt;
      batch.push({ trace, agentName, content: withContent });
      batchSpans += spans.length;
      if (batch.length >= BATCH_TURNS || batchSpans >= BATCH_SPANS) await flush();
    }
    await flush();
  } finally {
    db.close();
  }
  return { ...totals, destination: dryRun ? "dry-run" : [config?.url, out].filter(Boolean).join(" + "), content: withContent, before };
}
