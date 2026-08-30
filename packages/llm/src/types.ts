import type { LlmIssueAnalysis } from "@ally-fix/shared";
import type { TokenPrices, TokenUsage } from "./usage";

/** Supported providers. `ollama` is the free, local default; the others are BYO-key. */
export type LlmProviderName = "ollama" | "groq" | "gemini";

export interface LlmConfig {
  provider: LlmProviderName;
  /** Model id, e.g. "llama3.1", "llama-3.3-70b-versatile", or "gemini-2.0-flash". */
  model: string;
  /** Bring-your-own-key. In-session only — never persisted or logged. */
  apiKey?: string;
  /** Base URL, used by Ollama (defaults to http://localhost:11434). */
  baseUrl?: string;
  /**
   * Per-million-token rates for costing this model. Supplied by the operator,
   * because published prices go stale and differ per account. Absent means
   * costs are reported as null rather than guessed.
   */
  prices?: TokenPrices;
}

/** One group of issues sharing the same axe rule, batched into a single LLM call. */
export interface IssueGroupInput {
  ruleId: string;
  /** Representative HTML snippets for this rule (deduplicated by the caller). */
  htmlSnippets: string[];
}

/**
 * One completed analysis, and what it cost to get.
 *
 * The analysis and its cost are returned side by side rather than merged: the
 * analysis is domain data that gets persisted and shown to a user, while the
 * usage is operational data that belongs in a log line. Merging them would put
 * token counts into the report page and into the cache.
 */
export interface LlmAnalysisResult {
  analysis: LlmIssueAnalysis;
  /**
   * Tokens consumed across *every* attempt, not only the one that succeeded.
   * A group that parsed on the third try was billed three times, and a cost
   * number that hides that is wrong precisely when retries are spiking.
   */
  usage: TokenUsage | null;
  /** Null when no price is configured for this model — never a placeholder zero. */
  costUsd: number | null;
  /** Attempts made, including the successful one. */
  attempts: number;
}

/** Turns a group of same-rule issues into a plain-language explanation and fix. */
export interface LlmClient {
  /**
   * Identifies the prompt this client sends. Anything caching an answer has to
   * include it in the key — the answer belongs to the prompt that produced it,
   * not just to the rule and the markup.
   */
  readonly promptFingerprint: string;
  analyzeIssueGroup(input: IssueGroupInput): Promise<LlmAnalysisResult>;
}
