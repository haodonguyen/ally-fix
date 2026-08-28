import { afterEach, describe, expect, it, vi } from "vitest";

// `env` is built at import time, so the required vars must exist before it loads.
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://test";
  process.env.REDIS_URL = "redis://test";
});

import { resolveLlmClientOptions, resolveLlmConfig } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLlmConfig", () => {
  it("defaults to local Ollama, so a self-hosted run needs no key", () => {
    expect(resolveLlmConfig()).toEqual({
      provider: "ollama",
      model: "llama3.1",
      baseUrl: "http://localhost:11434",
    });
  });

  it("falls back to Ollama for an unrecognised provider rather than crashing", () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    expect(resolveLlmConfig().provider).toBe("ollama");
  });

  it("reads the key and model for a hosted provider", () => {
    vi.stubEnv("LLM_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "gsk_test");
    vi.stubEnv("GROQ_MODEL", "custom-model");

    expect(resolveLlmConfig()).toEqual({
      provider: "groq",
      model: "custom-model",
      apiKey: "gsk_test",
    });
  });

  it("leaves the key undefined when it is not set, instead of an empty string", () => {
    vi.stubEnv("LLM_PROVIDER", "gemini");
    expect(resolveLlmConfig().apiKey).toBeUndefined();
  });
});

describe("resolveLlmClientOptions", () => {
  const ollama = { provider: "ollama", model: "llama3.1" } as const;
  const groq = { provider: "groq", model: "openai/gpt-oss-20b" } as const;

  it("does not throttle a local model, which has no quota to protect", () => {
    expect(resolveLlmClientOptions(ollama).requestsPerMinute).toBe(0);
  });

  it("throttles hosted providers by default, which do enforce a per-minute cap", () => {
    expect(resolveLlmClientOptions(groq).requestsPerMinute).toBe(30);
  });

  it("lets the environment override the rate, including turning it off", () => {
    vi.stubEnv("LLM_REQUESTS_PER_MINUTE", "5");
    expect(resolveLlmClientOptions(groq).requestsPerMinute).toBe(5);

    vi.stubEnv("LLM_REQUESTS_PER_MINUTE", "0");
    expect(resolveLlmClientOptions(groq).requestsPerMinute).toBe(0);
  });

  it("ships sane defaults for the whole failure policy", () => {
    expect(resolveLlmClientOptions(ollama)).toMatchObject({
      timeoutMs: 60_000,
      maxRetries: 3,
      retryDelayMs: 800,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 30_000,
    });
  });

  it("treats zero as 'disabled' for the knobs where that is meaningful", () => {
    vi.stubEnv("LLM_MAX_RETRIES", "0");
    vi.stubEnv("LLM_BREAKER_THRESHOLD", "0");
    vi.stubEnv("LLM_RETRY_BASE_MS", "0");

    expect(resolveLlmClientOptions(ollama)).toMatchObject({
      maxRetries: 0,
      circuitBreakerThreshold: 0,
      retryDelayMs: 0,
    });
  });

  it("treats a declared-but-empty variable as unset, not as zero", () => {
    // `KEY=` in a .env file arrives as "", and Number("") is 0 — which for these
    // knobs means "disabled". Copying .env.example must not silently switch off
    // the rate limiter, the retry budget, or the circuit breaker.
    vi.stubEnv("LLM_REQUESTS_PER_MINUTE", "");
    vi.stubEnv("LLM_MAX_RETRIES", "");
    vi.stubEnv("LLM_BREAKER_THRESHOLD", "");

    expect(resolveLlmClientOptions(groq)).toMatchObject({
      requestsPerMinute: 30,
      maxRetries: 3,
      circuitBreakerThreshold: 5,
    });
  });

  it("treats a whitespace-only variable as unset too", () => {
    vi.stubEnv("LLM_REQUESTS_PER_MINUTE", "   ");
    expect(resolveLlmClientOptions(groq).requestsPerMinute).toBe(30);
  });

  it("still honours an explicit zero, which really does mean disabled", () => {
    vi.stubEnv("LLM_REQUESTS_PER_MINUTE", "0");
    vi.stubEnv("LLM_BREAKER_THRESHOLD", "0");

    expect(resolveLlmClientOptions(groq)).toMatchObject({
      requestsPerMinute: 0,
      circuitBreakerThreshold: 0,
    });
  });

  it("trims a value that arrived with surrounding whitespace", () => {
    vi.stubEnv("LLM_REQUESTS_PER_MINUTE", " 12 ");
    expect(resolveLlmClientOptions(groq).requestsPerMinute).toBe(12);
  });

  it("ignores a garbage value instead of silently disabling a timeout", () => {
    // The trap this guards: Number("30s") is NaN, and a NaN timeout never fires.
    vi.stubEnv("LLM_TIMEOUT_MS", "30s");
    expect(resolveLlmClientOptions(ollama).timeoutMs).toBe(60_000);

    vi.stubEnv("LLM_TIMEOUT_MS", "0");
    expect(resolveLlmClientOptions(ollama).timeoutMs).toBe(60_000);

    vi.stubEnv("LLM_MAX_RETRIES", "-1");
    expect(resolveLlmClientOptions(ollama).maxRetries).toBe(3);
  });
});
