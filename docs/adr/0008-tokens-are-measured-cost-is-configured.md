# ADR-0008: Tokens are measured, cost is configured

## Status

Accepted — 2026-08-29

## Context

[ADR-0006](./0006-structured-logging.md) made a scan traceable: which audit, how
long each stage took, what failed. It did not make one answerable question
answerable — **what did that scan cost?** Nothing in the pipeline recorded a
token count, so every question downstream of it was unanswerable too. Is the
local model cheaper than the hosted one at the same quality? Is the Redis cache
earning its complexity? Did [ADR-0007](./0007-ground-prompts-in-wcag.md)'s
reference block pay for the tokens it added?

That last one is the sharp edge. Grounding was shipped with a comparison harness
that measures whether it _helps_, and no way at all to measure what it _costs_.
A one-sided measurement is how a change gets adopted on the half of the trade
that flatters it.

The provider already returns usage on every call. Two decisions were in the way.

**The retry loop hides spend.** A group that failed schema validation twice and
parsed on the third attempt was billed three times. The obvious implementation —
report the usage of the call that succeeded — undercounts by exactly the amount
that grows when things are going wrong.

**Cost is not a measurement.** Tokens come from the provider and are exact.
Dollars require a rate, and a rate is not a property of the code: prices change,
they differ per account (free tier, committed use, promotional credits), and a
table checked into a repository goes stale much faster than anyone updates it.

## Decision

Report **tokens as measurement and cost as configuration**, and never let one
stand in for the other.

**Usage accumulates across attempts, including failed ones.** `analyzeIssueGroup`
returns tokens for every attempt it made, and `LlmAnalysisError` carries the
tokens of the attempts that produced nothing. A provider having a bad day now
costs visibly more than one working perfectly, which is the entire point.

**The rate comes from the environment.** `LLM_PRICE_INPUT_PER_MTOK` and
`LLM_PRICE_OUTPUT_PER_MTOK`, both or neither — one alone would silently cost the
other side of every call at zero. Unset means costs are reported as `null`,
alongside exact token counts.

**Null is never rendered as zero.** This is the load-bearing rule and it holds at
every layer:

- A provider that reports no usage yields `null`, not a zero-token call that
  would average the fleet's cost down.
- An unpriced model yields a `null` cost, not `$0.00`.
- The eval prints `no rate configured`, never `$0.0000`, when it has no rate.
- Reasoning tokens are reported but not billed again — providers count them
  _inside_ `outputTokens`, so adding them would double-charge every reasoning
  model.

**Ollama is priced at zero, and that is a measurement.** A local model bills
nothing per token. The electricity is real but it is not a per-token charge
anyone can invoice, so zero there is a fact rather than a default — which is why
it lives in the LLM layer, where "this provider is local" is known, rather than
in the operator's environment.

**Cache hits are counted next to tokens.** A hit costs nothing, so the summary
can say how much the cache saved instead of merely that it was used.

**`eval:compare` prints input tokens per call alongside the resolved-rate delta.**
The question about a prompt change is never "did it help?" but "did it help
enough to be worth what it costs?", so both numbers appear together or the
report is only half of an answer.

## Alternatives considered

**Ship a price table in the repo.** The obvious approach, and it works on the day
it is written. Rejected because it degrades silently: nothing in the build fails
when a provider changes its pricing, so the dashboard keeps producing confident
numbers that are quietly wrong — and a wrong cost is worse than a missing one,
because it gets acted on. The same reasoning that refused invented WCAG citations
in ADR-0007 applies to invented prices.

**Count tokens ourselves with a tokenizer (`tiktoken` or similar).** Rejected:
it means shipping a tokenizer per model family, keeping them in sync with three
providers, and still being wrong — the provider's own count is what it bills on,
including overheads a client-side count never sees. The authoritative number is
already in the response.

**Report only the successful attempt's usage.** Simpler, and wrong in the
direction that matters. Retries are how this system responds to trouble; a cost
metric blind to them is at its least accurate exactly when someone is looking at
it because the bill jumped.

**Persist per-audit cost to Postgres and show it in the UI.** Tempting, and
rejected for now as scope. Cost is operator data, not user data — it belongs in
a log line an operator can aggregate, not on a public accessibility report. If
the hosted demo ever needs per-user quotas, that is when it earns a column.

**A `usage` callback on the client instead of a return value.** Rejected: the
client is shared across audits so a global callback cannot attribute spend to
one, and a side channel is easy to forget to wire up. Returning usage with the
result makes it impossible to ignore.

## Consequences

**Good**

- "What did this scan cost?" is answerable, and so are the questions built on it:
  cache savings, provider comparison, the price of a prompt change.
- Retries and outright failures are visible in the cost, not hidden by it.
- An unpriced deployment still gets exact token counts — the useful half of the
  telemetry needs no configuration at all.
- The worker says at startup whether pricing is configured, so an operator finds
  out then rather than after a month of null costs.

**Bad**

- **Cost is null out of the box for hosted providers.** That is deliberate, but
  it means the feature looks half-finished until someone reads the docs and sets
  two variables. An honest gap still reads as a gap.
- The rate an operator types is unverified. Nothing checks it against the
  provider's real pricing, so a typo produces a confidently wrong number — the
  failure this ADR avoids for _stale_ prices, reintroduced for _mistyped_ ones.
- `SingleShotGenerate` and `analyzeIssueGroup` both changed shape, so every test
  double had to be updated. The seam is more honest and more verbose.
- Every cost number is an estimate. It ignores request overheads, minimum
  billing units, and prompt caching discounts that some providers apply.

## See also

- [ADR-0006](./0006-structured-logging.md) — the log records these fields join.
- [ADR-0007](./0007-ground-prompts-in-wcag.md) — the change whose price this was
  built to measure.
