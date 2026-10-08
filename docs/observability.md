# Observability with New Relic

AllyFix is instrumented with **OpenTelemetry** and sends traces, metrics and logs
to **New Relic** over OTLP. Why it is built that way, and what it cost, is in
[ADR-0009](./adr/0009-opentelemetry-to-new-relic.md). This page covers turning it
on and what you get.

Telemetry is **off by default**. Without the variables below nothing starts, and
nothing in the app behaves differently.

## Turn it on

1. In New Relic, go to **API keys** and copy (or create) an **INGEST - LICENSE**
   key. A user key (`NRAK-…`) will not work.
2. Set it for each service you want to see:

   | Variable                | Web (Vercel) |  Worker  | Notes                                               |
   | ----------------------- | :----------: | :------: | --------------------------------------------------- |
   | `NEW_RELIC_LICENSE_KEY` |      ✅      |    ✅    | Ingest license key. Turns telemetry on.             |
   | `NEW_RELIC_REGION`      |   optional   | optional | `us` (default) or `eu` — must match your account.   |
   | `OTEL_SERVICE_NAME`     |   optional   | optional | Defaults to `ally-fix-web` / `ally-fix-worker`.     |
   | `OTEL_SDK_DISABLED`     |   optional   | optional | `true` silences telemetry without removing the key. |

3. Start the worker (`pnpm --filter @ally-fix/worker start:demo`). Its first
   log line says where telemetry is going:

   ```
   INFO  worker started  … telemetry=newrelic via otlp.nr-data.net:4318
   ```

4. Run a scan. Within a minute both services appear under **APM & Services →
   OpenTelemetry**.

To send somewhere other than New Relic — a local collector, Jaeger, Grafana —
leave the license key unset and use the standard variables instead:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_HEADERS=x-scope-orgid=dev   # optional
```

## What you get

### One trace per scan, across both services

```
POST /api/audits                         ally-fix-web     (Next.js)
└─ publish audit-scan                    ally-fix-web     PRODUCER
   └─ process audit-scan                 ally-fix-worker  CONSUMER   allyfix.audit.queue_wait_ms
      ├─ audit.scan                                                  allyfix.scan.issues
      └─ audit.analyze                                               analyzed / failed / skipped / cache_hits
         └─ llm.analyze_group  (one per axe rule, cache misses only)  rule_id, attempts, cost_usd
            ├─ chat llama3.1   attempt 1  ✗ LlmValidationError  retryable=true  trips_breaker=false
            │  └─ POST         (undici)
            └─ chat llama3.1   attempt 2  ✓  gen_ai.usage.input_tokens / output_tokens
```

The web app writes the trace context into the BullMQ job, so the worker's spans
join the request that enqueued them — even when the job waited hours for an
on-demand worker. That wait is on the consumer span, and as a metric.

To find a scan's trace from its audit id: **Query your data** →

```sql
SELECT trace.id FROM Span WHERE allyfix.audit.id = '<audit id>' SINCE 1 week ago
```

### Logs in context

Every log line written inside a span carries `trace.id` and `span.id`, so in New
Relic a log opens onto its trace and a trace lists its logs. The worker ships its
logs over OTLP itself — it runs on a laptop where nothing collects stdout. The
web app's logs carry the same fields on stdout; to get them into New Relic, add
Vercel's **New Relic integration** (a log drain). Secrets are redacted before a
record leaves the process, by the same logic that guards stdout.

### Metrics

| Metric                             | Type      | Unit    | Attributes                                                                                     |
| ---------------------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------- |
| `allyfix.audit.duration`           | histogram | s       | `allyfix.audit.outcome` (`completed`, `failed`)                                                |
| `allyfix.audit.queue_wait`         | histogram | s       |                                                                                                |
| `allyfix.audit.recovered`          | counter   | {audit} | audits the reaper swept after a worker died                                                    |
| `allyfix.scan.duration`            | histogram | s       |                                                                                                |
| `allyfix.scan.issues`              | histogram | {issue} |                                                                                                |
| `allyfix.llm.rule_groups`          | counter   | {group} | `allyfix.llm.outcome` (`generated`, `cache_hit`, `failed`, `skipped`)                          |
| `allyfix.llm.cost`                 | counter   | USD     | `gen_ai.request.model` — only when a price is configured                                       |
| `gen_ai.client.token.usage`        | histogram | {token} | `gen_ai.token.type`, `gen_ai.provider.name`, `gen_ai.request.model`                            |
| `gen_ai.client.operation.duration` | histogram | s       | same, plus `error.type` on failure                                                             |
| `nodejs.eventloop.*`, `v8js.*`     | various   |         | Node runtime health                                                                            |
| `http.server.request.duration`     | histogram | s       | web app: `http.request.method`, `http.route`, `http.response.status_code`, `error.type` on 5xx |

### The APM Summary page

New Relic draws a service's **Summary** page (response time, throughput, error
rate) from metrics, not spans:

- **`ally-fix-web`:** built from `http.server.request.duration`, which a span
  processor derives from each Next.js request span. A 5xx counts as an error and
  a 4xx does not, since a rejected URL or a rate limit is the API working.
  Transactions are named by route, e.g. `WebTransaction/server/POST /api/audits`.
- **`ally-fix-worker`:** built from the consumer spans, so the Summary shows
  `OtherTransaction/consumer/process/audit-scan`. Switch the page's
  **Transaction type** filter from **Web** to **Other** (or **Non-web**) to see it.

Token usage counts **every attempt, including the ones whose answer was thrown
away** — they were billed. An unpriced model adds nothing to `allyfix.llm.cost`
rather than zero, so a sum never presents "unknown" as "free" (ADR-0008).

## Dashboard

[`docs/newrelic/dashboard.json`](./newrelic/dashboard.json) has three pages —
Pipeline, LLM, Web — built from the data above. The queries use account id `0`
as a placeholder; replace it with yours, then import it under **Dashboards →
Import dashboard**:

```bash
sed 's/"accountIds": \[0\]/"accountIds": [1234567]/' docs/newrelic/dashboard.json | pbcopy
```

## Suggested alerts

Create these as NRQL alert conditions (**Alerts → Alert conditions → New**). The
thresholds suit a demo; tune them to your traffic.

| Alert                  | NRQL                                                                                                                                                                            | Threshold           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| LLM provider down      | `SELECT sum(allyfix.llm.rule_groups) FROM Metric WHERE service.name = 'ally-fix-worker' AND allyfix.llm.outcome = 'skipped'`                                                    | > 0 for 5 min       |
| Audits failing         | `SELECT filter(count(allyfix.audit.duration), WHERE allyfix.audit.outcome = 'failed') / count(allyfix.audit.duration) * 100 FROM Metric WHERE service.name = 'ally-fix-worker'` | > 20 % for 15 min   |
| Worker died mid-scan   | `SELECT sum(allyfix.audit.recovered) FROM Metric WHERE service.name = 'ally-fix-worker'`                                                                                        | > 0 at least once   |
| Scan queue unavailable | `SELECT count(*) FROM Span WHERE service.name = 'ally-fix-web' AND name = 'publish audit-scan' AND otel.status_code = 'ERROR'`                                                  | > 0 for 5 min       |
| Spend running hot      | `SELECT sum(allyfix.llm.cost) FROM Metric WHERE service.name = 'ally-fix-worker'`                                                                                               | > your daily budget |

"LLM provider down" is the one the circuit breaker makes possible: groups are
only `skipped` when the breaker is open, so the alert fires on the provider being
unreachable rather than on any one bad answer.

## What is not instrumented

- **Postgres** — postgres.js has no OpenTelemetry instrumentation. DB time is
  inside the pipeline spans, not a span of its own.
- **Redis** — deliberately off: BullMQ's blocking poll would bury the pipeline
  under a stream of idle `BZPOPMIN` spans.
- **Web app logs over OTLP, and its other metrics** — the web app runs as
  serverless functions; it exports traces plus the one metric the Summary page
  needs, and its logs go through Vercel's log drain.

ADR-0009 has the reasoning behind each.
