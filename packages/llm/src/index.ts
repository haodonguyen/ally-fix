import type { LlmIssueAnalysis } from "@ally-fix/shared";

/**
 * Provider-agnostic LLM layer.
 *
 * Phase 2 will implement `analyzeIssueGroup` on top of the Vercel AI SDK's
 * `generateObject`, validating the result against `llmIssueAnalysisSchema`
 * (from @ally-fix/shared) and retrying on a parse failure.
 *
 * This file currently defines only the contract so the rest of the app can be
 * built against a stable interface. No provider calls happen yet.
 */

/** Supported providers. `ollama` is the free, local default; the others are BYO-key. */
export type LlmProviderName = "ollama" | "groq" | "gemini";

export interface LlmConfig {
  provider: LlmProviderName;
  /** Model id, e.g. "llama3.1" or "gemini-2.0-flash". */
  model: string;
  /** Bring-your-own-key. In-session only — never persisted or logged. */
  apiKey?: string;
  /** Base URL, used by Ollama (defaults to http://localhost:11434). */
  baseUrl?: string;
}

/** One group of issues sharing the same axe rule, batched into a single LLM call. */
export interface IssueGroupInput {
  ruleId: string;
  /** Representative HTML snippets for this rule (deduplicated by the caller). */
  htmlSnippets: string[];
}

/**
 * Turn a group of same-rule issues into a plain-language explanation and fix.
 * Batches by rule and (in Phase 2) caches by ruleId + HTML pattern to control cost.
 */
export interface LlmClient {
  analyzeIssueGroup(input: IssueGroupInput): Promise<LlmIssueAnalysis>;
}

/** Phase 2 will return a concrete client based on the provider in `config`. */
export function createLlmClient(_config: LlmConfig): LlmClient {
  throw new Error("Not implemented yet — LLM layer lands in Phase 2.");
}
