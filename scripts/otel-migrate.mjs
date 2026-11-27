#!/usr/bin/env node
// Moves the agent turns already in a Cora database into OpenTelemetry (docs/opentelemetry.md).
// Usage: node scripts/otel-migrate.mjs [--db ~/.cora/cora.db] [--endpoint <url>/v1/traces] [--out turns.jsonl]
//          [--state migrate.json] [--before <ISO>] [--content] [--dry-run]
// Without --endpoint the standard OTEL_EXPORTER_OTLP_* variables choose the collector, as for the live export.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { migrateTraces } from "../src/otel-migrate.js";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const flag = (name) => args.includes(name);
const home = process.env.CORA_HOME || join(homedir(), ".cora");
const before = option("--before");
if (before && Number.isNaN(Date.parse(before))) {
  console.error("--before wants an ISO date-time");
  process.exit(2);
}

try {
  const result = await migrateTraces({
    dbPath: resolve(option("--db", join(home, "cora.db"))),
    endpoint: option("--endpoint"),
    out: option("--out") && resolve(option("--out")),
    state: option("--state") && resolve(option("--state")),
    before: before ? new Date(before).toISOString() : null,
    content: flag("--content") ? true : null,
    dryRun: flag("--dry-run"),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.invalid.length || result.rejected ? 1 : 0);
} catch (error) {
  console.error(`otel-migrate: ${error.message || error}`);
  process.exit(1);
}
