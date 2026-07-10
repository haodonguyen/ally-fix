import { llmIssueAnalysisSchema, type LlmIssueAnalysis } from "@ally-fix/shared";
import { generateObject } from "ai";
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt } from "./prompt";
import { resolveModel } from "./providers";
import type { IssueGroupInput, LlmClient, LlmConfig } from "./types";

/**
 * The single-shot generation primitive: given a system + user prompt, return the
 * model's raw object. The real implementation calls the AI SDK; tests inject a
 * fake so the retry/validation logic can be exercised without a provider.
 */
export type SingleShotGenerate = (args: { system: string; prompt: string }) => Promise<unknown>;

export interface CreateLlmClientOptions {
  /** Extra attempts after the first, on a validation or provider failure. Default 3. */
  maxRetries?: number;
  /** Base backoff between retries in ms; doubles each attempt. Default 800. Set 0 in tests. */
  retryDelayMs?: number;
  /** Test seam — replaces the real model call. */
  generate?: SingleShotGenerate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an error is worth retrying. A client error (4xx other than 429 —
 * bad key, unknown model, malformed request) can't succeed on retry, so we stop
 * early. Rate limits (429) and everything else — notably a Zod schema-validation
 * failure with no status — are retryable.
 */
function isRetryable(error: unknown): boolean {
  if (error && typeof error === "object") {
    const err = error as { isRetryable?: unknown; statusCode?: unknown };
    if (err.isRetryable === false) return false;
    if (
      typeof err.statusCode === "number" &&
      err.statusCode >= 400 &&
      err.statusCode < 500 &&
      err.statusCode !== 429
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Creates a provider-agnostic LLM client. Structured output is validated against
 * `llmIssueAnalysisSchema` (from @ally-fix/shared); a parse failure — whether the
 * SDK's or a misbehaving provider's — triggers a retry.
 */
export function createLlmClient(
  config: LlmConfig,
  options: CreateLlmClientOptions = {},
): LlmClient {
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 800;

  const generate: SingleShotGenerate =
    options.generate ??
    (async ({ system, prompt }) => {
      const { object } = await generateObject({
        model: resolveModel(config),
        schema: llmIssueAnalysisSchema,
        system,
        prompt,
        // We own the retry loop below, so don't let the SDK stack its own on top.
        maxRetries: 0,
      });
      return object;
    });

  return {
    async analyzeIssueGroup(input: IssueGroupInput): Promise<LlmIssueAnalysis> {
      const prompt = buildAnalysisPrompt(input);
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const raw = await generate({ system: ANALYSIS_SYSTEM_PROMPT, prompt });
          return llmIssueAnalysisSchema.parse(raw);
        } catch (error) {
          lastError = error;
          // Don't waste attempts (and quota) on errors that can't succeed on retry,
          // e.g. a 401 for a bad key or a 404 for an unknown model.
          if (!isRetryable(error)) break;
          // Exponential backoff before the next try — gives rate limits (429,
          // which are retryable) time to clear their per-minute window.
          if (attempt < maxRetries && retryDelayMs > 0) {
            await sleep(retryDelayMs * 2 ** attempt);
          }
        }
      }

      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`LLM analysis failed after ${maxRetries + 1} attempt(s): ${reason}`);
    },
  };
}
