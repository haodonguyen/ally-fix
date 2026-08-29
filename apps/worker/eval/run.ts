import type { LlmClient } from "@ally-fix/llm";
import type { LlmIssueAnalysis } from "@ally-fix/shared";
import { EVAL_CASES, type EvalCase } from "./cases";
import { runStaticChecks, type StaticCheckResult } from "./checks";
import type { AxeVerifier } from "./verify";

/**
 * Scores the LLM layer against the golden set.
 *
 * The headline number is `resolved`: the share of cases where applying the
 * model's own `fixCode` makes axe stop reporting the rule — while still
 * containing the element the rule was about, so deleting it does not count.
 *
 * This module is the harness and nothing else — no environment, no provider, no
 * browser — so the scoring logic can be unit-tested with fakes. `index.ts` wires
 * it to the real ones.
 */
export type CaseVerdict =
  "resolved" | "not-resolved" | "degenerate" | "unparseable-fix" | "llm-error" | "broken-case";

export interface CaseResult {
  case: EvalCase;
  verdict: CaseVerdict;
  latencyMs: number;
  checks?: StaticCheckResult;
  analysis?: LlmIssueAnalysis;
  detail?: string;
}

export interface EvalDeps {
  client: Pick<LlmClient, "analyzeIssueGroup">;
  verifier: AxeVerifier;
  cases?: EvalCase[];
  now?: () => number;
}

/** Runs one case end to end: baseline → model → oracle. */
export async function runCase(evalCase: EvalCase, deps: EvalDeps): Promise<CaseResult> {
  const now = deps.now ?? Date.now;

  // The dataset is checked on every run. A snippet that no longer violates its
  // rule — because axe changed, or because it was wrong to begin with — is a
  // broken case, not a model failure, and must never be scored as a pass.
  const baseline = await deps.verifier.check(evalCase.html, evalCase.ruleId);
  if (baseline !== "violates") {
    return {
      case: evalCase,
      verdict: "broken-case",
      latencyMs: 0,
      detail:
        baseline === "rule-not-run"
          ? `axe never ran "${evalCase.ruleId}" — unknown rule id?`
          : "the sample HTML no longer violates its rule",
    };
  }

  const startedAt = now();
  let analysis: LlmIssueAnalysis;
  try {
    analysis = await deps.client.analyzeIssueGroup({
      ruleId: evalCase.ruleId,
      htmlSnippets: [evalCase.html],
    });
  } catch (error) {
    return {
      case: evalCase,
      verdict: "llm-error",
      latencyMs: now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const latencyMs = now() - startedAt;

  const checks = runStaticChecks(evalCase.html, analysis, evalCase.subjectTag);
  if (!checks.fixParses) {
    return { case: evalCase, verdict: "unparseable-fix", latencyMs, checks, analysis };
  }

  const after = await deps.verifier.check(analysis.fixCode, evalCase.ruleId);
  if (after !== "passes") {
    return {
      case: evalCase,
      verdict: "not-resolved",
      latencyMs,
      checks,
      analysis,
      detail:
        after === "rule-not-run" ? "the fix removed everything the rule applies to" : undefined,
    };
  }

  // Passing the oracle is necessary but not sufficient: a fix that deleted the
  // element also passes. That is the one way this measurement could lie — except
  // for the handful of rules where deletion genuinely is the fix.
  if (!checks.preservesSubject && !evalCase.allowsRemoval) {
    return {
      case: evalCase,
      verdict: "degenerate",
      latencyMs,
      checks,
      analysis,
      detail: `the fix no longer contains <${evalCase.subjectTag ?? "the offending element"}>`,
    };
  }

  return { case: evalCase, verdict: "resolved", latencyMs, checks, analysis };
}

export async function runEval(deps: EvalDeps): Promise<CaseResult[]> {
  const cases = deps.cases ?? EVAL_CASES;
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runCase(evalCase, deps));
  }
  return results;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface Scoreboard {
  total: number;
  scored: number;
  counts: Record<CaseVerdict, number>;
  /** Share of *scorable* cases resolved. Broken cases are excluded, not counted as failures. */
  resolvedRate: number;
  latencyP50: number;
  latencyP95: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function summarise(results: CaseResult[]): Scoreboard {
  const counts: Record<CaseVerdict, number> = {
    resolved: 0,
    "not-resolved": 0,
    degenerate: 0,
    "unparseable-fix": 0,
    "llm-error": 0,
    "broken-case": 0,
  };
  for (const r of results) counts[r.verdict]++;

  const scored = results.length - counts["broken-case"];
  const latencies = results
    .filter((r) => r.verdict !== "broken-case")
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);

  return {
    total: results.length,
    scored,
    counts,
    resolvedRate: scored === 0 ? 0 : counts.resolved / scored,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
  };
}

const VERDICT_MARK: Record<CaseVerdict, string> = {
  resolved: "PASS",
  "not-resolved": "FAIL",
  degenerate: "GAMED",
  "unparseable-fix": "BADFIX",
  "llm-error": "ERROR",
  "broken-case": "BROKEN",
};

export function formatReport(results: CaseResult[], scoreboard: Scoreboard): string {
  const lines: string[] = [];
  const width = Math.max(...results.map((r) => r.case.id.length));

  for (const r of results) {
    const mark = VERDICT_MARK[r.verdict].padEnd(6);
    const ms = r.latencyMs ? `${String(r.latencyMs).padStart(6)}ms` : "        ";
    lines.push(`  ${mark} ${r.case.id.padEnd(width)} ${ms}${r.detail ? `  — ${r.detail}` : ""}`);
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  lines.push("");
  lines.push(
    `  resolved      ${scoreboard.counts.resolved}/${scoreboard.scored}  ${pct(scoreboard.resolvedRate)}`,
  );
  for (const verdict of ["not-resolved", "degenerate", "unparseable-fix", "llm-error"] as const) {
    if (scoreboard.counts[verdict] > 0) {
      lines.push(`  ${verdict.padEnd(14)}${scoreboard.counts[verdict]}`);
    }
  }
  if (scoreboard.counts["broken-case"] > 0) {
    lines.push(
      `  broken cases  ${scoreboard.counts["broken-case"]}  (excluded from the rate — fix the dataset)`,
    );
  }
  lines.push(`  latency       p50 ${scoreboard.latencyP50}ms   p95 ${scoreboard.latencyP95}ms`);
  return lines.join("\n");
}
