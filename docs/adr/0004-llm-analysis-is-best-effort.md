# ADR-0004: LLM analysis is best-effort and must never fail a scan

## Status

Accepted — 2026-07

## Context

A scan produces two kinds of value:

1. **The axe results** — the issues, their severity, their WCAG criteria, the
   score. Deterministic, produced locally, and complete on their own.
2. **The LLM analysis** — the explanation, affected users, and code fix. Valuable,
   but produced by a third-party service that can be slow, rate-limited, down, or
   simply not configured.

The naive pipeline runs them in sequence and treats the whole thing as one
transaction: scan, analyse, save, mark complete. Any failure fails the audit.

That couples the reliable half to the unreliable half. A user whose scan found 82
real issues would see "scan failed" because a free-tier quota was exhausted — and
the 82 issues, already computed, would be thrown away. The failure would also be
misattributed: nothing about _their page_ failed.

There is also a configuration case that is not a failure at all. The default
provider is a local Ollama. A user who has not installed Ollama should still get a
working accessibility report, because that is the part that does not need an LLM.

## Decision

Persist the raw issues **before** the first LLM call, and treat analysis as an
enrichment pass that can partially or entirely fail:

- `insertIssues` writes every issue to Postgres immediately after the scan.
- `analyzeAudit` then fills in `llm_analysis` per rule group. It catches per-group
  failures, counts them, logs them, and **never rethrows**.
- The audit is marked `completed` with its score regardless of how the analysis
  went. `llm_analysis` stays `null` for groups that failed.
- The UI renders an issue with or without an analysis.

Analysis is therefore a property of an issue, not a phase of the audit.

## Alternatives considered

**Fail the audit on LLM failure.** Rejected: discards work that already succeeded
and blames the user's page for our dependency's outage.

**Retry the whole audit.** Rejected: re-running Playwright to recover an LLM call
is enormously wasteful, and the scan result would be identical.

**Queue a separate analysis job per audit.** Reasonable, and a better design at
larger scale — a failed analysis could be retried independently without touching
the scan. Rejected for now as more moving parts than this project needs; the Redis
cache already means a re-run is cheap.

## Consequences

**Good**

- A missing or broken LLM provider degrades the report instead of destroying it.
- Self-hosting works with zero configuration: no key, no Ollama, still a usable
  audit.
- The expensive, slow half of the pipeline can fail without any user-visible
  error state.

**Bad**

- **Partial results are a real state the UI must handle.** Some issues have an
  explanation and some do not, within one report. Every consumer of
  `llm_analysis` has to treat `null` as normal, not exceptional.
- Failures are quiet by design. A provider that has been down for a week produces
  reports that look fine and are simply less useful — the signal is a log line and
  the `failed`/`skipped` counters, not an alert.
- "Completed" no longer means "fully analysed", which is a subtlety anyone reading
  the status column has to know.

## See also

- [ADR-0005](./0005-two-axis-llm-error-taxonomy.md) — how failures are classified
  before this layer decides to give up on them.
