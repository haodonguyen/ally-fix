# ADR-0006: Log structured records, with a hand-written logger

## Status

Accepted — 2026-08-29

## Context

Every log line in the project was a sentence:

```ts
console.log(`[worker] audit ${auditId}: analysed ${n} rule group(s), ${f} failed`);
```

That is readable by a person watching a terminal and useless to anything else.
It cannot answer the only question anyone actually asks of production logs —
**"what happened to _this_ audit?"** — because there is no field to filter on,
only prose to grep, and the prose changes whenever someone edits the string.

It also loses things silently. `console.error("failed:", error)` renders an
`Error` differently depending on the transport, and `JSON.stringify(error)` is
`"{}"`: the failure vanishes entirely if anything downstream serializes it.

The worker is the component that most needs this. It runs somewhere nobody is
watching, its work is long-running and asynchronous, and a scan touches four
subsystems (browser, database, queue, LLM provider) any of which can be the one
that went wrong.

## Decision

Log **records, not sentences**: a level, a stable message, and typed fields.

- `logger.child({ auditId })` returns a logger that stamps that field onto every
  line it and its children write. The audit id is the correlation key, so one
  scan can be traced end to end by filtering a single field.
- `Error` values are serialized explicitly — name, message, stack, and the whole
  `cause` chain — because the default is to lose them.
- Values under secret-looking keys (`/key|token|secret|password|auth|credential/i`)
  are dropped, and credentials embedded in connection strings
  (`redis://user:pass@host`) are scrubbed out of every string, including stack
  traces. The host survives; the password does not.
- JSON for a collector, aligned text for a terminal, chosen by `NODE_ENV` and
  overridable with `LOG_FORMAT` / `LOG_LEVEL`.

The implementation is ~150 lines in `@ally-fix/shared/logger`, a Node-only
subpath so it never reaches the browser bundle.

## Alternatives considered

**Pino.** The obvious choice, and a better library than what is here: faster,
battle-tested, with an ecosystem of transports. Rejected for this project
because the requirement is "JSON lines to stdout with inherited context", which
is genuinely ~150 lines; pino plus `pino-pretty` for development adds two
dependencies and a transport-worker model to reason about, in exchange for
throughput this workload will never approach. **If this project grew a real
operational surface — sampling, redaction paths, multiple sinks — that trade
flips and pino is the right answer.**

**Winston.** Rejected: heavier again, and its formatter pipeline is more
configuration than this needs.

**Keep `console.*` and parse the prose in the collector.** Rejected: it moves
the schema into a set of regexes that break whenever anyone rewords a message,
and no one updates a log parser when they edit a string.

**OpenTelemetry traces instead of logs.** The right long-term answer for
following a scan across services, and complementary rather than competing.
Rejected for now as a much larger commitment (collector, exporter, backend) than
the current single-worker deployment can justify.

## Consequences

**Good**

- One scan is traceable end to end by filtering `auditId`, without knowing how
  any message is worded.
- Durations are recorded per stage (`scanMs`, `analysisMs`, `totalMs`), so
  "slow" becomes a number attached to a phase instead of a feeling.
- Secrets cannot reach the logs through a field or a stack trace, which matters
  because provider keys and connection strings are routinely in scope where
  errors are thrown.
- The logs are now testable, and they are tested: the suite asserts what a
  failing scan would actually say.

**Bad**

- **It is a dependency we own.** A bug in it is ours to fix, and it has no
  users outside this repo to have found the bugs first. The mitigation is that
  it is small and directly tested, not that it is correct by construction.
- No transports, no sampling, no rotation, no async flush. Anything beyond
  "write a line to stdout" means adopting pino after all.
- Every log call site is now longer than a template string, and there is a new
  judgement to make on each one: which fields belong on the record.
- Message strings become an interface. Renaming `"audit completed"` breaks any
  dashboard filtering on it — the same coupling prose had, now merely explicit.

## See also

- [ADR-0004](./0004-llm-analysis-is-best-effort.md) — failures here are quiet by
  design, which is exactly why they have to be visible in the logs.
