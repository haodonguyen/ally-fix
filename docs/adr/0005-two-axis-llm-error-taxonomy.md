# ADR-0005: Classify LLM failures on two independent axes

## Status

Accepted — 2026-08-25

## Context

The LLM layer originally guarded itself with retry alone, driven by a single
predicate: `isRetryable(error)`. Adding a circuit breaker exposed that one boolean
cannot serve both consumers, because they are asking different questions:

- **The retry loop** asks: _would another attempt plausibly succeed?_
- **The circuit breaker** asks: _is the provider itself unhealthy?_

For most failures the answers agree, which is why one flag survived as long as it
did. They come apart in exactly the two cases that matter most:

| Failure                      | Retry worth it?                         | Provider unhealthy?                              |
| ---------------------------- | --------------------------------------- | ------------------------------------------------ |
| Model returns malformed JSON | **Yes** — sampling is non-deterministic | **No** — it answered fine, the content was wrong |
| API key is invalid (401)     | **No** — waiting fixes nothing          | **Yes** — every later call fails identically     |

Collapsing the axes forces a wrong answer in both directions. If a schema failure
counts as provider trouble, a chatty model takes the provider offline for every
other rule group. If a bad key does not count, we pay full retry cost on every
rule group in the audit to rediscover the same 401.

## Decision

Give every LLM failure two independent, explicit properties (`packages/llm/src/errors.ts`):

- `retryable` — consumed by the retry loop.
- `tripsBreaker` — consumed by the circuit breaker.

| Error                | `retryable`     | `tripsBreaker` |
| -------------------- | --------------- | -------------- |
| `LlmTimeoutError`    | yes             | yes            |
| `LlmValidationError` | yes             | **no**         |
| `LlmProviderError`   | per status code | yes            |
| `CircuitOpenError`   | no              | no             |
| `LlmAnalysisError`   | no              | no             |

The two `no / no` rows are deliberate, and for the same reason: neither is a
report about the provider. `CircuitOpenError` is the breaker's own output, and
`LlmAnalysisError` is the wrapper thrown once every attempt is spent — the real
classification is on its `cause`.

Both are declared `abstract readonly` on the `LlmError` base, so adding a variant
without answering both questions is a compile error rather than an omission.

## Alternatives considered

**Keep one `isRetryable` and let the breaker count every failure.** Rejected: a
model that is bad at JSON would open the circuit and suppress analysis for the
entire audit, even though the provider is healthy.

**Keep one flag and have the breaker inspect error types itself.** Rejected: it
puts the same classification logic in two places, where it can drift.

**A single enum of failure kinds** (`TIMEOUT | VALIDATION | RATE_LIMIT | ...`) with
consumers switching on it. Reasonable, and arguably simpler to read. Rejected
because every new consumer must then handle every kind exhaustively, and the two
questions above are the only ones anyone actually asks. Two booleans state the
contract directly instead of encoding it in switch statements.

## Consequences

**Good**

- Malformed output is retried without ever taking the provider offline.
- A bad key opens the circuit immediately, so the rest of the audit fails fast
  instead of paying the full retry budget per rule group.
- Adding a failure mode is a guided exercise: the type system asks both questions.

**Bad**

- More surface than one helper function: a base class and five subclasses where
  there used to be a predicate.
- Two booleans is not obviously the right number. A future need — "should this be
  reported to the user?", "does this count toward a quota?" — would mean either a
  third axis or admitting the enum alternative was right after all.
- Callers must remember that the client wraps the last failure in
  `LlmAnalysisError`, so the interesting classification is on `.cause`. `analyze.ts`
  has a small helper for this precisely because it is easy to get wrong.

## See also

- [ADR-0001](./0001-schema-validated-llm-output.md) — why malformed output is a
  routine, expected failure rather than an exceptional one.
- [ADR-0004](./0004-llm-analysis-is-best-effort.md) — what happens once this layer
  has exhausted its options.
