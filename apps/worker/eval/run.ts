import { addUsage, type LlmClient, type TokenUsage } from "@ally-fix/llm";
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
  /** Tokens the case consumed, retries included. Null when the provider is silent. */
  usage?: TokenUsage | null;
  costUsd?: number | null;
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
  let usage: TokenUsage | null;
  let costUsd: number | null;
  try {
    const result = await deps.client.analyzeIssueGroup({
      ruleId: evalCase.ruleId,
      htmlSnippets: [evalCase.html],
    });
    analysis = result.analysis;
    usage = result.usage;
    costUsd = result.costUsd;
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
    return {
      case: evalCase,
      verdict: "unparseable-fix",
      latencyMs,
      usage,
      costUsd,
      checks,
      analysis,
    };
  }

  const after = await deps.verifier.check(analysis.fixCode, evalCase.ruleId);
  if (after !== "passes") {
    return {
      case: evalCase,
      verdict: "not-resolved",
      latencyMs,
      usage,
      costUsd,
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
      usage,
      costUsd,
      checks,
      analysis,
      detail: `the fix no longer contains <${evalCase.subjectTag ?? "the offending element"}>`,
    };
  }

  return { case: evalCase, verdict: "resolved", latencyMs, usage, costUsd, checks, analysis };
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
  /** Tokens the whole run spent, retries included. Null when nothing reported any. */
  usage: TokenUsage | null;
  /** Null when the model has no configured rate — never a zero standing in for it. */
  costUsd: number | null;
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

  const usage = results.reduce<TokenUsage | null>(
    (total, result) => addUsage(total, result.usage ?? null),
    null,
  );
  // Summed rather than recomputed from a rate, so a run that mixes priced and
  // unpriced calls cannot report the unpriced half as free.
  const priced = results.filter((result) => typeof result.costUsd === "number");
  const costUsd =
    priced.length === 0 ? null : priced.reduce((total, r) => total + (r.costUsd ?? 0), 0);

  return {
    total: results.length,
    scored,
    counts,
    resolvedRate: scored === 0 ? 0 : counts.resolved / scored,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    usage,
    costUsd,
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
  lines.push(`  tokens        ${formatTokens(scoreboard.usage)}`);
  lines.push(`  cost          ${formatCost(scoreboard.costUsd)}`);
  return lines.join("\n");
}

export function formatTokens(usage: TokenUsage | null): string {
  if (usage === null) return "not reported by this provider";
  return `${usage.totalTokens} (in ${usage.inputTokens}, out ${usage.outputTokens})`;
}

/**
 * "no rate configured" rather than "$0.00". A run whose price is unknown must
 * not read as a run that was free — that is the whole reason cost is nullable.
 */
export function formatCost(costUsd: number | null): string {
  return costUsd === null
    ? "no rate configured (set LLM_PRICE_*_PER_MTOK)"
    : `$${costUsd.toFixed(4)}`;
}

// ── Comparing two prompts ────────────────────────────────────────────────────

/**
 * A/B support, for questions of the form "is this prompt change worth keeping?".
 *
 * The model is not deterministic, so one run of one arm is an anecdote. Every
 * arm here is a set of repeats and the report shows each run's rate, not just
 * the pooled one: a 5-point difference between arms means nothing if the runs
 * within an arm already spread that far. Small honest error bars beat a
 * confident single number.
 */
export interface ArmStats {
  label: string;
  repeats: number;
  /** Pooled resolved / scored across every repeat. */
  resolvedRate: number;
  /** Each repeat's own rate, so the spread within an arm is visible. */
  perRunRate: number[];
  counts: Record<CaseVerdict, number>;
  latencyP50: number;
  /** Case id → how many repeats resolved it. */
  resolvedByCase: Map<string, number>;
  /** Tokens the whole arm spent, across every repeat. */
  usage: TokenUsage | null;
  costUsd: number | null;
  /** Mean input tokens per scored call — the size of the prompt, in practice. */
  inputTokensPerCall: number | null;
}

export function summariseArm(label: string, runs: CaseResult[][]): ArmStats {
  const boards = runs.map(summarise);
  const resolved = boards.reduce((sum, board) => sum + board.counts.resolved, 0);
  const scored = boards.reduce((sum, board) => sum + board.scored, 0);

  const counts = boards.reduce<Record<CaseVerdict, number>>(
    (acc, board) => {
      for (const [verdict, n] of Object.entries(board.counts)) {
        acc[verdict as CaseVerdict] += n;
      }
      return acc;
    },
    {
      resolved: 0,
      "not-resolved": 0,
      degenerate: 0,
      "unparseable-fix": 0,
      "llm-error": 0,
      "broken-case": 0,
    },
  );

  const resolvedByCase = new Map<string, number>();
  for (const run of runs) {
    for (const result of run) {
      const previous = resolvedByCase.get(result.case.id) ?? 0;
      resolvedByCase.set(result.case.id, previous + (result.verdict === "resolved" ? 1 : 0));
    }
  }

  const latencies = runs
    .flat()
    .filter((r) => r.verdict !== "broken-case")
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);

  const usage = boards.reduce<TokenUsage | null>(
    (total, board) => addUsage(total, board.usage),
    null,
  );
  const pricedBoards = boards.filter((board) => typeof board.costUsd === "number");
  const costUsd =
    pricedBoards.length === 0
      ? null
      : pricedBoards.reduce((total, board) => total + (board.costUsd ?? 0), 0);

  const calls = runs.flat().filter((result) => result.usage != null).length;

  return {
    label,
    repeats: runs.length,
    resolvedRate: scored === 0 ? 0 : resolved / scored,
    perRunRate: boards.map((board) => board.resolvedRate),
    counts,
    latencyP50: percentile(latencies, 50),
    resolvedByCase,
    usage,
    costUsd,
    inputTokensPerCall: usage === null || calls === 0 ? null : usage.inputTokens / calls,
  };
}

export interface Comparison {
  baseline: ArmStats;
  candidate: ArmStats;
  /** candidate rate minus baseline rate, in percentage points of the [0,1] rate. */
  delta: number;
  /** Cases the candidate resolved more often than the baseline. */
  gained: string[];
  /** Cases the candidate resolved less often — the regressions a headline rate hides. */
  lost: string[];
  /**
   * Extra input tokens the candidate's prompt costs per call, as a fraction.
   * Null when either arm's provider reported no usage.
   */
  inputTokenOverhead: number | null;
}

export function compareArms(baseline: ArmStats, candidate: ArmStats): Comparison {
  const gained: string[] = [];
  const lost: string[] = [];

  for (const [id, candidateWins] of candidate.resolvedByCase) {
    const baselineWins = baseline.resolvedByCase.get(id);
    if (baselineWins === undefined) continue; // Not run in both arms; not comparable.
    if (candidateWins > baselineWins) gained.push(id);
    else if (candidateWins < baselineWins) lost.push(id);
  }

  const base = baseline.inputTokensPerCall;
  const cand = candidate.inputTokensPerCall;

  return {
    baseline,
    candidate,
    delta: candidate.resolvedRate - baseline.resolvedRate,
    gained: gained.sort(),
    lost: lost.sort(),
    // What the candidate prompt costs, so the delta can be read as a trade
    // rather than as a free win. A prompt change always has a price.
    inputTokenOverhead: base === null || cand === null || base === 0 ? null : cand / base - 1,
  };
}

export function formatComparison(comparison: Comparison): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  // The variable-width field goes last so the columns before it line up.
  const arm = (stats: ArmStats) =>
    `  ${stats.label.padEnd(12)} ${pct(stats.resolvedRate).padStart(6)}` +
    `   p50 ${`${stats.latencyP50}ms`.padEnd(7)}` +
    `   in/call ${(stats.inputTokensPerCall === null
      ? "n/a"
      : String(Math.round(stats.inputTokensPerCall))
    ).padStart(5)}` +
    `   ${formatCost(stats.costUsd).padEnd(10)}` +
    `   runs: ${stats.perRunRate.map(pct).join(", ")}`;

  const lines = [arm(comparison.baseline), arm(comparison.candidate), ""];

  const sign = comparison.delta >= 0 ? "+" : "";
  lines.push(`  delta        ${sign}${(comparison.delta * 100).toFixed(1)} points`);
  if (comparison.inputTokenOverhead !== null) {
    // Printed next to the delta on purpose: the question is never "did it help?"
    // but "did it help enough to be worth what it costs?".
    const overhead = comparison.inputTokenOverhead * 100;
    lines.push(`  input tokens ${overhead >= 0 ? "+" : ""}${overhead.toFixed(1)}% per call`);
  }

  if (comparison.gained.length > 0) lines.push(`  gained       ${comparison.gained.join(", ")}`);
  // Regressions are printed even when the headline moved the right way. A prompt
  // that trades three rules for four is not the same as one that only adds.
  if (comparison.lost.length > 0) lines.push(`  lost         ${comparison.lost.join(", ")}`);
  if (comparison.gained.length === 0 && comparison.lost.length === 0) {
    lines.push("  no case changed verdict between the two arms");
  }

  const repeats = Math.min(comparison.baseline.repeats, comparison.candidate.repeats);
  if (repeats < 3) {
    lines.push("");
    lines.push(
      `  Read with care: ${repeats} repeat(s) per arm. Sampling noise alone moves this` +
        " number, so treat a small delta as unmeasured rather than as no effect.",
    );
  }
  return lines.join("\n");
}
