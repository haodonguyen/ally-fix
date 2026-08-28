# ADR-0001: Validate LLM output against a schema instead of accepting free-form text

## Status

Accepted — 2026-07

## Context

The product's value is not "we found 82 issues" — scanners already do that. It is
that each issue arrives with an explanation, the affected user groups, a code fix,
and a priority. The dashboard renders those four fields into distinct UI: prose in
a paragraph, users as a list, the fix in a copy-to-clipboard code block, the
priority as a sort key.

That means the LLM's answer is not text we display — it is **data we destructure**.
A model that returns a helpful paragraph instead of the four fields is useless to
the renderer even when it is factually correct.

An LLM has no obligation to honour any output contract. It can return prose, JSON
wrapped in a markdown fence, JSON with the right keys and wrong types, or an
apology. Whatever we do, some responses will not fit.

## Decision

Define the contract once as a Zod schema (`llmIssueAnalysisSchema` in
`@ally-fix/shared`) and use it in three places:

1. Passed to the AI SDK's `generateObject` as the requested output schema, so the
   provider constrains generation where it can.
2. Re-validated with `safeParse` on the way back, because a provider promising
   structured output is not proof it delivered it.
3. Re-validated again when reading a cached entry, so a payload written by an
   older schema version cannot poison a later run.

A validation failure is a retry, not a crash. TypeScript types are inferred from
the same schema, so the runtime check and the compile-time type cannot drift.

## Alternatives considered

**Free-form text parsed with regex or string splitting.** Rejected: it moves the
contract into fragile parsing code that has to be updated every time a model
phrases things differently, and it fails silently — a bad parse produces a
plausible-looking wrong field rather than an error.

**JSON mode without a schema.** Rejected: it guarantees the response parses as
JSON, not that it has our fields with our types. `{"answer": "..."}` is valid JSON
and useless to us.

**Trusting the SDK's structured output alone, without re-validating.** Rejected:
the guarantee is only as good as the provider's implementation, and we support
three providers including a local Ollama running arbitrary models.

## Consequences

**Good**

- A malformed answer is caught at the boundary and retried, so it can never reach
  the database or the renderer.
- One schema is the single source of truth for the API contract, the DB column
  type, and the prompt's instructions.
- Failures are legible: the error says which field was wrong, not "undefined is
  not an object" three layers away in a React component.

**Bad**

- **It constrains which models we can use.** This was not theoretical: Groq's
  `llama-3.3-70b-versatile` rejects the AI SDK's `json_schema` response format
  outright, which forced the default `GROQ_MODEL` to `openai/gpt-oss-20b`
  (commit `b7026f0`). Any future model must be checked for structured-output
  support before it can be a default.
- Retries cost tokens and latency. A model that is bad at following the schema is
  expensive in a way a free-form one is not.
- Small local models drift furthest from the contract — common enough that the
  client unwraps markdown-fenced JSON before validating, to avoid spending a
  retry on a response that was otherwise correct.

## See also

- [ADR-0004](./0004-llm-analysis-is-best-effort.md) — why a validation failure
  degrades the report instead of failing the scan.
- [ADR-0005](./0005-two-axis-llm-error-taxonomy.md) — why a validation failure is
  retried but never counts against the circuit breaker.
