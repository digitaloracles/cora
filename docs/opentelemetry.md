# OpenTelemetry export of agent turns

Every agent turn Cora records (`src/traces.js`, table `traces`) can be read as an OpenTelemetry trace that follows the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). The conversion lives in `src/otel.js` and has no runtime dependency.

## Shape

| Cora | OpenTelemetry |
| --- | --- |
| a turn (`tr_…`) | root span `invoke_agent <agent name>`, kind INTERNAL |
| a tool call step | child span `execute_tool <tool>`; start = end − `ms` |
| `thinking`, `text`, `note` steps | events `cora.reasoning`, `cora.text`, `cora.note` on the root span |
| status `done` / `pass` | span status OK |
| status `error` | span status ERROR with the error message, `error.type=cora_turn_error` |
| status `stopped` | span status UNSET, `cora.trace.status=stopped` |
| failed tool call (`ok: false`) | child span status ERROR |

Ids are W3C-valid and derived from the Cora id (`sha256`), so they are stable: exporting the same turn twice yields the same trace and span ids, and existing turns need no migration. `traceparent(id)` in `src/otel.js` gives the matching W3C header.

Root span attributes: `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.request.model` (last part of Cora's model route), `gen_ai.provider.name` (only for single-vendor harnesses: claude, codex, gemini, grok, deepseek), `gen_ai.conversation.id` (the thread or channel id: every turn of a thread shares it), `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus `cora.trace.id`, `cora.trace.kind`, `cora.trace.status`, `cora.model.route`, `cora.request.kind`, `cora.request.delegated`, `cora.trace.dropped_steps`. Tool spans carry `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.type=function` and, when the step belonged to a plan task, `cora.plan.id` / `cora.plan.task_id`.

Message content (goal, answer, reasoning, notes, tool arguments and results) is **not** included unless asked, as the conventions require. The system prompt is never exported.

## Live export (OTLP/HTTP)

Off by default. It turns on when the process environment sets the standard variables:

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | base URL; spans go to `<base>/v1/traces` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | full traces URL, used as is (wins over the base) |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `key=value,…`, percent-encoded values (e.g. `Authorization=Bearer%20…`) |
| `OTEL_EXPORTER_OTLP_TIMEOUT` / `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | milliseconds, default 10000 |
| `OTEL_SERVICE_NAME` | `service.name`, default `cora` |
| `OTEL_RESOURCE_ATTRIBUTES` | extra resource attributes, e.g. `deployment.environment.name=production` |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` | include message content |
| `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` | off |
| `CORA_OTEL_VIEWER_URL` | Cora's own: the backend's trace list, linked from the panel as "see traces live" |
| `CORA_OTEL_TRACE_URL` | Cora's own: one trace in the backend, with `{traceId}` where the OpenTelemetry trace id goes (e.g. `https://cloud.langfuse.com/project/<id>/traces/{traceId}`) |

The payload is OTLP/JSON over HTTP, which every OTLP/HTTP receiver accepts on port 4318 (OpenTelemetry Collector, Jaeger, Grafana Tempo/Alloy, Honeycomb, Langfuse, …). `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` is refused with an activity-log error: use the HTTP endpoint. Header secrets live in hush as `CORA_OTEL_EXPORTER_OTLP_HEADERS`; `bin/run.sh` injects them as `OTEL_EXPORTER_OTLP_HEADERS`. Never write them into `~/.cora/env`. `childEnv()` strips every `OTEL_*` variable, so the agents' CLIs neither inherit the collector key nor start exporting on their own.

A turn is queued when it finishes and sent in batches (32 turns or every 5 s, at most 512 waiting). Retryable answers (429, 502, 503, 504) and network errors are retried once; a collector that stays down costs only the queued spans and is logged once in the activity log, never inside a turn.

With owner-scoped knowledge (`CORA_OWNER_MEMORY=1`) one instance-wide collector receives every owner's turns: point it only at a backend the space administrator controls, and keep content capture off.

## In the panel

`GET /api/otel` (`otelStatus()` in `src/otel.js`) tells the panel whether the export is on, the traces URL (origin and path only), `service.name`, `deployment.environment.name`, whether content is captured, and the exporter's counters since start: turns sent, turns lost, waiting, last success, last error. Header values are never returned. The agent's Reasoning tab shows it as the OpenTelemetry panel, with the two links above when set.

Each turn page has "Scarica OpenTelemetry" (`/api/traces/:id/otlp`) and, when `CORA_OTEL_TRACE_URL` is set, a link to the same trace in the backend: `GET /api/traces/:id` carries `otelTraceId`, the id the export uses. The thread page downloads the whole thread (`/api/threads/:id/otlp`). Downloads work with the export off. Tests: `test/otel.test.js`, `test/otel-panel.test.js`.

## Migrating the turns already recorded

`scripts/otel-migrate.mjs` moves every finished turn still in a Cora database into OpenTelemetry, with the same conversion and ids as the live export (`src/otel-migrate.js`). It opens `cora.db` read-only and never changes it, so it can run next to a live Cora.

```
node scripts/otel-migrate.mjs --dry-run                       # convert and check every turn, send nothing
node scripts/otel-migrate.mjs --state ~/.cora/otel-migrate.json  # to the collector set by OTEL_EXPORTER_OTLP_*
node scripts/otel-migrate.mjs --endpoint http://collector:4318/v1/traces --before 2026-11-27T10:00:00Z
node scripts/otel-migrate.mjs --out turns.jsonl               # OTLP/JSON lines, for the Collector's otlpjsonfile receiver
```

| Option | Effect |
| --- | --- |
| `--db` | database, default `$CORA_HOME/cora.db` (`~/.cora/cora.db`) |
| `--endpoint` | full `/v1/traces` URL; otherwise the `OTEL_EXPORTER_OTLP_*` variables, headers included |
| `--out` | also append each batch as one OTLP/JSON line to a file |
| `--state` | remember the last turn sent; a rerun resumes after it and keeps the first run's `--before` |
| `--before` | only turns started before this time (default now); set it to when the live export was turned on so no turn is sent twice |
| `--content` | include message content (also `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`); the system prompt never leaves |
| `--dry-run` | convert and check only |

Running turns are skipped. Turns cut by a restart (`interrupted`, no end time) end at their last step. Every turn is checked before it leaves (W3C ids, one root, children under it and inside its time, no span ending before it starts); the JSON summary on stdout gives turns, spans, events, statuses, the spans the collector rejected (`partialSuccess`) and the turns that failed a check, and the exit code is 1 when either is not zero. A collector answering 408, 429 or 5xx is retried three times with backoff; any other error stops the run, and with `--state` the next run resumes from the last batch accepted.

Cora keeps the latest 300 turns per agent (`TRACES_KEPT_PER_AGENT`) and deletes older ones, so the migration covers what the database still holds.

## On demand

- `GET /api/traces/:id/otlp` — one finished turn as an `ExportTraceServiceRequest` (OTLP/JSON). Same access rules as `GET /api/traces/:id`; 409 while the turn is running.
- `GET /api/threads/:id/otlp` — the finished turns of one thread visible to the caller (the same scope as `GET /api/threads/:id`).
- `?content=1` adds message content; the caller can already read it in the panel.

The panel MCP exposes them as `cora_trace_otlp` and `cora_thread_otlp`. The JSON can be posted as is to any `/v1/traces` receiver.

Tests: `test/otel.test.js` (conversion, configuration, a real HTTP collector and a dead one), `test/otel-migrate.test.js` (migration: content, resume, file output, retries, rejected spans) and `test/panel-mcp-tools.test.js` (owner isolation and content opt-in on the endpoint).
