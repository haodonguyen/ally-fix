import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { captureMetrics, captureSpans } from "@ally-fix/telemetry/testing";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitBreaker } from "./circuit-breaker";
import { genAiProviderName, createLlmClient, type SingleShotResult } from "./client";
import { LlmProviderError } from "./errors";
import type { LlmConfig } from "./types";

/**
 * What the LLM client tells a trace backend. The spans and metrics run through
 * the real SDK into memory, so these assert on what New Relic would receive.
 */
const config: LlmConfig = { provider: "groq", model: "test-model" };
const group = { ruleId: "image-alt", htmlSnippets: ["<img>", "<img src=a>"] };
const fast = { retryDelayMs: 0, circuitBreakerThreshold: 0 } as const;

const validAnalysis = {
  explanation: "Images need alternative text.",
  affectedUsers: ["screen reader users"],
  fixCode: '<img src="a.png" alt="A cat">',
  priority: "high",
};

function answer(output: unknown, input = 100, outputTokens = 20): SingleShotResult {
  return {
    output,
    usage: {
      inputTokens: input,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: input + outputTokens,
    },
  };
}

const spans = captureSpans();
beforeEach(() => spans.reset());
afterAll(() => spans.stop());

describe("LLM client spans", () => {
  it("nests one chat span per attempt under a group span", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(answer({ not: "valid" }))
      .mockResolvedValueOnce(answer(validAnalysis));
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 2 });

    await client.analyzeIssueGroup(group);

    const groupSpan = spans.span("llm.analyze_group");
    const attempts = spans.spans().filter((s) => s.name === "chat test-model");
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.kind).toBe(SpanKind.CLIENT);
      expect(attempt.parentSpanContext?.spanId).toBe(groupSpan.spanContext().spanId);
    }
    expect(attempts.map((a) => a.attributes["allyfix.llm.attempt"])).toEqual([1, 2]);
  });

  it("uses the GenAI semantic conventions for provider, model and tokens", async () => {
    const generate = vi.fn().mockResolvedValue(answer(validAnalysis, 300, 40));
    const client = createLlmClient(config, { ...fast, generate });

    await client.analyzeIssueGroup(group);

    expect(spans.span("chat test-model").attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "groq",
      "gen_ai.request.model": "test-model",
      "gen_ai.usage.input_tokens": 300,
      "gen_ai.usage.output_tokens": 40,
    });
    expect(spans.span("llm.analyze_group").attributes).toMatchObject({
      "allyfix.llm.rule_id": "image-alt",
      "allyfix.llm.snippets": 2,
      "allyfix.llm.attempts": 1,
      "allyfix.llm.breaker_state": "closed",
    });
  });

  it("marks a malformed answer retryable but not breaker-tripping", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(answer({ not: "valid" }))
      .mockResolvedValueOnce(answer(validAnalysis));
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 1 });

    await client.analyzeIssueGroup(group);

    const [failed, succeeded] = spans.spans().filter((s) => s.name === "chat test-model");
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.attributes).toMatchObject({
      "error.type": "LlmValidationError",
      "allyfix.llm.retryable": true,
      "allyfix.llm.trips_breaker": false,
    });
    // Its tokens were billed even though the answer was discarded.
    expect(failed?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(succeeded?.status.code).toBe(SpanStatusCode.UNSET);
    // The group recovered, so the group span is not an error.
    expect(spans.span("llm.analyze_group").status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records why a group failed on the group span, with the totals it spent", async () => {
    const badKey = new LlmProviderError("401 invalid key", false, 401, undefined);
    const generate = vi.fn().mockRejectedValue(badKey);
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 3 });

    await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/after 1 attempt/);

    const groupSpan = spans.span("llm.analyze_group");
    expect(groupSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(groupSpan.attributes).toMatchObject({
      "error.type": "LlmAnalysisError",
      "allyfix.llm.last_error": "LlmProviderError",
      "allyfix.llm.retryable": false,
      "allyfix.llm.trips_breaker": true,
      "allyfix.llm.attempts": 1,
    });
  });

  it("opens no chat span for a call the open circuit refused", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const generate = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createLlmClient(config, {
      retryDelayMs: 0,
      maxRetries: 0,
      generate,
      circuitBreaker: breaker,
    });

    await expect(client.analyzeIssueGroup(group)).rejects.toThrow();
    spans.reset();
    await expect(client.analyzeIssueGroup(group)).rejects.toThrow(/circuit breaker is open/);

    expect(spans.spans().map((s) => s.name)).toEqual(["llm.analyze_group"]);
    expect(spans.span("llm.analyze_group").attributes).toMatchObject({
      "allyfix.llm.breaker_state": "open",
      "allyfix.llm.last_error": "CircuitOpenError",
      "allyfix.llm.attempts": 1,
    });
  });

  it("reports cost on the group span only when a price is configured", async () => {
    const generate = vi.fn().mockResolvedValue(answer(validAnalysis, 1_000_000, 0));
    const priced = createLlmClient(config, {
      ...fast,
      generate,
      prices: { inputPerMTok: 0.5, outputPerMTok: 1 },
    });
    await priced.analyzeIssueGroup(group);
    expect(spans.span("llm.analyze_group").attributes["allyfix.llm.cost_usd"]).toBe(0.5);

    spans.reset();
    await createLlmClient(config, { ...fast, generate }).analyzeIssueGroup(group);
    expect(spans.span("llm.analyze_group").attributes).not.toHaveProperty("allyfix.llm.cost_usd");
  });
});

describe("LLM client metrics", () => {
  it("records tokens by type for every attempt, including the discarded one", async () => {
    const { meter, points } = captureMetrics();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(answer({ not: "valid" }, 100, 10))
      .mockResolvedValueOnce(answer(validAnalysis, 100, 30));
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 1, meter });

    await client.analyzeIssueGroup(group);

    const usage = await points("gen_ai.client.token.usage");
    const byType = Object.fromEntries(
      usage.map((p) => [p.attributes["gen_ai.token.type"], p.value]),
    );
    expect(byType.input).toEqual({ count: 2, sum: 200 });
    expect(byType.output).toEqual({ count: 2, sum: 40 });
    expect(usage[0]?.attributes).toMatchObject({
      "gen_ai.provider.name": "groq",
      "gen_ai.request.model": "test-model",
    });
  });

  it("records attempt latency, tagging failures with their error type", async () => {
    const { meter, points } = captureMetrics();
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(answer(validAnalysis));
    const client = createLlmClient(config, { ...fast, generate, maxRetries: 1, meter });

    await client.analyzeIssueGroup(group);

    const durations = await points("gen_ai.client.operation.duration");
    const errorTypes = durations.map((p) => p.attributes["error.type"]).sort();
    expect(errorTypes).toEqual(["LlmProviderError", undefined]);
  });

  it("adds to the cost counter only for priced calls — never a zero for unknown", async () => {
    const generate = vi.fn().mockResolvedValue(answer(validAnalysis, 2_000_000, 1_000_000));

    const priced = captureMetrics();
    await createLlmClient(config, {
      ...fast,
      generate,
      meter: priced.meter,
      prices: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    }).analyzeIssueGroup(group);
    expect((await priced.points("allyfix.llm.cost"))[0]?.value).toBeCloseTo(0.7);

    const unpriced = captureMetrics();
    await createLlmClient(config, { ...fast, generate, meter: unpriced.meter }).analyzeIssueGroup(
      group,
    );
    expect(await unpriced.points("allyfix.llm.cost")).toEqual([]);
  });

  it("records nothing for a provider that reports no usage", async () => {
    const { meter, points } = captureMetrics();
    const generate = vi.fn().mockResolvedValue({ output: validAnalysis, usage: null });
    await createLlmClient(config, { ...fast, generate, meter }).analyzeIssueGroup(group);
    expect(await points("gen_ai.client.token.usage")).toEqual([]);
  });
});

describe("genAiProviderName", () => {
  it("uses the registered convention value where one exists", () => {
    expect(genAiProviderName("gemini")).toBe("gcp.gemini");
    expect(genAiProviderName("groq")).toBe("groq");
    expect(genAiProviderName("ollama")).toBe("ollama");
  });
});
