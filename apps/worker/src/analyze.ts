import { createHash } from "node:crypto";
import { setAnalysisForRule, type Database } from "@ally-fix/db";
import { createLlmClient, type LlmClient, type LlmConfig } from "@ally-fix/llm";
import { llmIssueAnalysisSchema, type LlmIssueAnalysis } from "@ally-fix/shared";
import type IORedis from "ioredis";
import { MAX_PROMPT_SNIPPETS } from "@ally-fix/llm";
import type { ScannedIssue } from "./scanner";

export interface AnalyzeDeps {
  db: Database;
  redis: IORedis;
  config: LlmConfig;
  cacheTtlSeconds: number;
  /** Overridable for tests; defaults to a real client built from `config`. */
  client?: LlmClient;
}

export interface AnalyzeResult {
  analyzed: number;
  failed: number;
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
  const client = deps.client ?? createLlmClient(deps.config);
  const groups = groupByRule(issues);
  let analyzed = 0;
  let failed = 0;

  for (const [ruleId, htmlSnippets] of groups) {
    try {
      const analysis = await getOrGenerate(ruleId, htmlSnippets, deps, () =>
        client.analyzeIssueGroup({ ruleId, htmlSnippets }),
      );
      await setAnalysisForRule(deps.db, auditId, ruleId, analysis);
      analyzed++;
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker] analysis failed for rule "${ruleId}": ${message}`);
    }
  }

  return { analyzed, failed };
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

/** Look the analysis up in Redis; on a miss, generate it and cache the result. */
async function getOrGenerate(
  ruleId: string,
  htmlSnippets: string[],
  deps: AnalyzeDeps,
  generate: () => Promise<LlmIssueAnalysis>,
): Promise<LlmIssueAnalysis> {
  const key = buildCacheKey(deps.config, ruleId, htmlSnippets);

  const cached = await deps.redis.get(key);
  if (cached) {
    const parsed = llmIssueAnalysisSchema.safeParse(JSON.parse(cached));
    if (parsed.success) return parsed.data;
    // Corrupt/stale cache entry — fall through and regenerate.
  }

  const analysis = await generate();
  await deps.redis.set(key, JSON.stringify(analysis), "EX", deps.cacheTtlSeconds);
  return analysis;
}

/**
 * Cache key = provider + model + rule + a hash of the HTML pattern. Keying on the
 * HTML lets the same rule + markup pattern reuse an answer across audits, while
 * different providers/models keep separate caches.
 */
function buildCacheKey(config: LlmConfig, ruleId: string, htmlSnippets: string[]): string {
  const pattern = htmlSnippets.join("\n").replace(/\s+/g, " ").trim();
  const hash = createHash("sha256").update(pattern).digest("hex").slice(0, 16);
  return `llm:v1:${config.provider}:${config.model}:${ruleId}:${hash}`;
}
