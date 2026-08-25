import { CircuitOpenError, LlmError } from "./errors";

/**
 * Circuit breaker for the LLM provider.
 *
 * Retry alone makes an outage *worse*: one unreachable provider turns a 20-rule
 * audit into 20 x 4 attempts, each with backoff, so the worker spends minutes
 * hammering a dead endpoint before giving up on every group anyway. The breaker
 * lets the first few failures pay for that discovery, then fails the rest fast.
 *
 *   closed    → calls pass through; consecutive tripping failures are counted.
 *   open      → calls are rejected immediately with CircuitOpenError.
 *   half-open → after `resetTimeoutMs`, one probe is allowed through.
 *               It closes the circuit on success, re-opens it on failure.
 *
 * Only failures with `tripsBreaker` count (see errors.ts): a model returning
 * malformed JSON is not evidence that the provider is down.
 */
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive tripping failures before the circuit opens. 0 disables the breaker. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a probe. */
  resetTimeoutMs: number;
  /** Injectable clock, so tests don't wait in real time. */
  now?: () => number;
}

export interface CircuitBreaker {
  execute<T>(operation: () => Promise<T>): Promise<T>;
  readonly state: CircuitState;
}

/** A breaker that never opens. Used when the feature is disabled. */
export const noopCircuitBreaker: CircuitBreaker = {
  execute: (operation) => operation(),
  get state(): CircuitState {
    return "closed";
  },
};

export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const { failureThreshold, resetTimeoutMs } = options;
  if (!Number.isFinite(failureThreshold) || failureThreshold <= 0) return noopCircuitBreaker;

  const now = options.now ?? Date.now;

  let failures = 0;
  let openedAt = 0;
  // Set while a half-open probe is in flight, so concurrent callers don't all
  // probe a provider we already suspect is down.
  let probing = false;

  function currentState(): CircuitState {
    if (failures < failureThreshold) return "closed";
    return now() - openedAt >= resetTimeoutMs ? "half-open" : "open";
  }

  return {
    get state(): CircuitState {
      return currentState();
    },

    async execute<T>(operation: () => Promise<T>): Promise<T> {
      const state = currentState();

      if (state === "open" || (state === "half-open" && probing)) {
        throw new CircuitOpenError(Math.max(0, resetTimeoutMs - (now() - openedAt)));
      }

      const isProbe = state === "half-open";
      if (isProbe) probing = true;

      try {
        const result = await operation();
        // Any success resets the count — including a probe, which closes the circuit.
        failures = 0;
        return result;
      } catch (error) {
        // A failure that says nothing about provider health leaves the circuit
        // untouched, but a failed probe must re-open it rather than let the next
        // caller straight through.
        const counts = !(error instanceof LlmError) || error.tripsBreaker;
        if (counts) {
          failures = isProbe ? failureThreshold : failures + 1;
          if (failures >= failureThreshold) openedAt = now();
        } else if (isProbe) {
          // The probe proved the provider is reachable; treat it as a success
          // for health purposes and let the caller handle the output problem.
          failures = 0;
        }
        throw error;
      } finally {
        if (isProbe) probing = false;
      }
    },
  };
}
