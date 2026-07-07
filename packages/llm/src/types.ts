import type { LlmIssueAnalysis } from "@ally-fix/shared";

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
}

/** One group of issues sharing the same axe rule, batched into a single LLM call. */
export interface IssueGroupInput {
  ruleId: string;
  /** Representative HTML snippets for this rule (deduplicated by the caller). */
  htmlSnippets: string[];
}

/** Turns a group of same-rule issues into a plain-language explanation and fix. */
export interface LlmClient {
  analyzeIssueGroup(input: IssueGroupInput): Promise<LlmIssueAnalysis>;
}
