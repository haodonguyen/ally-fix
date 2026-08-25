import type { CreateLlmClientOptions, LlmConfig, LlmProviderName } from "@ally-fix/llm";

/** Reads a required env var, throwing if it is missing or empty. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Reads a positive-integer env var. Falls back to `fallback` when unset OR when
 * the value isn't a finite positive number — plain `Number(x ?? d)` would let a
 * value like "30s" through as NaN, which silently disables timeouts / TTLs.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Same, but zero is a meaningful value: for the retry, rate-limit, and circuit
 * breaker knobs, 0 means "turn this off". Only a negative or unparseable value
 * falls back to the default.
 */
function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  REDIS_URL: required("REDIS_URL"),
  /** Max time to wait for a page to load before giving up, in milliseconds. */
  SCAN_TIMEOUT_MS: positiveIntEnv("SCAN_TIMEOUT_MS", 30_000),
  /** How long a cached LLM analysis stays valid, in seconds (default 30 days). */
  LLM_CACHE_TTL_SECONDS: positiveIntEnv("LLM_CACHE_TTL_SECONDS", 60 * 60 * 24 * 30),
};

/**
 * Builds the LLM config from the environment. Defaults to Ollama (free, local),
 * so a self-hosted run needs no API key. Provider keys are read at call time and
 * never stored anywhere but this in-memory config.
 */
export function resolveLlmConfig(): LlmConfig {
  const provider = (process.env.LLM_PROVIDER ?? "ollama") as LlmProviderName;

  switch (provider) {
    case "groq":
      return {
        provider,
        model: process.env.GROQ_MODEL ?? "openai/gpt-oss-20b",
        apiKey: process.env.GROQ_API_KEY,
      };
    case "gemini":
      return {
        provider,
        model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      };
    case "ollama":
    default:
      return {
        provider: "ollama",
        model: process.env.OLLAMA_MODEL ?? "llama3.1",
        baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      };
  }
}

/**
 * The outbound failure policy for LLM calls: per-attempt deadline, rate limit,
 * retry budget, and circuit breaker.
 *
 * The rate-limit default is provider-dependent, because the constraint is: a
 * local Ollama has no quota to protect and throttling it only makes scans slower,
 * whereas the hosted free tiers enforce requests-per-minute and will 429 a busy
 * scan. Defaulting to 0 for Ollama and a conservative 30/min for hosted providers
 * means neither self-hosters nor the demo have to tune anything to work.
 */
export function resolveLlmClientOptions(config: LlmConfig): CreateLlmClientOptions {
  const hostedDefaultRpm = config.provider === "ollama" ? 0 : 30;

  return {
    // A local model on CPU is genuinely slow, so the deadline is generous — its
    // job is to catch a hung connection, not to police a slow-but-working model.
    timeoutMs: positiveIntEnv("LLM_TIMEOUT_MS", 60_000),
    maxRetries: nonNegativeIntEnv("LLM_MAX_RETRIES", 3),
    retryDelayMs: nonNegativeIntEnv("LLM_RETRY_BASE_MS", 800),
    requestsPerMinute: nonNegativeIntEnv("LLM_REQUESTS_PER_MINUTE", hostedDefaultRpm),
    circuitBreakerThreshold: nonNegativeIntEnv("LLM_BREAKER_THRESHOLD", 5),
    circuitBreakerResetMs: positiveIntEnv("LLM_BREAKER_RESET_MS", 30_000),
  };
}
