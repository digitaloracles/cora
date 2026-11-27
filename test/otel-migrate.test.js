import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { otelIds } from "../src/otel.js";
import { checkSpans, migrateTraces } from "../src/otel-migrate.js";
import { Store } from "../src/store.js";

const start = Date.parse("2026-11-01T08:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const turn = (n, extra = {}) => ({
  id: `tr_${String(n).padStart(16, "0")}`, agentId: "ag_radix", kind: "chat", channelId: "157577", model: "claude/opus-5.5",
  startedAt: iso(start + n * 60000), endedAt: iso(start + n * 60000 + 9000), status: "done", tokensIn: 10, tokensOut: 5,
  prompt: "private prompt", system: "private system prompt", output: "private answer", error: "", goal: "private goal",
  steps: [
    { type: "thinking", text: "private reasoning", at: start + n * 60000 + 1000 },
    { type: "tool", name: "shell", args: { command: "ls" }, result: "private result", ok: true, ms: 2000, at: start + n * 60000 + 4000 },
    { type: "tool", name: "say", args: { text: "hi" }, result: "ok", ok: true, ms: 100, at: start + n * 60000 + 5000 },
  ],
  ...extra,
});

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "cora-otel-migrate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  store.db.prepare("INSERT OR REPLACE INTO agents(id, position, data) VALUES (?, 0, ?)").run("ag_radix", JSON.stringify({ id: "ag_radix", name: "Radix" }));
  for (let n = 1; n <= 40; n += 1) store.saveTrace(turn(n));
  // Turns cut by a restart keep no end: the last step closes them.
  store.saveTrace(turn(41, { status: "interrupted", endedAt: null }));
  store.saveTrace(turn(42, { status: "error", error: "boom" }));
  store.saveTrace(turn(43, { status: "running", endedAt: null }));
  store.close();
  return { home, dbPath: join(home, "cora.db") };
}

async function collector(t, { reject = 0, failFirst = 0 } = {}) {
  const bodies = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls += 1;
      if (calls <= failFirst) { res.writeHead(503).end("busy"); return; }
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reject ? { partialSuccess: { rejectedSpans: reject, errorMessage: "too old" } } : {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1/traces`, bodies };
}

const spansOf = (bodies) => bodies.flatMap((body) => body.resourceSpans.flatMap((item) => item.scopeSpans.flatMap((scope) => scope.spans)));

test("every finished turn of a Cora database reaches the collector once, without content", async (t) => {
  const { dbPath } = fixture(t);
  const sink = await collector(t);
  const result = await migrateTraces({ dbPath, endpoint: sink.url, env: { OTEL_SERVICE_NAME: "cora-test" } });
  assert.equal(result.turns, 42, "the running turn stays out");
  assert.equal(result.spans, 42 * 3);
  assert.equal(result.toolSpans, 84);
  assert.deepEqual(result.byStatus, { done: 40, interrupted: 1, error: 1 });
  assert.deepEqual(result.invalid, []);
  assert.equal(result.content, false);
  assert.equal(sink.bodies.length, 2, "batches of 32 turns");
  const spans = spansOf(sink.bodies);
  assert.equal(spans.length, 126);
  const roots = spans.filter((span) => span.name === "invoke_agent Radix");
  assert.equal(roots.length, 42);
  assert.deepEqual(new Set(roots.map((span) => span.traceId)).size, 42);
  assert.equal(roots[0].traceId, otelIds("tr_0000000000000001").traceId, "ids are the live export's");
  const interrupted = roots.find((span) => span.traceId === otelIds("tr_0000000000000041").traceId);
  assert.equal(interrupted.endTimeUnixNano, `${BigInt(start + 41 * 60000 + 5000) * 1000000n}`, "an interrupted turn ends at its last step");
  const text = JSON.stringify(sink.bodies);
  for (const secret of ["private prompt", "private system prompt", "private answer", "private reasoning", "private result", "private goal"]) assert.ok(!text.includes(secret), secret);
  assert.equal(sink.bodies[0].resourceSpans[0].resource.attributes.find((item) => item.key === "service.name").value.stringValue, "cora-test");
});

test("the migration resumes after the last turn sent and writes OTLP/JSON lines", async (t) => {
  const { home, dbPath } = fixture(t);
  const sink = await collector(t);
  const state = join(home, "state.json");
  const out = join(home, "turns.jsonl");
  const before = iso(start + 20 * 60000 + 1);
  const first = await migrateTraces({ dbPath, endpoint: sink.url, out, state, before, env: {} });
  assert.equal(first.turns, 20);
  const second = await migrateTraces({ dbPath, endpoint: sink.url, out, state, before: iso(start + 99 * 60000), env: {} });
  assert.equal(second.turns, 22, "only what is left");
  assert.equal(second.resumedAfter.id, "tr_0000000000000020");
  const again = await migrateTraces({ dbPath, endpoint: sink.url, out, state, env: {} });
  assert.equal(again.turns, 0, "nothing twice");
  const lines = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(spansOf(lines).length, 126);
  assert.deepEqual(spansOf(lines), spansOf(sink.bodies));
});

test("a dry run checks every turn and sends nothing; content only when asked", async (t) => {
  const { dbPath } = fixture(t);
  const sink = await collector(t);
  const dry = await migrateTraces({ dbPath, dryRun: true, env: { OTEL_EXPORTER_OTLP_ENDPOINT: sink.url.replace("/v1/traces", "") } });
  assert.equal(dry.turns, 42);
  assert.equal(sink.bodies.length, 0);
  await migrateTraces({ dbPath, endpoint: sink.url, content: true, env: {} });
  assert.ok(JSON.stringify(sink.bodies).includes("private reasoning"));
  assert.ok(!JSON.stringify(sink.bodies).includes("private system prompt"), "the system prompt never leaves");
  await assert.rejects(migrateTraces({ dbPath, env: {} }), /no destination/);
});

test("a busy collector is retried and spans it rejects are counted", async (t) => {
  const { dbPath } = fixture(t);
  const busy = await collector(t, { failFirst: 1 });
  const result = await migrateTraces({ dbPath, endpoint: busy.url, env: {} });
  assert.equal(spansOf(busy.bodies).length, 126);
  assert.equal(result.rejected, 0);
  const picky = await collector(t, { reject: 3 });
  assert.equal((await migrateTraces({ dbPath, endpoint: picky.url, env: {} })).rejected, 6);
});

test("spans that a backend would misplace are reported", () => {
  const root = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "invoke_agent", startTimeUnixNano: "100", endTimeUnixNano: "200", events: [] };
  assert.deepEqual(checkSpans([root, { ...root, spanId: "c".repeat(16), parentSpanId: root.spanId, name: "execute_tool x", startTimeUnixNano: "150", endTimeUnixNano: "190" }]), []);
  const problems = checkSpans([root, { ...root, spanId: "b".repeat(16), parentSpanId: "d".repeat(16), name: "execute_tool y", startTimeUnixNano: "50", endTimeUnixNano: "40" }]);
  assert.ok(problems.includes("duplicate span id bbbbbbbbbbbbbbbb"));
  assert.ok(problems.includes("execute_tool y ends before it starts"));
  assert.ok(problems.includes("execute_tool y not under the turn"));
  assert.ok(problems.includes("execute_tool y outside the turn's time"));
});
