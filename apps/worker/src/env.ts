import type { LlmConfig, LlmProviderName } from "@ally-fix/llm";

/** Reads and validates the environment the worker needs to run. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  REDIS_URL: required("REDIS_URL"),
  /** Max time to wait for a page to load before giving up, in milliseconds. */
  SCAN_TIMEOUT_MS: Number(process.env.SCAN_TIMEOUT_MS ?? 30_000),
  /** How long a cached LLM analysis stays valid, in seconds (default 30 days). */
  LLM_CACHE_TTL_SECONDS: Number(process.env.LLM_CACHE_TTL_SECONDS ?? 60 * 60 * 24 * 30),
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
        model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
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
