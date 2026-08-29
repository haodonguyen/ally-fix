/**
 * Error taxonomy for the LLM layer.
 *
 * The retry loop and the circuit breaker need to answer two *different*
 * questions about a failure, and one boolean can't carry both:
 *
 *   1. "Is another attempt worth it?"        → `retryable`
 *   2. "Is the provider itself unhealthy?"   → `tripsBreaker`
 *
 * They come apart in the case that matters most: a model returning malformed
 * JSON is worth retrying (the next sample may parse) but says nothing about the
 * provider's health, so it must not open the breaker. Conversely a bad API key
 * is not worth retrying but *is* a reason to stop calling the provider at all.
 */
import type { TokenUsage } from "./usage";

/** Base class so callers can `instanceof LlmError` without knowing the variants. */
export abstract class LlmError extends Error {
  /** Whether another attempt of the same request could plausibly succeed. */
  abstract readonly retryable: boolean;
  /** Whether this failure is evidence the provider is unhealthy. */
  abstract readonly tripsBreaker: boolean;
}

/** The request exceeded its deadline and was aborted client-side. */
export class LlmTimeoutError extends LlmError {
  readonly retryable = true;
  readonly tripsBreaker = true;

  constructor(readonly timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LlmTimeoutError";
  }
}

/**
 * The provider answered, but the payload did not match `llmIssueAnalysisSchema`.
 * Retryable (sampling is non-deterministic) but never breaker-tripping: the
 * provider is up, it's the model's output that is wrong.
 */
export class LlmValidationError extends LlmError {
  readonly retryable = true;
  readonly tripsBreaker = false;

  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(`LLM output failed schema validation: ${message}`);
    this.name = "LlmValidationError";
  }
}

/**
 * The provider itself failed — network error, 5xx, 429, or a client error such
 * as a bad key. `retryable` follows the classification in `classifyProviderError`;
 * either way it counts against the breaker, because every subsequent call will
 * hit the same wall.
 */
export class LlmProviderError extends LlmError {
  readonly tripsBreaker = true;

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number | undefined,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/**
 * Why the breaker refused a call. The two cases have genuinely different
 * answers to "when may I try again?", so they are not collapsed: an open circuit
 * knows the wait, whereas a half-open circuit with a probe already in flight
 * cannot know until that probe resolves.
 */
export type CircuitOpenReason = "open" | "probe-in-flight";

/**
 * The circuit breaker rejected the request without touching the provider. Not
 * retryable (the breaker decides when to try again) and it does not count as a
 * failure — it *is* the breaker's own output.
 */
export class CircuitOpenError extends LlmError {
  readonly retryable = false;
  readonly tripsBreaker = false;

  /** Milliseconds until the next probe window. Meaningful only when reason is "open". */
  readonly retryAfterMs: number;

  constructor(
    readonly reason: CircuitOpenReason,
    retryAfterMs = 0,
  ) {
    super(
      reason === "probe-in-flight"
        ? "LLM circuit breaker is half-open and a probe is already in flight; skipping the call"
        : `LLM circuit breaker is open; skipping the call (retrying in ~${Math.ceil(retryAfterMs / 1000)}s)`,
    );
    this.retryAfterMs = reason === "open" ? retryAfterMs : 0;
    this.name = "CircuitOpenError";
  }
}

/** Every attempt was used up. Carries the last underlying failure as `cause`. */
export class LlmAnalysisError extends LlmError {
  readonly retryable = false;
  readonly tripsBreaker = false;

  constructor(
    readonly attempts: number,
    override readonly cause: unknown,
    /**
     * Tokens the failed attempts still consumed. A group that failed after four
     * tries was billed for four calls; dropping that on the floor understates
     * cost exactly when something is going wrong and the bill is climbing.
     */
    readonly usage: TokenUsage | null = null,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`LLM analysis failed after ${attempts} attempt(s): ${reason}`);
    this.name = "LlmAnalysisError";
  }
}

/**
 * Turns an unknown thrown value from the AI SDK into a typed `LlmProviderError`.
 *
 * A client error (4xx other than 429 — bad key, unknown model, malformed
 * request) can't succeed on retry, so we stop early. Rate limits (429) and
 * everything else are retryable.
 */
export function classifyProviderError(error: unknown): LlmProviderError {
  const message = error instanceof Error ? error.message : String(error);

  if (error && typeof error === "object") {
    const err = error as { isRetryable?: unknown; statusCode?: unknown };
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : undefined;

    // Honor the SDK's explicit signal first — it knows 408/409/425/5xx are worth a retry.
    if (typeof err.isRetryable === "boolean") {
      return new LlmProviderError(message, err.isRetryable, statusCode, error);
    }
    // No explicit flag: a non-429 client error (4xx) can't succeed on retry.
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      return new LlmProviderError(message, false, statusCode, error);
    }
    return new LlmProviderError(message, true, statusCode, error);
  }

  return new LlmProviderError(message, true, undefined, error);
}
