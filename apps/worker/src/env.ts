import type {
  CreateLlmClientOptions,
  LlmConfig,
  LlmProviderName,
  TokenPrices,
} from "@ally-fix/llm";

/** Reads a required env var, throwing if it is missing or empty. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Reads an env var, treating "declared but empty" as absent.
 *
 * `KEY=` in a .env file arrives as an empty string, not as undefined, and
 * `Number("")` is 0 — so a blank line would otherwise be read as a deliberate
 * zero. For the knobs below zero means "turn this off", which would silently
 * disable a protection that the caller only meant to leave at its default.
 */
function rawEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

/**
 * Reads a positive-integer env var. Falls back to `fallback` when unset OR when
 * the value isn't a finite positive number — plain `Number(x ?? d)` would let a
 * value like "30s" through as NaN, which silently disables timeouts / TTLs.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = rawEnv(name);
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
  const raw = rawEnv(name);
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
  /**
   * How long in-flight scans get to finish after a SIGTERM. Kept under the 30s
   * most platforms allow between SIGTERM and SIGKILL, so we exit on our own
   * terms rather than being killed mid-write.
   */
  SHUTDOWN_GRACE_MS: positiveIntEnv("SHUTDOWN_GRACE_MS", 20_000),
  /**
   * A `running` audit older than this was abandoned by a dead worker. Comfortably
   * above SCAN_TIMEOUT_MS plus the LLM pass, so a slow-but-live scan is never
   * swept out from under itself.
   */
  STALE_AUDIT_AFTER_MS: positiveIntEnv("STALE_AUDIT_AFTER_MS", 15 * 60_000),
  /** How often to sweep for abandoned audits after the pass at startup. */
  STALE_SWEEP_INTERVAL_MS: positiveIntEnv("STALE_SWEEP_INTERVAL_MS", 5 * 60_000),
};

/**
 * Reads a boolean env var. Only an explicit "false"/"0"/"no"/"off" turns a
 * default-on flag off; anything else unrecognised keeps the default rather than
 * being read as false, so a typo cannot quietly disable a feature.
 */
function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = rawEnv(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

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
 * Reads a non-negative decimal env var, for prices. Returns null when unset or
 * unparseable — `null` means "no rate configured", which is a different thing
 * from a rate of zero and must stay different all the way to the log line.
 */
function priceEnv(name: string): number | null {
  const raw = rawEnv(name);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Per-million-token rates for the configured model, from the environment.
 *
 * Prices are configuration, not code: they change, they differ per account
 * (free tier, committed use, credits), and a table checked into a repo goes
 * stale faster than anyone updates it. A missing or half-filled rate yields
 * null, so the logs report exact token counts and no cost at all — rather than
 * a confident wrong number (ADR-0008).
 *
 * Ollama is the exception, and it is handled in the LLM layer: a local model
 * bills nothing per token, so zero there is a fact rather than a default.
 */
export function resolveLlmPrices(): TokenPrices | null {
  const inputPerMTok = priceEnv("LLM_PRICE_INPUT_PER_MTOK");
  const outputPerMTok = priceEnv("LLM_PRICE_OUTPUT_PER_MTOK");
  // Both halves or neither. One rate alone would silently cost the other side
  // of the call at zero, which understates every bill it touches.
  if (inputPerMTok === null || outputPerMTok === null) return null;
  return { inputPerMTok, outputPerMTok };
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
    // On by default. The switch exists so `eval:compare` can run the same golden
    // set with grounding off and attribute the difference; it is a measurement
    // control, not a setting anyone tuning a deployment should need to touch.
    grounded: booleanEnv("LLM_GROUNDING", true),
    prices: resolveLlmPrices() ?? undefined,
  };
}
