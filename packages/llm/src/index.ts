/** Public surface of @ally-fix/llm. */
export type {
  LlmProviderName,
  LlmConfig,
  IssueGroupInput,
  LlmAnalysisResult,
  LlmClient,
} from "./types";
export { createLlmClient, backoffDelay, coerceRawOutput } from "./client";
export type { CreateLlmClientOptions, SingleShotGenerate, SingleShotResult } from "./client";
export { readUsage, addUsage, estimateCostUsd, defaultPricesFor, EMPTY_USAGE } from "./usage";
export type { TokenUsage, TokenPrices } from "./usage";
export {
  buildAnalysisPrompt,
  analysisSystemPrompt,
  MAX_PROMPT_SNIPPETS,
  promptFingerprint,
} from "./prompt";
export type { BuildPromptOptions } from "./prompt";
export {
  groundingFor,
  formatGrounding,
  AXE_CORE_VERSION,
  MAX_GROUNDED_CRITERIA,
  allGroundingBlocks,
} from "./grounding";
export type { RuleGrounding, AxeRuleFacts, WcagCriterion } from "./grounding";
export { WCAG_CRITERIA, understandingUrl } from "./grounding/wcag-criteria";
export { AXE_RULE_FACTS } from "./grounding/axe-rules.generated";
export { resolveModel } from "./providers";
export {
  LlmError,
  LlmTimeoutError,
  LlmValidationError,
  LlmProviderError,
  CircuitOpenError,
  LlmAnalysisError,
  classifyProviderError,
} from "./errors";
export type { CircuitOpenReason } from "./errors";
export { createTokenBucket, noopThrottle } from "./throttle";
export type { Throttle, TokenBucketOptions } from "./throttle";
export { createCircuitBreaker, noopCircuitBreaker } from "./circuit-breaker";
export type { CircuitBreaker, CircuitBreakerOptions, CircuitState } from "./circuit-breaker";
