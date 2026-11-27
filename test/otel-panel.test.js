import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeWorld } from "./knowledge-fixtures.js";
import { otelIds } from "../src/otel.js";

test("the panel reads the export status and each turn's OpenTelemetry id, never the collector's key", async (t) => {
  const f = await knowledgeWorld();
  t.after(() => f.close());
  const off = await f.request(f.alice, "/api/otel");
  assert.equal(off.status, 200);
  assert.deepEqual(off.data, { enabled: false, viewerUrl: null, traceUrl: null });

  const agent = f.app.store.createAgent({ name: "Telemetry", brainOwnerId: f.alice.user.id, model: "ollama/fixture", enabled: false });
  const at = Date.parse("2026-11-27T08:00:00Z");
  f.app.store.saveTrace({ id: "tr_00aa11bb22cc33dd", agentId: agent.id, kind: "chat", channelId: "c-otel", model: "ollama/fixture", startedAt: new Date(at).toISOString(), endedAt: new Date(at + 4000).toISOString(), status: "done",
    steps: [{ type: "tool", name: "shell", args: { command: "ls" }, result: "ok", ok: true, ms: 900, at: at + 1000 }], output: "Fatto", error: "", tokensIn: 3, tokensOut: 2 });
  const detail = await f.request(f.alice, "/api/traces/tr_00aa11bb22cc33dd");
  assert.equal(detail.status, 200);
  assert.equal(detail.data.otelTraceId, otelIds("tr_00aa11bb22cc33dd").traceId);
  const otlp = await f.request(f.alice, "/api/traces/tr_00aa11bb22cc33dd/otlp");
  assert.equal(otlp.data.resourceSpans[0].scopeSpans[0].spans[0].traceId, detail.data.otelTraceId, "the panel's link opens the exported trace");
  assert.equal((await f.request(f.bob, "/api/traces/tr_00aa11bb22cc33dd")).status, 403);
});
