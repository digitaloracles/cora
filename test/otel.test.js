import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { exporterConfig, otelIds, otelStatus, otlpRequest, OtlpExporter, traceparent, traceSpans } from "../src/otel.js";
import { Traces } from "../src/traces.js";
import { childEnv } from "../src/cli.js";

const start = Date.parse("2026-11-27T08:00:00Z");
const turn = (extra = {}) => ({
  id: "tr_00aa11bb22cc33dd", agentId: "ag_radix", kind: "chat", channelId: "1575777962886692875", model: "claude/opus-5.5",
  startedAt: new Date(start).toISOString(), endedAt: new Date(start + 10000).toISOString(), status: "done",
  tokensIn: 1200, tokensOut: 300, goal: "Allineare la telemetria", output: "Fatto", error: "",
  requestOrigin: { id: "m1", kind: "owner", delegated: false },
  steps: [
    { type: "thinking", text: "private reasoning", at: start + 1000 },
    { type: "tool", name: "shell", args: { command: "ls" }, result: "private result", ok: true, ms: 2000, at: start + 4000, planTask: { planId: "p1", taskId: "t1", text: "x" } },
    { type: "tool", name: "say", args: { text: "hi" }, result: "error: denied", ok: false, ms: 300, at: start + 6000 },
    { type: "note", text: "Errore harness", at: start + 7000, harnessFailure: { exitCode: 1, signal: "", timedOut: false } },
    { type: "text", text: "private answer", at: start + 9000 },
  ],
  ...extra,
});
const attr = (span, key) => {
  const found = span.attributes.find((item) => item.key === key)?.value;
  return found && (found.stringValue ?? found.intValue ?? found.boolValue ?? found.doubleValue);
};

test("a turn becomes an invoke_agent span with execute_tool children and W3C ids", () => {
  const [root, shell, say] = traceSpans(turn(), { agentName: "Radix" });
  const ids = otelIds("tr_00aa11bb22cc33dd");
  assert.match(ids.traceId, /^[0-9a-f]{32}$/);
  assert.match(ids.spanId, /^[0-9a-f]{16}$/);
  assert.deepEqual(otelIds("tr_00aa11bb22cc33dd"), ids, "ids are stable across exports");
  assert.equal(traceparent("tr_00aa11bb22cc33dd"), `00-${ids.traceId}-${ids.spanId}-01`);

  assert.equal(root.name, "invoke_agent Radix");
  assert.equal(root.traceId, ids.traceId);
  assert.equal(root.spanId, ids.spanId);
  assert.equal(root.parentSpanId, undefined);
  assert.equal(root.kind, 1);
  assert.equal(root.startTimeUnixNano, `${BigInt(start) * 1000000n}`);
  assert.equal(root.endTimeUnixNano, `${BigInt(start + 10000) * 1000000n}`);
  assert.deepEqual(root.status, { code: 1 });
  assert.equal(attr(root, "gen_ai.operation.name"), "invoke_agent");
  assert.equal(attr(root, "gen_ai.agent.id"), "ag_radix");
  assert.equal(attr(root, "gen_ai.agent.name"), "Radix");
  assert.equal(attr(root, "gen_ai.provider.name"), "anthropic");
  assert.equal(attr(root, "gen_ai.request.model"), "opus-5.5");
  assert.equal(attr(root, "cora.model.route"), "claude/opus-5.5");
  const [routed] = traceSpans(turn({ model: "hermes/ollama/deepseek-v4.1-flash" }));
  assert.equal(attr(routed, "gen_ai.provider.name"), undefined, "a multi-vendor harness names no vendor");
  assert.equal(attr(routed, "gen_ai.request.model"), "deepseek-v4.1-flash");
  assert.equal(attr(root, "gen_ai.conversation.id"), "1575777962886692875");
  assert.equal(attr(root, "gen_ai.usage.input_tokens"), "1200");
  assert.equal(attr(root, "gen_ai.usage.output_tokens"), "300");
  assert.equal(attr(root, "cora.trace.id"), "tr_00aa11bb22cc33dd");
  assert.equal(attr(root, "cora.request.kind"), "owner");
  assert.deepEqual(root.events.map((event) => event.name), ["cora.reasoning", "cora.note", "cora.text"]);
  assert.equal(attr(root.events[1], "cora.harness.exit_code"), "1");

  assert.equal(shell.name, "execute_tool shell");
  assert.equal(shell.parentSpanId, root.spanId);
  assert.equal(shell.traceId, root.traceId);
  assert.notEqual(shell.spanId, say.spanId);
  assert.equal(shell.startTimeUnixNano, `${BigInt(start + 2000) * 1000000n}`);
  assert.equal(shell.endTimeUnixNano, `${BigInt(start + 4000) * 1000000n}`);
  assert.equal(attr(shell, "gen_ai.tool.name"), "shell");
  assert.equal(attr(shell, "cora.plan.id"), "p1");
  assert.deepEqual(shell.status, { code: 1 });
  assert.equal(say.status.code, 2);

  const text = JSON.stringify([root, shell, say]);
  for (const secret of ["private reasoning", "private result", "private answer", "Allineare", "\"ls\""]) assert.ok(!text.includes(secret), `content stays out: ${secret}`);
  const withContent = JSON.stringify(traceSpans(turn(), { content: true }));
  for (const secret of ["private reasoning", "private result", "private answer", "Allineare"]) assert.ok(withContent.includes(secret), secret);
});

test("a failed turn is an error span; a stopped one stays unset", () => {
  const [failed] = traceSpans(turn({ status: "error", error: "harness crashed" }));
  assert.deepEqual(failed.status, { code: 2, message: "harness crashed" });
  assert.equal(attr(failed, "error.type"), "cora_turn_error");
  assert.deepEqual(traceSpans(turn({ status: "stopped" }))[0].status, {});
  const [bare] = traceSpans(turn({ endedAt: null, steps: [] }));
  assert.equal(bare.endTimeUnixNano, bare.startTimeUnixNano);
});

test("the exporter follows the standard OTEL_* variables", () => {
  assert.equal(exporterConfig({}), null);
  assert.equal(exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" }), null);
  assert.equal(exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_TRACES_EXPORTER: "none" }), null);
  const base = exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/", OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=a%3Db,team=cora", OTEL_EXPORTER_OTLP_TIMEOUT: "2500" });
  assert.equal(base.url, "http://c:4318/v1/traces");
  assert.deepEqual(base.headers, { "x-api-key": "a=b", team: "cora" });
  assert.equal(base.timeoutMs, 2500);
  assert.equal(base.content, false);
  assert.equal(exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://t.example/otlp/traces" }).url, "https://t.example/otlp/traces");
  assert.equal(exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }).content, true);
  assert.match(exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4317", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }).error, /gRPC/);
  const logged = [];
  assert.equal(OtlpExporter.fromEnv({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://c" }, log: (entry) => logged.push(entry) }), null);
  assert.match(logged[0].text, /OpenTelemetry/);
  const resource = otlpRequest([], { env: { OTEL_SERVICE_NAME: "cora-notseb", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=production" } }).resourceSpans[0].resource;
  assert.equal(attr(resource, "service.name"), "cora-notseb");
  assert.equal(attr(resource, "deployment.environment.name"), "production");
});

test("finished turns reach an OTLP/HTTP collector, and a dead collector never breaks a turn", async (t) => {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, type: req.headers["content-type"], auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const saved = [];
  const store = { saveTrace: (trace) => saved.push(trace.status), plans: { record() {} } };
  const exporter = OtlpExporter.fromEnv({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.address().port}`, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20fixture" }, agentName: () => "Radix" });
  const traces = new Traces({ store, exporter });
  const trace = traces.start({ agentId: "ag_radix", kind: "chat", channelId: "c1", model: "claude/opus", system: "never exported", prompt: "p" });
  trace.add({ type: "tool", name: "shell", args: {}, result: "ok", ok: true, ms: 5 });
  assert.equal(exporter.queue.length, 0, "a running turn is not exported");
  trace.finish({ status: "done", output: "fine" });
  await exporter.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].path, "/v1/traces");
  assert.equal(received[0].type, "application/json");
  assert.equal(received[0].auth, "Bearer fixture");
  const spans = received[0].body.resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(spans.map((span) => span.name), ["invoke_agent Radix", "execute_tool shell"]);
  assert.equal(spans[0].traceId, otelIds(trace.id).traceId);
  assert.ok(!JSON.stringify(received[0].body).includes("never exported"));

  const logged = [];
  const dead = OtlpExporter.fromEnv({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9", OTEL_EXPORTER_OTLP_TIMEOUT: "500" }, log: (entry) => logged.push(entry) });
  const quiet = new Traces({ store, exporter: dead });
  const other = quiet.start({ agentId: "ag_radix", kind: "chat" });
  other.finish({ status: "done" });
  assert.equal(other.status, "done");
  await dead.flush();
  assert.equal(logged.length, 1);
  assert.match(logged[0].text, /export fallito/);

  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.address().port}`, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20fixture", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=notseb" };
  const status = otelStatus(exporter, env);
  assert.equal(status.enabled, true);
  assert.equal(status.endpoint, `http://127.0.0.1:${server.address().port}/v1/traces`);
  assert.equal(status.environment, "notseb");
  assert.equal(status.authenticated, true);
  assert.equal(status.exported, 1);
  assert.ok(status.lastOkAt);
  assert.ok(!JSON.stringify(status).includes("fixture"), "the collector's key never reaches the panel");
  const failed = otelStatus(dead, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" });
  assert.equal(failed.failing, true);
  assert.equal(failed.lost, 1);
  assert.ok(failed.lastError);
});

test("the panel learns whether turns leave, and where to see them", () => {
  assert.deepEqual(otelStatus(null, {}), { enabled: false, viewerUrl: null, traceUrl: null });
  assert.equal(otelStatus(null, { OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://c" }).error, "OTLP endpoint must be http(s): ftp:");
  const links = otelStatus(null, { CORA_OTEL_VIEWER_URL: "https://cloud.langfuse.com/project/p1/traces", CORA_OTEL_TRACE_URL: "https://cloud.langfuse.com/project/p1/traces/{traceId}" });
  assert.equal(links.viewerUrl, "https://cloud.langfuse.com/project/p1/traces");
  assert.equal(links.traceUrl, "https://cloud.langfuse.com/project/p1/traces/{traceId}");
  assert.equal(otelStatus(null, { CORA_OTEL_TRACE_URL: "https://x.example/trace" }).traceUrl, null, "a trace link needs {traceId}");
  assert.equal(otelStatus(null, { CORA_OTEL_VIEWER_URL: "javascript:alert(1)" }).viewerUrl, null);
});

test("the agents' CLIs never inherit Cora's exporter settings", (t) => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-api-key=fixture";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
  t.after(() => { delete process.env.OTEL_EXPORTER_OTLP_HEADERS; delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; });
  const env = childEnv();
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.ok(env.PATH);
});
