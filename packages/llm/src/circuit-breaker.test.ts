import { describe, expect, it, vi } from "vitest";
import { createCircuitBreaker, noopCircuitBreaker } from "./circuit-breaker";
import { CircuitOpenError, LlmProviderError, LlmValidationError } from "./errors";

function providerDown() {
  return new LlmProviderError("503 Service Unavailable", true, 503, undefined);
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
