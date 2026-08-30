import { afterEach, describe, expect, it, vi } from "vitest";

// `env` is built at import time, so the required vars must exist before it loads.
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://test";
  process.env.REDIS_URL = "redis://test";
});

import { resolveLlmClientOptions, resolveLlmConfig, resolveLlmPrices } from "./env";

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

  it("grounds prompts by default", () => {
    expect(resolveLlmClientOptions(ollama).grounded).toBe(true);
  });

  it("lets an explicit falsy value turn grounding off, for the comparison run", () => {
    for (const value of ["false", "0", "no", "off", "FALSE"]) {
      vi.stubEnv("LLM_GROUNDING", value);
      expect(resolveLlmClientOptions(ollama).grounded).toBe(false);
    }
    for (const value of ["true", "1", "yes", "on"]) {
      vi.stubEnv("LLM_GROUNDING", value);
      expect(resolveLlmClientOptions(ollama).grounded).toBe(true);
    }
  });

  it("keeps grounding on when the value is unrecognised", () => {
    // A typo must not quietly ship the ungrounded prompt to production.
    for (const value of ["", "  ", "maybe", "flase"]) {
      vi.stubEnv("LLM_GROUNDING", value);
      expect(resolveLlmClientOptions(ollama).grounded).toBe(true);
    }
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

describe("resolveLlmPrices", () => {
  const ollama = { provider: "ollama", model: "llama3.1" } as const;
  const groq = { provider: "groq", model: "openai/gpt-oss-20b" } as const;

  it("returns null when nothing is configured", () => {
    expect(resolveLlmPrices()).toBeNull();
  });

  it("reads both rates when both are given", () => {
    vi.stubEnv("LLM_PRICE_INPUT_PER_MTOK", "0.1");
    vi.stubEnv("LLM_PRICE_OUTPUT_PER_MTOK", "0.5");
    expect(resolveLlmPrices()).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
  });

  it("refuses a half-configured rate", () => {
    // One rate alone would cost the other side of every call at zero, which
    // understates the bill instead of admitting it is unknown.
    vi.stubEnv("LLM_PRICE_INPUT_PER_MTOK", "0.1");
    expect(resolveLlmPrices()).toBeNull();
  });

  it("accepts an explicit zero, which is a real rate", () => {
    vi.stubEnv("LLM_PRICE_INPUT_PER_MTOK", "0");
    vi.stubEnv("LLM_PRICE_OUTPUT_PER_MTOK", "0");
    expect(resolveLlmPrices()).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it("treats an unparseable or negative rate as unconfigured", () => {
    for (const bad of ["$0.10", "abc", "-1", ""]) {
      vi.stubEnv("LLM_PRICE_INPUT_PER_MTOK", bad);
      vi.stubEnv("LLM_PRICE_OUTPUT_PER_MTOK", "0.5");
      expect(resolveLlmPrices()).toBeNull();
    }
  });

  it("hands the rate to the client options", () => {
    vi.stubEnv("LLM_PRICE_INPUT_PER_MTOK", "0.1");
    vi.stubEnv("LLM_PRICE_OUTPUT_PER_MTOK", "0.5");
    expect(resolveLlmClientOptions(groq).prices).toEqual({
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
    });
  });

  it("leaves prices undefined so the LLM layer can apply its own default", () => {
    // Ollama's zero belongs in the LLM layer, where "local" is known. Forcing a
    // null here would override it.
    expect(resolveLlmClientOptions(ollama).prices).toBeUndefined();
  });
});
