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

The payload is OTLP/JSON over HTTP, which every OTLP/HTTP receiver accepts on port 4318 (OpenTelemetry Collector, Jaeger, Grafana Tempo/Alloy, Honeycomb, Langfuse, …). `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` is refused with an activity-log error: use the HTTP endpoint. Header secrets live in hush as `CORA_OTEL_EXPORTER_OTLP_HEADERS`; `bin/run.sh` injects them as `OTEL_EXPORTER_OTLP_HEADERS`. Never write them into `~/.cora/env`. `childEnv()` strips every `OTEL_*` variable, so the agents' CLIs neither inherit the collector key nor start exporting on their own.

A turn is queued when it finishes and sent in batches (32 turns or every 5 s, at most 512 waiting). Retryable answers (429, 502, 503, 504) and network errors are retried once; a collector that stays down costs only the queued spans and is logged once in the activity log, never inside a turn.

With owner-scoped knowledge (`CORA_OWNER_MEMORY=1`) one instance-wide collector receives every owner's turns: point it only at a backend the space administrator controls, and keep content capture off.

## On demand

- `GET /api/traces/:id/otlp` — one finished turn as an `ExportTraceServiceRequest` (OTLP/JSON). Same access rules as `GET /api/traces/:id`; 409 while the turn is running.
- `GET /api/threads/:id/otlp` — the finished turns of one thread visible to the caller (the same scope as `GET /api/threads/:id`).
- `?content=1` adds message content; the caller can already read it in the panel.

The panel MCP exposes them as `cora_trace_otlp` and `cora_thread_otlp`. The JSON can be posted as is to any `/v1/traces` receiver.

Tests: `test/otel.test.js` (conversion, configuration, a real HTTP collector and a dead one) and `test/panel-mcp-tools.test.js` (owner isolation and content opt-in on the endpoint).
