import { createHash } from "node:crypto";
import { setAnalysisForRule, type Database } from "@ally-fix/db";
import {
  CircuitOpenError,
  LlmAnalysisError,
  MAX_PROMPT_SNIPPETS,
  addUsage,
  estimateCostUsd,
  type LlmClient,
  type LlmAnalysisResult,
  type LlmConfig,
  type TokenPrices,
  type TokenUsage,
} from "@ally-fix/llm";
import { llmIssueAnalysisSchema, type LlmIssueAnalysis } from "@ally-fix/shared";
import type { Logger } from "@ally-fix/shared/logger";
import type IORedis from "ioredis";
import type { ScannedIssue } from "./scanner";

export interface AnalyzeDeps {
  db: Database;
  redis: IORedis;
  /** Only used to namespace the cache — the client owns the provider connection. */
  config: LlmConfig;
  cacheTtlSeconds: number;
  /**
   * Rate used to turn tokens into dollars in the audit summary. Null leaves the
   * cost null — the tokens are still reported, because they were measured.
   */
  prices?: TokenPrices | null;
  /** Shared across audits, so its rate limiter and breaker see all traffic. */
  client: LlmClient;
  /** Already carrying the audit id, so per-rule lines stay correlated. */
  logger: Logger;
}

export interface AnalyzeResult {
  analyzed: number;
  failed: number;
  /** Groups never attempted because the circuit had already opened. */
  skipped: number;
  /** Groups served from Redis, which cost no tokens at all. */
  cacheHits: number;
  /**
   * Tokens this audit spent, including the ones burned by groups that failed.
   * Null when nothing was generated, or when the provider reports no counts.
   */
  usage: TokenUsage | null;
  /** Null when no rate is configured — never a zero standing in for "unknown". */
  costUsd: number | null;
}

/**
 * Second half of the pipeline (Phase 2). Groups issues by axe rule so we make one
 * LLM call per rule instead of per issue, caches each result in Redis by
 * rule + HTML pattern, and writes the analysis back onto every issue of that rule.
 *
 * Best-effort: the raw issues are already stored, so a failure here (e.g. no LLM
 * provider reachable) only leaves `llm_analysis` null — it never fails the audit.
 */
export async function analyzeAudit(
  auditId: string,
  issues: ScannedIssue[],
  deps: AnalyzeDeps,
): Promise<AnalyzeResult> {
  const groups = [...groupByRule(issues)];
  let analyzed = 0;
  let failed = 0;
  let cacheHits = 0;
  let usage: TokenUsage | null = null;

  const spent = (): Pick<AnalyzeResult, "usage" | "costUsd"> => ({
    usage,
    costUsd: estimateCostUsd(usage, deps.prices ?? null),
  });

  for (const [index, [ruleId, htmlSnippets]] of groups.entries()) {
    try {
      const generated = await getOrGenerate(ruleId, htmlSnippets, deps, () =>
        deps.client.analyzeIssueGroup({ ruleId, htmlSnippets }),
      );
      usage = addUsage(usage, generated.usage);
      if (generated.cached) cacheHits++;

      await setAnalysisForRule(deps.db, auditId, ruleId, generated.analysis);
      analyzed++;
    } catch (error) {
      // Attempts that failed were still billed. Take their tokens off the error
      // before deciding what to do with it, or a provider having a bad day looks
      // cheaper than one working perfectly.
      if (error instanceof LlmAnalysisError) usage = addUsage(usage, error.usage);
      else if (error instanceof Error && error.cause instanceof LlmAnalysisError) {
        usage = addUsage(usage, error.cause.usage);
      }

      // An open circuit means the provider is down, not that this rule is
      // special: abandon the rest of the audit's analysis instead of logging the
      // same failure once per remaining group.
      if (isCircuitOpen(error)) {
        const skipped = groups.length - index;
        deps.logger.warn("LLM circuit open, abandoning remaining analysis", {
          skipped,
          analyzed,
          failed,
        });
        return { analyzed, failed, skipped, cacheHits, ...spent() };
      }
      failed++;
      deps.logger.warn("rule analysis failed", { ruleId, err: error });
    }
  }

  return { analyzed, failed, skipped: 0, cacheHits, ...spent() };
}

/** The client wraps the last failure, so the breaker's signal arrives as a cause. */
function isCircuitOpen(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return true;
  return error instanceof Error && error.cause instanceof CircuitOpenError;
}

/** Group issues by rule id, keeping up to MAX_PROMPT_SNIPPETS unique HTML snippets each. */
function groupByRule(issues: ScannedIssue[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const issue of issues) {
    const snippets = groups.get(issue.ruleId) ?? [];
    if (snippets.length < MAX_PROMPT_SNIPPETS && !snippets.includes(issue.htmlSnippet)) {
      snippets.push(issue.htmlSnippet);
    }
    groups.set(issue.ruleId, snippets);
  }
  return groups;
}

/** One group's outcome, with what it cost. A cache hit costs nothing at all. */
interface GeneratedAnalysis {
  analysis: LlmIssueAnalysis;
  usage: TokenUsage | null;
  cached: boolean;
}

/** Look the analysis up in Redis; on a miss, generate it and cache the result. */
async function getOrGenerate(
  ruleId: string,
  htmlSnippets: string[],
  deps: AnalyzeDeps,
  generate: () => Promise<LlmAnalysisResult>,
): Promise<GeneratedAnalysis> {
  const key = buildCacheKey(deps, ruleId, htmlSnippets);

  const cached = await readCache(deps.redis, key);
  // A hit is genuinely free, so its usage is a measured zero rather than null.
  // That distinction is what lets the summary say how much the cache saved.
  if (cached) return { analysis: cached, usage: null, cached: true };

  const result = await generate();
  deps.logger.debug("rule analysed", {
    ruleId,
    attempts: result.attempts,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    costUsd: roundUsd(result.costUsd),
  });

  // A cache write must never lose an answer we already paid for.
  try {
    await deps.redis.set(key, JSON.stringify(result.analysis), "EX", deps.cacheTtlSeconds);
  } catch (error) {
    deps.logger.warn("could not cache analysis", { ruleId, err: error });
  }
  return { analysis: result.analysis, usage: result.usage, cached: false };
}

/**
 * Costs are fractions of a cent, and raw floats log as `0.00013800000000000002`.
 * Six decimal places is a hundredth of a cent — finer than anything is billed at.
 */
export function roundUsd(costUsd: number | null): number | null {
  return costUsd === null ? null : Math.round(costUsd * 1e6) / 1e6;
}

/**
 * Reads a cached analysis, tolerating every way the entry can be unusable:
 * Redis being down, invalid JSON, or a payload from an older schema version.
 * Any of those falls through to a fresh generation rather than failing the group.
 */
async function readCache(redis: IORedis, key: string): Promise<LlmIssueAnalysis | null> {
  let cached: string | null;
  try {
    cached = await redis.get(key);
  } catch {
    return null; // Cache unavailable — degrade to generating.
  }
  if (!cached) return null;

  try {
    const parsed = llmIssueAnalysisSchema.safeParse(JSON.parse(cached));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // Corrupt entry — regenerate.
  }
}

/**
 * Cache key = provider + model + prompt + rule + a hash of the HTML pattern.
 * Keying on the HTML lets the same rule + markup pattern reuse an answer across
 * audits, while different providers/models keep separate caches.
 *
 * The prompt fingerprint is in there because an answer belongs to the prompt
 * that produced it. Without it, a prompt change would keep serving answers from
 * the old one for the full 30-day TTL — long enough to make a shipped change
 * look like it did nothing.
 */
function buildCacheKey(deps: AnalyzeDeps, ruleId: string, htmlSnippets: string[]): string {
  const pattern = htmlSnippets.join("\n").replace(/\s+/g, " ").trim();
  const hash = createHash("sha256").update(pattern).digest("hex").slice(0, 16);
  const { provider, model } = deps.config;
  return `llm:v1:${provider}:${model}:${deps.client.promptFingerprint}:${ruleId}:${hash}`;
}
