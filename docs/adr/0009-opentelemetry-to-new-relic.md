# ADR-0009: Instrument with OpenTelemetry, send it to New Relic

## Status

Accepted — 2026-10-08

## Context

[ADR-0006](./0006-structured-logging.md) made one audit traceable by filtering a
field, and named its own limit: logs from two services can be _correlated_ by
`auditId`, but nothing _connects_ them. The scan a visitor started on Vercel and
the scan a worker on a laptop ran are two unrelated streams that happen to share
an id. It also deferred the fix — "OpenTelemetry traces … the right long-term
answer … rejected for now as a much larger commitment" — until there was a
backend to send them to.

New Relic is that backend. The question this ADR answers is **how** the code
talks to it, because the obvious way does not fit this deployment:

- The **web app runs as Vercel serverless functions.** A function is frozen the
  instant it responds. An agent that batches telemetry on a timer and flushes it
  from a background harvest loop loses whatever had not been sent yet.
- The **worker is ESM run through `tsx`.** Agents that work by patching modules
  as they load need a loader hook that has to be in place before the first
  import, and ESM makes that fragile.
- The **queue is invisible to tracing.** Distributed tracing propagates context
  through HTTP headers. A BullMQ job is a JSON blob in Redis; nothing carries
  context across it unless the payload does.
- The data that answers real questions — which rule, which model, how many
  tokens, whether a failure was worth retrying — exists only in our code. No
  auto-instrumentation knows it.

## Decision

**Instrument with OpenTelemetry. Export over OTLP to New Relic's endpoint.**

New Relic ingests OTLP natively, so the backend is a URL and a header
(`api-key: <license key>`), not a library. A new `@ally-fix/telemetry` package
owns all of it:

- **Config is the environment.** `NEW_RELIC_LICENSE_KEY` turns everything on,
  `NEW_RELIC_REGION` picks US or EU. Any OTLP endpoint works through the standard
  `OTEL_EXPORTER_OTLP_*` variables, so the same build can send to a local
  collector. With neither set, nothing starts — tests, CI and self-hosters are
  unaffected.
- **Library code depends on the API only.** `@ally-fix/llm` imports
  `@opentelemetry/api`, which is a no-op until an SDK registers. The SDK, the
  exporters and their protobuf code live on a `./node` subpath only the worker
  loads.
- **Each runtime gets the SDK that fits it.** The worker runs the Node SDK with
  batch processors and flushes on SIGTERM. The web app uses `@vercel/otel`,
  which exports with `fetch` and flushes before the function freezes.
- **The trace crosses the queue.** The web app opens a `publish` span and writes
  its W3C `traceparent` into the job payload; the worker opens a `process` span
  with that as its parent. One trace runs from the POST to the finished report.
- **Spans are written by hand where the knowledge is.** The audit pipeline
  (`process` → `audit.scan` / `audit.analyze`), one span per LLM rule group, one
  `chat {model}` span per attempt. Each failed attempt carries the two axes of
  [ADR-0005](./0005-two-axis-llm-error-taxonomy.md) — `allyfix.llm.retryable` and
  `allyfix.llm.trips_breaker` — so a retry storm in a trace explains itself.
- **Logs join their trace.** The logger gained two hooks rather than a tracing
  dependency: `context` stamps `trace.id`/`span.id` on every line (the fields New
  Relic links on), and `tap` lets the worker ship records over OTLP, because on a
  laptop nothing collects stdout. Records reach the tap after redaction, so the
  export path cannot leak what stdout would not.
- **Metrics follow the GenAI semantic conventions** where they exist
  (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`) and
  `allyfix.*` where they do not. Unpriced calls add nothing to `allyfix.llm.cost`
  rather than zero — the [ADR-0008](./0008-tokens-are-measured-cost-is-configured.md)
  rule, carried into a new medium.

Details that are New Relic's requirements, not OTel defaults: counters are
exported with **delta** temporality (cumulative is accepted but converted), and
attribute values are truncated at **4095** characters — a stack trace in a log
attribute is longer, and New Relic drops rather than truncates.

## Alternatives considered

**The New Relic Node agent (`newrelic`).** The richest out-of-the-box APM: it
names transactions, maps external services, and has AI monitoring for some LLM
SDKs. Rejected on fit, not quality. It is not supported on Vercel's serverless
runtime; under ESM it needs a `--import` loader flag on every start script and
Dockerfile; it does not instrument postgres.js or the Vercel AI SDK this project
uses; and it would put a vendor's API into the code. **If the web app moved to a
long-running container and the LLM calls moved to a supported SDK, the agent
would buy more for less code.**

**Auto-instrumentation only (`@opentelemetry/auto-instrumentations-node`).**
Rejected. The spans it would add are ioredis — dominated by BullMQ's permanent
blocking poll, which buries the pipeline under idle traffic — and HTTP, which
undici instrumentation already covers. The spans that answer questions are the
ones only our code can write.

**An OpenTelemetry Collector in front of New Relic.** The textbook topology:
batching, retries, tail sampling, one place to change backends. Rejected for
now — the worker runs on demand from a laptop, and a collector would be a third
process to remember to start. The SDK exports directly; adding a collector later
is an environment change (`OTEL_EXPORTER_OTLP_ENDPOINT`), not a code change.

**Ship only logs, via a log drain.** Rejected: it is ADR-0006 with a nicer UI. It
does not connect the services, and it cannot show where time went inside a scan.

## Consequences

**Good**

- One trace per scan across both services, including how long the job waited
  in Redis for a worker — the number that matters most in the on-demand model.
- A failing LLM call is diagnosable from the trace alone: which attempt, which
  error class, whether it counted against the breaker, what it spent.
- Vendor-neutral: every line of instrumentation is OpenTelemetry. Replacing New
  Relic is a change to two environment variables.
- Telemetry is tested like everything else. Spans and metrics run through the
  real SDK into memory, and the exporter is tested against a local HTTP server
  for the path, header, encoding and compression New Relic expects.

**Bad**

- **No database spans.** postgres.js has no OpenTelemetry instrumentation, so DB
  time shows up only as unexplained time inside the pipeline spans.
- **No ioredis spans,** deliberately (see above) — a slow cache read is likewise
  only visible as time inside `audit.analyze`.
- **Less APM for free.** OTel services in New Relic do not get the agent's
  transaction naming, thread profiling or AI monitoring views; the dashboards
  are queries we wrote (`docs/observability.md`).
- **The web app exports traces and one metric, not logs.** New Relic's Summary
  page is built from `http.server.request.duration`, not from spans, so a span
  processor derives that metric from Next's request spans and flushes it with
  them before the function freezes. Its logs reach New Relic through Vercel's
  log drain integration, or not at all if that is not set up.
- **One attribute exists only for New Relic.** The worker's consumer span sets
  the pre-1.26 `messaging.operation` alongside `messaging.operation.type`,
  because New Relic names consumer transactions from the older attribute.
- **Delta metrics are New Relic's preference, not everyone's.** The generic OTLP
  path switches to cumulative, which is one more branch in the config.
- **Flushing costs exit time.** Shutdown waits up to 5s for the final export —
  inside the platform's SIGTERM→SIGKILL window, but it is time the process spends
  not exiting. An unreachable endpoint cannot stretch it further.

## See also

- [ADR-0006](./0006-structured-logging.md) — the logs this builds on, and the ADR
  that named OpenTelemetry as the follow-up.
- [`docs/observability.md`](../observability.md) — setup, what is emitted, and
  the queries behind the dashboard.
