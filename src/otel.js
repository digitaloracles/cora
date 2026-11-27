import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || ""; } catch { return ""; }
})();
const SCOPE = { name: "cora.traces", version: VERSION };
const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;
const MAX_ATTRIBUTE = 4000;
const FLUSH_MS = 5000;
const BATCH = 32;
const QUEUE = 512;

const hex = (text, length) => createHash("sha256").update(text).digest("hex").slice(0, length);

/** W3C ids derived from Cora's own trace id: stable, so a turn exported twice keeps its ids. */
export function otelIds(traceId) {
  const id = String(traceId || "");
  return { traceId: hex(`cora-trace:${id}`, 32), spanId: hex(`cora-span:${id}`, 16) };
}

export function traceparent(traceId) {
  const ids = otelIds(traceId);
  return `00-${ids.traceId}-${ids.spanId}-01`;
}

const nanos = (ms) => `${BigInt(Math.max(0, Math.round(Number(ms) || 0))) * 1000000n}`;
const millis = (iso) => {
  const value = Date.parse(iso || "");
  return Number.isFinite(value) ? value : null;
};

function value(raw) {
  if (typeof raw === "boolean") return { boolValue: raw };
  if (typeof raw === "number") return Number.isInteger(raw) ? { intValue: String(raw) } : { doubleValue: raw };
  if (Array.isArray(raw)) return { arrayValue: { values: raw.map(value) } };
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return { stringValue: text.length > MAX_ATTRIBUTE ? `${text.slice(0, MAX_ATTRIBUTE)}…` : text };
}

export function attributes(map) {
  return Object.entries(map)
    .filter(([, raw]) => raw !== undefined && raw !== null && raw !== "" && !(Array.isArray(raw) && !raw.length))
    .map(([key, raw]) => ({ key, value: value(raw) }));
}

// The vendor behind a harness that runs only its own models, as gen_ai.provider.name spells it.
const VENDORS = { claude: "anthropic", codex: "openai", gemini: "gcp.gemini", grok: "x_ai", deepseek: "deepseek" };

/** Cora's model is a route (`harness/…/model`): the model is its last part, the vendor known only for single-vendor harnesses. */
function modelParts(model) {
  const parts = String(model || "").split("/").filter(Boolean);
  return { provider: parts.length > 1 ? VENDORS[parts[0]] || "" : "", name: parts.at(-1) || "", route: parts.length > 1 ? parts.join("/") : "" };
}

function status(trace) {
  if (trace.status === "error") return { code: STATUS_ERROR, message: String(trace.error || "error").slice(0, 1000) };
  if (trace.status === "done" || trace.status === "pass") return { code: STATUS_OK };
  return {};
}

/**
 * One finished Cora turn as OpenTelemetry spans, after the GenAI semantic
 * conventions: an `invoke_agent` span for the turn, an `execute_tool` child per
 * tool call, reasoning, text and harness notes as events. Message content
 * (prompt, reasoning, tool arguments and results, answer) is left out unless
 * `content` is true, as the conventions ask.
 */
export function traceSpans(trace, { agentName = "", content = false } = {}) {
  const ids = otelIds(trace.id);
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const started = millis(trace.startedAt) ?? (steps[0]?.at || Date.now());
  const lastStep = steps.reduce((latest, step) => Math.max(latest, Number(step.at) || 0), 0);
  const ended = Math.max(millis(trace.endedAt) ?? lastStep ?? started, started);
  const { provider, name: model, route } = modelParts(trace.model);
  const origin = trace.requestOrigin || null;
  const events = [];
  const spans = [];
  steps.forEach((step, index) => {
    const at = Number(step.at) || ended;
    const plan = step.planTask ? { "cora.plan.id": step.planTask.planId, "cora.plan.task_id": step.planTask.taskId } : {};
    if (step.type === "tool") {
      const end = Math.max(at, started);
      const start = Math.max(started, end - Math.max(0, Number(step.ms) || 0));
      spans.push({
        traceId: ids.traceId,
        spanId: hex(`cora-span:${trace.id}:${index}`, 16),
        parentSpanId: ids.spanId,
        name: `execute_tool ${step.name}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: nanos(start),
        endTimeUnixNano: nanos(end),
        attributes: attributes({
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": step.name,
          "gen_ai.tool.type": "function",
          "cora.tool.image": step.image || undefined,
          ...plan,
          ...(content ? { "gen_ai.tool.call.arguments": step.args, "gen_ai.tool.call.result": step.result } : {}),
        }),
        status: step.ok === false ? { code: STATUS_ERROR, message: String(step.result || "").slice(0, 300) } : { code: STATUS_OK },
      });
      return;
    }
    const name = step.type === "thinking" ? "cora.reasoning" : step.type === "text" ? "cora.text" : "cora.note";
    const failure = step.harnessFailure ? { "cora.harness.exit_code": step.harnessFailure.exitCode, "cora.harness.signal": step.harnessFailure.signal, "cora.harness.timed_out": step.harnessFailure.timedOut } : {};
    const recovery = step.recovery ? { "cora.harness.restart": step.recovery.restart } : {};
    events.push({
      timeUnixNano: nanos(at),
      name,
      attributes: attributes({ ...plan, ...failure, ...recovery, ...(step.progressPause ? { "cora.progress_pause": true } : {}), ...(content ? { "cora.text": step.text } : {}) }),
    });
  });
  const root = {
    traceId: ids.traceId,
    spanId: ids.spanId,
    name: `invoke_agent ${agentName || trace.agentId}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(started),
    endTimeUnixNano: nanos(ended),
    attributes: attributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": trace.agentId,
      "gen_ai.agent.name": agentName || undefined,
      "gen_ai.provider.name": provider || undefined,
      "gen_ai.request.model": model || undefined,
      "cora.model.route": route || undefined,
      "gen_ai.conversation.id": trace.channelId || undefined,
      "gen_ai.usage.input_tokens": Number(trace.tokensIn) || 0,
      "gen_ai.usage.output_tokens": Number(trace.tokensOut) || 0,
      "cora.trace.id": trace.id,
      "cora.trace.kind": trace.kind,
      "cora.trace.status": trace.status,
      "cora.trace.dropped_steps": Number(trace.dropped) || undefined,
      "cora.request.kind": origin?.kind,
      "cora.request.delegated": origin ? Boolean(origin.delegated) : undefined,
      "error.type": trace.status === "error" ? "cora_turn_error" : undefined,
      ...(content ? { "cora.goal": trace.goal, "cora.output": trace.output } : {}),
    }),
    events,
    droppedEventsCount: 0,
    status: status(trace),
  };
  return [root, ...spans];
}

/** OTEL_RESOURCE_ATTRIBUTES: `key=value,key=value`, values percent-encoded. */
export function parseKeyValues(text) {
  const out = {};
  for (const part of String(text || "").split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    let raw = part.slice(at + 1).trim();
    try { raw = decodeURIComponent(raw); } catch {}
    if (key) out[key] = raw;
  }
  return out;
}

export function resource(env = process.env) {
  const extra = parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES);
  return {
    attributes: attributes({
      ...extra,
      "service.name": env.OTEL_SERVICE_NAME || extra["service.name"] || "cora",
      "service.version": extra["service.version"] || VERSION,
      "telemetry.sdk.name": "cora",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.version": VERSION,
    }),
  };
}

/** A whole OTLP/JSON ExportTraceServiceRequest for some finished turns. */
export function otlpRequest(entries, { env = process.env } = {}) {
  return {
    resourceSpans: [{
      resource: resource(env),
      scopeSpans: [{ scope: SCOPE, spans: entries.flatMap(({ trace, agentName, content }) => traceSpans(trace, { agentName, content })) }],
    }],
  };
}

const truthy = (raw) => /^(1|true|yes|on)$/i.test(String(raw || "").trim());

/** Where the spans go, per the OTLP exporter spec; null when export is off. */
export function exporterConfig(env = process.env) {
  if (truthy(env.OTEL_SDK_DISABLED)) return null;
  const exporters = String(env.OTEL_TRACES_EXPORTER || "otlp").split(",").map((item) => item.trim().toLowerCase());
  if (!exporters.includes("otlp")) return null;
  const signal = String(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "").trim();
  const base = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || "").trim();
  if (!signal && !base) return null;
  const protocol = String(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL || "http/json").trim();
  const url = signal || `${base.replace(/\/+$/, "")}/v1/traces`;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return { error: `OTLP endpoint must be http(s): ${parsed.protocol}` };
  } catch {
    return { error: "OTLP endpoint is not a valid URL" };
  }
  if (protocol === "grpc") return { error: "OTLP over gRPC is not supported: use http/json (port 4318)" };
  const timeout = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT);
  return {
    url,
    headers: parseKeyValues(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10000,
    content: truthy(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT),
  };
}

/**
 * Sends finished turns to an OTLP/HTTP collector in batches. It never throws
 * into a turn: a collector that is down costs at most the queued spans.
 */
export class OtlpExporter {
  static fromEnv({ env = process.env, agentName = () => "", log = () => {}, fetchImpl = fetch } = {}) {
    const config = exporterConfig(env);
    if (!config) return null;
    if (config.error) {
      log({ type: "error", text: `OpenTelemetry: ${config.error}` });
      return null;
    }
    return new OtlpExporter({ ...config, env, agentName, log, fetchImpl });
  }

  constructor({ url, headers = {}, timeoutMs = 10000, content = false, env = process.env, agentName = () => "", log = () => {}, fetchImpl = fetch, flushMs = FLUSH_MS }) {
    Object.assign(this, { url, headers, timeoutMs, content, env, agentName, log, fetchImpl, flushMs });
    this.queue = [];
    this.timer = null;
    this.sending = null;
    this.failing = false;
    this.dropped = 0;
  }

  /** A turn that just finished. */
  add(trace) {
    if (!trace?.id || trace.status === "running") return;
    let agentName = "";
    try { agentName = this.agentName(trace.agentId) || ""; } catch {}
    this.queue.push({ trace: structuredClone(trace), agentName, content: this.content });
    if (this.queue.length > QUEUE) {
      this.dropped += this.queue.length - QUEUE;
      this.queue.splice(0, this.queue.length - QUEUE);
    }
    if (this.queue.length >= BATCH) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
      this.timer.unref?.();
    }
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.sending) await this.sending;
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, BATCH);
    this.sending = this.send(batch).finally(() => { this.sending = null; });
    await this.sending;
    if (this.queue.length) await this.flush();
  }

  /** On the way out: what is queued gets at most `ms` to leave. */
  async shutdown(ms = 3000) {
    let timer;
    await Promise.race([this.flush().catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  async send(batch) {
    const body = JSON.stringify(otlpRequest(batch, { env: this.env }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { ...this.headers, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) {
          if (this.failing) this.log({ type: "info", text: "OpenTelemetry: export ripreso" });
          this.failing = false;
          return true;
        }
        if (![429, 502, 503, 504].includes(response.status)) throw new Error(`HTTP ${response.status}`);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        else throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (attempt === 0 && error?.name !== "TimeoutError" && !/^HTTP 4/.test(error?.message || "")) continue;
        if (!this.failing) this.log({ type: "error", text: `OpenTelemetry: export fallito (${String(error?.message || error).slice(0, 200)}), ${batch.length} turni persi` });
        this.failing = true;
        return false;
      }
    }
    return false;
  }
}
