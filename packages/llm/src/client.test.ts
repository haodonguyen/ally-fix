import { describe, expect, it, vi } from "vitest";
import { backoffDelay, coerceRawOutput, createLlmClient } from "./client";
import { createCircuitBreaker } from "./circuit-breaker";
import { CircuitOpenError, LlmProviderError, LlmTimeoutError, LlmValidationError } from "./errors";
import type { SingleShotGenerate } from "./client";
import type { Throttle } from "./throttle";
import type { LlmConfig } from "./types";

const config: LlmConfig = { provider: "ollama", model: "test-model" };

const validAnalysis = {
  explanation: "Images need alternative text.",
  affectedUsers: ["screen reader users"],
  fixCode: '<img src="a.png" alt="A cat">',
  priority: "high",
};

const group = { ruleId: "image-alt", htmlSnippets: ["<img>"] };

/** Defaults that keep the suite instant: no backoff waits, breaker out of the way. */
const fast = { retryDelayMs: 0, circuitBreakerThreshold: 0 } as const;

describe("createLlmClient.analyzeIssueGroup", () => {
  it("returns a schema-validated analysis on the first try", async () => {
    const generate = vi.fn().mockResolvedValue(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate });

    const result = await client.analyzeIssueGroup(group);

    expect(result.priority).toBe("high");
    expect(result.affectedUsers).toEqual(["screen reader users"]);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("passes the rule's prompt and an abort signal to the provider", async () => {
    const generate = vi.fn().mockResolvedValue(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate });

    await client.analyzeIssueGroup(group);

    const args = generate.mock.calls[0]?.[0];
    expect(args.prompt).toContain("image-alt");
    expect(args.system).toContain("accessibility expert");
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries when the model returns something that fails the schema", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ not: "valid" })
      .mockResolvedValueOnce(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 2 });

    const result = await client.analyzeIssueGroup(group);

    expect(result.explanation).toContain("alternative text");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries, reporting the real attempt count", async () => {
    const generate = vi.fn().mockResolvedValue({ still: "invalid" });
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 1 });

    await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/failed after 2 attempt/);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error the provider marks non-retryable", async () => {
    const authError = Object.assign(new Error("Unauthorized"), { isRetryable: false });
    const generate = vi.fn().mockRejectedValue(authError);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 3 });

    await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/failed after 1 attempt/);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not retry a non-429 client error (4xx)", async () => {
    const badRequest = Object.assign(new Error("Bad Request"), { statusCode: 400 });
    const generate = vi.fn().mockRejectedValue(badRequest);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 3 });

    await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/failed after/);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("retries a 4xx the SDK marks retryable (e.g. 408 timeout)", async () => {
    const timeout = Object.assign(new Error("Request Timeout"), {
      statusCode: 408,
      isRetryable: true,
    });
    const generate = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 3 });

    await client.analyzeIssueGroup(group);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 rate limit", async () => {
    const rateLimited = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    const generate = vi
      .fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 3 });

    const result = await client.analyzeIssueGroup(group);

    expect(result.priority).toBe("high");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("surfaces the underlying failure as the final error's cause", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 0 });

    await expect(client.analyzeIssueGroup(group)).rejects.toMatchObject({
      name: "LlmAnalysisError",
      cause: expect.any(LlmProviderError),
    });
  });
});

describe("schema validation of the model's output", () => {
  /** Runs one bad payload through the client with retries off. */
  async function reject(raw: unknown) {
    const generate = vi.fn().mockResolvedValue(raw);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 0 });
    return client.analyzeIssueGroup(group).catch((error: unknown) => error);
  }

  it.each([
    ["an empty affectedUsers array", { ...validAnalysis, affectedUsers: [] }],
    ["an empty string inside affectedUsers", { ...validAnalysis, affectedUsers: [""] }],
    ["an empty explanation", { ...validAnalysis, explanation: "" }],
    ["an empty fixCode", { ...validAnalysis, fixCode: "" }],
    ["a priority outside the enum", { ...validAnalysis, priority: "urgent" }],
    ["a missing field", { explanation: "x", affectedUsers: ["y"], fixCode: "z" }],
    ["affectedUsers as a bare string", { ...validAnalysis, affectedUsers: "screen readers" }],
    ["null", null],
    ["an array", [validAnalysis]],
    ["prose instead of an object", "Sure! Here is the fix you asked for."],
  ])("rejects %s", async (_label, raw) => {
    const error = await reject(raw);
    expect(error).toMatchObject({ name: "LlmAnalysisError" });
    expect((error as { cause: unknown }).cause).toBeInstanceOf(LlmValidationError);
  });

  it("accepts a valid object and strips unknown extra fields", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ ...validAnalysis, confidence: 0.9, notes: "ignore me" });
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 0 });

    const result = await client.analyzeIssueGroup(group);

    expect(result).toEqual(validAnalysis);
    expect(result).not.toHaveProperty("confidence");
  });

  it("recovers JSON a local model wrapped in a markdown fence", async () => {
    const fenced = "```json\n" + JSON.stringify(validAnalysis) + "\n```";
    const generate = vi.fn().mockResolvedValue(fenced);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 0 });

    await expect(client.analyzeIssueGroup(group)).resolves.toEqual(validAnalysis);
    // One call: the unwrap saved a retry rather than burning an attempt.
    expect(generate).toHaveBeenCalledOnce();
  });
});

describe("coerceRawOutput", () => {
  it("passes objects through untouched", () => {
    const object = { a: 1 };
    expect(coerceRawOutput(object)).toBe(object);
  });

  it("unwraps fenced and bare JSON strings", () => {
    expect(coerceRawOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(coerceRawOutput('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(coerceRawOutput('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns the original string when it is not JSON, so the error stays honest", () => {
    expect(coerceRawOutput("I cannot help with that.")).toBe("I cannot help with that.");
  });
});

describe("per-attempt timeout", () => {
  it("aborts a request that never settles and reports it as a timeout", async () => {
    // A provider that ignores the abort signal entirely — the deadline must
    // still fire, or a hung socket would stall the worker forever.
    const generate = vi.fn(() => new Promise(() => undefined));
    const client = createLlmClient(config, {
      ...fast,
      generate,
      timeoutMs: 10,
      maxRetries: 0,
    });

    const error = await client.analyzeIssueGroup(group).catch((e: unknown) => e);
    expect((error as { cause: unknown }).cause).toBeInstanceOf(LlmTimeoutError);
  });

  it("signals the abort so a well-behaved provider can cancel in flight", async () => {
    let aborted = false;
    const generate = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, rejectPromise) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            rejectPromise(
              Object.assign(new Error("The operation was aborted."), {
                name: "AbortError",
              }),
            );
          });
        }),
    );
    const client = createLlmClient(config, { ...fast, generate, timeoutMs: 10, maxRetries: 0 });

    const error = await client.analyzeIssueGroup(group).catch((e: unknown) => e);

    expect(aborted).toBe(true);
    // The provider's own AbortError is reported as our timeout, not a provider fault.
    expect((error as { cause: unknown }).cause).toBeInstanceOf(LlmTimeoutError);
  });

  it("retries after a timeout and can still succeed", async () => {
    const generate = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate, timeoutMs: 10, maxRetries: 1 });

    await expect(client.analyzeIssueGroup(group)).resolves.toEqual(validAnalysis);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("clears the deadline timer when the provider throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      // A `generate` that throws instead of returning a rejected promise. If the
      // call sits outside withTimeout's try block, `finally` never runs and this
      // 30s timer stays armed for the life of the process.
      const generate = (() => {
        throw new Error("bad argument");
      }) as unknown as SingleShotGenerate;
      const client = createLlmClient(config, {
        ...fast,
        generate,
        timeoutMs: 30_000,
        maxRetries: 0,
      });

      await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/failed after 1 attempt/);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a synchronous throw as a provider error, not a crash", async () => {
    const generate = (() => {
      throw new Error("bad argument");
    }) as unknown as SingleShotGenerate;
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 0 });

    await expect(client.analyzeIssueGroup(group)).rejects.toMatchObject({
      cause: expect.any(LlmProviderError),
    });
  });

  it("does not arm a deadline when the timeout is disabled", async () => {
    const generate = vi.fn().mockResolvedValue(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate, timeoutMs: 0 });

    await expect(client.analyzeIssueGroup(group)).resolves.toEqual(validAnalysis);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially", () => {
    const random = () => 1;
    expect(backoffDelay(0, 800, 20_000, random)).toBe(800);
    expect(backoffDelay(1, 800, 20_000, random)).toBe(1600);
    expect(backoffDelay(2, 800, 20_000, random)).toBe(3200);
  });

  it("caps the ceiling so a long retry chain can't wait for minutes", () => {
    expect(backoffDelay(10, 800, 20_000, () => 1)).toBe(20_000);
  });

  it("applies full jitter: the wait is a random point below the ceiling", () => {
    // Same attempt, different rolls — this is what stops concurrent workers from
    // retrying in lockstep and re-creating the burst that rate-limited them.
    expect(backoffDelay(1, 800, 20_000, () => 0)).toBe(0);
    expect(backoffDelay(1, 800, 20_000, () => 0.5)).toBe(800);
    expect(backoffDelay(1, 800, 20_000, () => 0.99)).toBe(1584);
  });

  it("stays at zero when backoff is disabled", () => {
    expect(backoffDelay(3, 0, 20_000, () => 1)).toBe(0);
  });
});

describe("outbound rate limiting", () => {
  it("takes a token before every attempt, retries included", async () => {
    const acquire = vi.fn(async () => undefined);
    const throttle: Throttle = { acquire };
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ bad: true })
      .mockResolvedValueOnce({ bad: true })
      .mockResolvedValueOnce(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate, throttle, maxRetries: 2 });

    await client.analyzeIssueGroup(group);

    // A retry is a request too — it must count against the rate limit.
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("builds a real bucket from requestsPerMinute without any provider call", async () => {
    const generate = vi.fn().mockResolvedValue(validAnalysis);
    const client = createLlmClient(config, { ...fast, generate, requestsPerMinute: 600 });

    await expect(client.analyzeIssueGroup(group)).resolves.toEqual(validAnalysis);
  });
});

describe("circuit breaker integration", () => {
  it("stops calling a dead provider once the circuit opens", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const client = createLlmClient(config, {
      generate,
      retryDelayMs: 0,
      circuitBreaker: breaker,
      maxRetries: 3,
    });

    // First group: two attempts land, the second opens the circuit, and the
    // remaining retries are refused without a call.
    await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/failed after/);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(breaker.state).toBe("open");

    // Every later group now fails instantly instead of burning four attempts each.
    await expect(
      client.analyzeIssueGroup({ ruleId: "label", htmlSnippets: ["<input>"] }),
    ).rejects.toMatchObject({ cause: expect.any(CircuitOpenError) });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("keeps the circuit closed when only the model's output is bad", async () => {
    const generate = vi.fn().mockResolvedValue({ garbage: true });
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const client = createLlmClient(config, {
      generate,
      retryDelayMs: 0,
      circuitBreaker: breaker,
      maxRetries: 3,
    });

    await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/failed after 4 attempt/);
    // The provider answered every time — it is healthy, just unhelpful.
    expect(breaker.state).toBe("closed");
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("recovers once the provider comes back", async () => {
    let t = 0;
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(validAnalysis);
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => t,
    });
    const client = createLlmClient(config, {
      generate,
      retryDelayMs: 0,
      circuitBreaker: breaker,
      maxRetries: 0,
    });

    await expect(client.analyzeIssueGroup(group)).rejects.toThrow();
    expect(breaker.state).toBe("open");

    t += 1000; // the reset window elapses
    await expect(client.analyzeIssueGroup(group)).resolves.toEqual(validAnalysis);
    expect(breaker.state).toBe("closed");
  });
});
