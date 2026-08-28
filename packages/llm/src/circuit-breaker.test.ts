import { describe, expect, it, vi } from "vitest";
import { createCircuitBreaker, noopCircuitBreaker, type CircuitBreaker } from "./circuit-breaker";
import { CircuitOpenError, LlmProviderError, LlmValidationError } from "./errors";

function providerDown() {
  return new LlmProviderError("503 Service Unavailable", true, 503, undefined);
}

/**
 * Runs an operation the breaker is expected to refuse, and returns the refusal.
 * Fails loudly if the call went through, so a breaker that stopped refusing
 * cannot quietly pass these assertions.
 */
async function refusal(breaker: CircuitBreaker): Promise<CircuitOpenError> {
  try {
    await breaker.execute(async () => "should not run");
  } catch (error) {
    return error as CircuitOpenError;
  }
  throw new Error("expected the breaker to refuse the call, but it went through");
}

/** Mutable clock so `resetTimeoutMs` can be crossed without waiting. */
function clockAt(start = 0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

describe("createCircuitBreaker", () => {
  it("degrades to a no-op at a threshold of zero", () => {
    expect(createCircuitBreaker({ failureThreshold: 0, resetTimeoutMs: 1000 })).toBe(
      noopCircuitBreaker,
    );
  });

  it("passes calls through while closed", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("opens after the threshold of consecutive provider failures", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const operation = vi.fn(async () => {
      throw providerDown();
    });

    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(LlmProviderError);
    expect(breaker.state).toBe("closed");
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(LlmProviderError);
    expect(breaker.state).toBe("open");
  });

  it("rejects without calling the provider while open", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    const operation = vi.fn(async () => {
      throw providerDown();
    });

    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(LlmProviderError);
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    // Still one call: the second never reached the provider.
    expect(operation).toHaveBeenCalledOnce();
  });

  it("does not count failures that say nothing about provider health", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const badOutput = async () => {
      throw new LlmValidationError("missing fixCode", undefined);
    };

    // A model returning malformed JSON, over and over, is not an outage.
    for (let i = 0; i < 5; i++) {
      await expect(breaker.execute(badOutput)).rejects.toBeInstanceOf(LlmValidationError);
    }
    expect(breaker.state).toBe("closed");
  });

  it("resets the failure count on any success", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });

    await expect(
      breaker.execute(async () => {
        throw providerDown();
      }),
    ).rejects.toThrow();
    await breaker.execute(async () => "ok");
    await expect(
      breaker.execute(async () => {
        throw providerDown();
      }),
    ).rejects.toThrow();

    // Two failures total, but not consecutive — the circuit stays closed.
    expect(breaker.state).toBe("closed");
  });

  it("goes half-open after the reset timeout and closes on a successful probe", async () => {
    const clock = clockAt();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: clock.now,
    });

    await expect(
      breaker.execute(async () => {
        throw providerDown();
      }),
    ).rejects.toThrow();
    expect(breaker.state).toBe("open");

    clock.advance(1000);
    expect(breaker.state).toBe("half-open");

    await expect(breaker.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(breaker.state).toBe("closed");
  });

  it("re-opens when the probe fails, restarting the reset window", async () => {
    const clock = clockAt();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: clock.now,
    });
    const operation = vi.fn(async () => {
      throw providerDown();
    });

    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(LlmProviderError);
    clock.advance(1000);

    // The probe is allowed through and fails, so the circuit opens again...
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(LlmProviderError);
    expect(breaker.state).toBe("open");
    // ...and the very next caller is rejected without a call.
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("lets only one concurrent caller probe while half-open", async () => {
    const clock = clockAt();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: clock.now,
    });

    await expect(
      breaker.execute(async () => {
        throw providerDown();
      }),
    ).rejects.toThrow();
    clock.advance(1000);

    let releaseProbe: (value: string) => void = () => undefined;
    const probe = breaker.execute(() => new Promise<string>((resolve) => (releaseProbe = resolve)));
    // A second caller arriving while the probe is in flight must not pile on.
    await expect(breaker.execute(async () => "second")).rejects.toBeInstanceOf(CircuitOpenError);

    releaseProbe("probed");
    await expect(probe).resolves.toBe("probed");
    expect(breaker.state).toBe("closed");
  });

  it("says which refusal happened, and only promises a wait it can keep", async () => {
    const clock = clockAt();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: clock.now,
    });

    await expect(
      breaker.execute(async () => {
        throw providerDown();
      }),
    ).rejects.toThrow();

    // Open: the wait is knowable, so it is reported.
    clock.advance(400);
    const openError = await refusal(breaker);
    expect(openError.reason).toBe("open");
    expect(openError.retryAfterMs).toBe(600);
    expect(openError.message).toContain("is open");

    // Half-open with a probe already out: the wait depends on that probe, so
    // reporting a duration would be a guess. Previously this path computed a
    // value that always clamped to 0 and advertised an immediate retry.
    clock.advance(600);
    let release: (value: string) => void = () => undefined;
    const probe = breaker.execute(() => new Promise<string>((resolve) => (release = resolve)));

    const probeError = await refusal(breaker);
    expect(probeError.reason).toBe("probe-in-flight");
    expect(probeError.retryAfterMs).toBe(0);
    expect(probeError.message).toContain("probe is already in flight");
    expect(probeError.message).not.toContain("~0s");

    release("done");
    await probe;
  });

  it("counts an untyped error as a provider failure (fail closed)", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(
      breaker.execute(async () => {
        throw new TypeError("something unexpected");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(breaker.state).toBe("open");
  });
});
