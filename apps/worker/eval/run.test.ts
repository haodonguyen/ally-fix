import { describe, expect, it, vi } from "vitest";
import type { LlmIssueAnalysis } from "@ally-fix/shared";
import type { EvalCase } from "./cases";
import {
  compareArms,
  formatArmTable,
  formatComparison,
  formatCost,
  formatReport,
  formatTokens,
  runCase,
  runEval,
  rankArms,
  resolvedByNobody,
  summarise,
  summariseArm,
  type CaseResult,
  type CaseVerdict,
  type EvalDeps,
} from "./run";
import type { AxeVerifier, RuleOutcome } from "./verify";

const IMAGE_CASE: EvalCase = {
  id: "image-alt/missing",
  ruleId: "image-alt",
  html: '<img src="/cat.png">',
  expectation: "adds a descriptive alt attribute",
};

/** Wraps an analysis in the shape the client returns, with plausible usage. */
function answered(analysis: LlmIssueAnalysis, inputTokens = 900, outputTokens = 120) {
  return {
    analysis,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
    },
    costUsd: 0,
    attempts: 1,
  };
}

function analysis(fixCode: string): LlmIssueAnalysis {
  return {
    explanation: "Screen readers announce nothing for this image.",
    affectedUsers: ["screen reader users"],
    fixCode,
    priority: "high",
  };
}

/** A verifier scripted with the outcome for each call, in order. */
function fakeVerifier(...outcomes: RuleOutcome[]): AxeVerifier & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    check: vi.fn(async (html: string) => {
      calls.push(html);
      return outcomes[i++] ?? "passes";
    }),
    close: vi.fn(async () => undefined),
  };
}

function deps(overrides: Partial<EvalDeps> & Pick<EvalDeps, "verifier">): EvalDeps {
  let t = 0;
  return {
    client: {
      analyzeIssueGroup: vi
        .fn()
        .mockResolvedValue(answered(analysis('<img src="/cat.png" alt="A cat">'))),
    },
    now: () => (t += 40),
    ...overrides,
  };
}

describe("scoring one case", () => {
  it("passes a fix that resolves the rule and keeps the element", async () => {
    const result = await runCase(
      IMAGE_CASE,
      deps({ verifier: fakeVerifier("violates", "passes") }),
    );

    expect(result.verdict).toBe("resolved");
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  it("fails a fix that leaves the rule firing", async () => {
    const result = await runCase(
      IMAGE_CASE,
      deps({ verifier: fakeVerifier("violates", "violates") }),
    );

    expect(result.verdict).toBe("not-resolved");
  });

  it("catches the degenerate fix that deletes the element", async () => {
    // The one way this measurement could lie: axe stops reporting image-alt
    // because there is no image left. It must not score as a pass.
    const result = await runCase(
      IMAGE_CASE,
      deps({
        verifier: fakeVerifier("violates", "passes"),
        client: { analyzeIssueGroup: vi.fn().mockResolvedValue(answered(analysis("<div></div>"))) },
      }),
    );

    expect(result.verdict).toBe("degenerate");
    expect(result.detail).toContain("no longer contains");
  });

  it("allows removal only for cases that opt in", async () => {
    // nested-interactive is fixed by dropping one of the two controls, so the
    // anti-gaming check cannot apply. That hole is opted into per case.
    const removalCase = { ...IMAGE_CASE, allowsRemoval: true };
    const result = await runCase(
      removalCase,
      deps({
        verifier: fakeVerifier("violates", "passes"),
        client: { analyzeIssueGroup: vi.fn().mockResolvedValue(answered(analysis("<div></div>"))) },
      }),
    );

    expect(result.verdict).toBe("resolved");
  });

  it("separates a fix that isn't HTML from a fix that didn't work", async () => {
    const result = await runCase(
      IMAGE_CASE,
      deps({
        verifier: fakeVerifier("violates"),
        client: {
          analyzeIssueGroup: vi.fn().mockResolvedValue(answered(analysis("Add an alt attribute."))),
        },
      }),
    );

    expect(result.verdict).toBe("unparseable-fix");
  });

  it("records a provider failure as its own verdict, not as a wrong answer", async () => {
    const result = await runCase(
      IMAGE_CASE,
      deps({
        verifier: fakeVerifier("violates"),
        client: { analyzeIssueGroup: vi.fn().mockRejectedValue(new Error("provider down")) },
      }),
    );

    expect(result.verdict).toBe("llm-error");
    expect(result.detail).toBe("provider down");
  });
});

describe("the dataset checks itself", () => {
  it("flags a case whose HTML no longer violates its rule", async () => {
    const verifier = fakeVerifier("passes");
    const client = { analyzeIssueGroup: vi.fn() };

    const result = await runCase(IMAGE_CASE, deps({ verifier, client }));

    expect(result.verdict).toBe("broken-case");
    // No point spending a model call on a case that proves nothing.
    expect(client.analyzeIssueGroup).not.toHaveBeenCalled();
  });

  it("flags a rule id axe never ran, rather than calling it a pass", async () => {
    const result = await runCase(
      { ...IMAGE_CASE, ruleId: "image-altt" },
      deps({ verifier: fakeVerifier("rule-not-run") }),
    );

    expect(result.verdict).toBe("broken-case");
    expect(result.detail).toContain("unknown rule id");
  });
});

describe("the scoreboard", () => {
  function results(...verdicts: CaseResult["verdict"][]): CaseResult[] {
    return verdicts.map((verdict, i) => ({
      case: { ...IMAGE_CASE, id: `case-${i}` },
      verdict,
      latencyMs: (i + 1) * 100,
    }));
  }

  it("scores the share of resolvable cases that were resolved", async () => {
    const board = summarise(results("resolved", "resolved", "not-resolved", "degenerate"));

    expect(board.resolvedRate).toBe(0.5);
    expect(board.scored).toBe(4);
  });

  it("excludes broken cases from the rate instead of counting them against the model", () => {
    // A rotted dataset must not look like a model regression — that is how a team
    // spends a week tuning a prompt to fix a typo in a fixture.
    const board = summarise(results("resolved", "broken-case"));

    expect(board.resolvedRate).toBe(1);
    expect(board.scored).toBe(1);
    expect(board.total).toBe(2);
    expect(board.counts["broken-case"]).toBe(1);
  });

  it("reports latency percentiles over the cases that actually ran", () => {
    const board = summarise(results("resolved", "resolved", "not-resolved"));

    expect(board.latencyP50).toBe(200);
    expect(board.latencyP95).toBe(300);
  });

  it("survives an empty run without dividing by zero", () => {
    const board = summarise([]);
    expect(board.resolvedRate).toBe(0);
    expect(board.latencyP50).toBe(0);
  });
});

describe("the report", () => {
  it("names every verdict and says the dataset needs fixing when it does", () => {
    const rows = [
      { case: IMAGE_CASE, verdict: "resolved" as const, latencyMs: 120 },
      { case: { ...IMAGE_CASE, id: "label/x" }, verdict: "degenerate" as const, latencyMs: 90 },
      { case: { ...IMAGE_CASE, id: "list/y" }, verdict: "broken-case" as const, latencyMs: 0 },
    ];

    const text = formatReport(rows, summarise(rows));

    expect(text).toContain("PASS");
    expect(text).toContain("GAMED");
    expect(text).toContain("BROKEN");
    expect(text).toContain("fix the dataset");
    expect(text).toContain("50.0%");
  });
});

describe("runEval", () => {
  it("runs every case and keeps their order", async () => {
    const cases = [IMAGE_CASE, { ...IMAGE_CASE, id: "second" }];
    const all = await runEval(
      deps({ verifier: fakeVerifier("violates", "passes", "violates", "passes"), cases }),
    );

    expect(all.map((r) => r.case.id)).toEqual(["image-alt/missing", "second"]);
  });
});

// ── A/B comparison ───────────────────────────────────────────────────────────

/** A CaseResult with only the fields the arm/comparison maths reads. */
function result(
  id: string,
  verdict: CaseVerdict,
  latencyMs = 100,
  spent: { inputTokens: number; outputTokens: number } | null = null,
): CaseResult {
  const usage =
    spent === null
      ? null
      : {
          ...spent,
          reasoningTokens: 0,
          totalTokens: spent.inputTokens + spent.outputTokens,
        };
  return { case: { ...IMAGE_CASE, id }, verdict, latencyMs, usage, costUsd: null };
}

describe("summariseArm", () => {
  it("pools the rate across repeats and keeps each run's own rate", () => {
    const stats = summariseArm("grounded", [
      [result("a", "resolved"), result("b", "not-resolved")],
      [result("a", "resolved"), result("b", "resolved")],
    ]);

    expect(stats.repeats).toBe(2);
    expect(stats.resolvedRate).toBeCloseTo(3 / 4);
    expect(stats.perRunRate).toEqual([0.5, 1]);
  });

  it("counts how often each case was resolved", () => {
    const stats = summariseArm("x", [
      [result("a", "resolved"), result("b", "degenerate")],
      [result("a", "not-resolved"), result("b", "degenerate")],
    ]);

    expect(stats.resolvedByCase.get("a")).toBe(1);
    expect(stats.resolvedByCase.get("b")).toBe(0);
  });

  it("leaves broken cases out of the rate, as the single-run scoreboard does", () => {
    const stats = summariseArm("x", [[result("a", "resolved"), result("b", "broken-case", 0)]]);
    expect(stats.resolvedRate).toBe(1);
    expect(stats.counts["broken-case"]).toBe(1);
  });
});

describe("compareArms", () => {
  const baseline = summariseArm("ungrounded", [
    [result("a", "not-resolved"), result("b", "resolved"), result("c", "resolved")],
  ]);

  it("reports the delta and which cases moved", () => {
    const candidate = summariseArm("grounded", [
      [result("a", "resolved"), result("b", "not-resolved"), result("c", "resolved")],
    ]);
    const comparison = compareArms(baseline, candidate);

    expect(comparison.delta).toBeCloseTo(0);
    expect(comparison.gained).toEqual(["a"]);
    // The headline is flat, but one rule broke and another was fixed. A rate
    // alone would have called this "no change".
    expect(comparison.lost).toEqual(["b"]);
  });

  it("ignores a case that only one arm ran", () => {
    const candidate = summariseArm("grounded", [
      [result("a", "resolved"), result("b", "resolved"), result("d", "resolved")],
    ]);
    expect(compareArms(baseline, candidate).gained).toEqual(["a"]);
  });

  it("shows a real improvement as a positive delta", () => {
    const candidate = summariseArm("grounded", [
      [result("a", "resolved"), result("b", "resolved"), result("c", "resolved")],
    ]);
    expect(compareArms(baseline, candidate).delta).toBeCloseTo(1 / 3);
  });
});

describe("formatComparison", () => {
  const baseline = summariseArm("ungrounded", [[result("a", "not-resolved")]]);
  const candidate = summariseArm("grounded", [[result("a", "resolved")]]);

  it("warns that a one-repeat comparison is not a measurement", () => {
    const report = formatComparison(compareArms(baseline, candidate));
    expect(report).toContain("Read with care: 1 repeat");
  });

  it("drops the warning once there are enough repeats", () => {
    const many = (verdict: CaseVerdict) =>
      summariseArm(
        "x",
        Array.from({ length: 3 }, () => [result("a", verdict)]),
      );
    const report = formatComparison(compareArms(many("not-resolved"), many("resolved")));
    expect(report).not.toContain("Read with care");
    expect(report).toContain("+100.0 points");
  });

  it("says so plainly when nothing moved", () => {
    const report = formatComparison(compareArms(baseline, baseline));
    expect(report).toContain("no case changed verdict");
  });
});

describe("cost reporting", () => {
  it("adds up what the run spent", async () => {
    const results = await runEval(
      deps({ verifier: fakeVerifier("violates", "passes"), cases: [IMAGE_CASE] }),
    );
    expect(summarise(results).usage?.totalTokens).toBe(1020);
  });

  it("charges nothing for a broken case, which never called the model", async () => {
    const results = await runEval(deps({ verifier: fakeVerifier("passes"), cases: [IMAGE_CASE] }));
    expect(results[0]?.verdict).toBe("broken-case");
    expect(summarise(results).usage).toBeNull();
  });

  it("reports a null cost rather than zero when no rate is configured", () => {
    const board = summarise([result("a", "resolved", 10, { inputTokens: 900, outputTokens: 100 })]);
    expect(board.usage?.totalTokens).toBe(1000);
    expect(board.costUsd).toBeNull();
  });

  it("sums the priced cases rather than re-deriving a total from a rate", () => {
    // A run that mixes priced and unpriced calls must not report the unpriced
    // half as free, and must not throw away the half it does know.
    const priced = { ...result("a", "resolved"), costUsd: 0.002 };
    const unpriced = result("b", "resolved");
    expect(summarise([priced, unpriced]).costUsd).toBeCloseTo(0.002);
  });
});

describe("formatTokens / formatCost", () => {
  it("says a provider reported nothing instead of printing zeroes", () => {
    expect(formatTokens(null)).toContain("not reported");
  });

  it("never prints an unpriced run as $0.00", () => {
    // "$0.00" and "we do not know" are different facts, and only one of them
    // belongs in a sentence about money.
    expect(formatCost(null)).toContain("no rate configured");
    expect(formatCost(0)).toBe("$0.0000");
  });
});

describe("comparing what a prompt costs", () => {
  const cheap = summariseArm("ungrounded", [
    [result("a", "not-resolved", 10, { inputTokens: 200, outputTokens: 100 })],
  ]);
  const rich = summariseArm("grounded", [
    [result("a", "resolved", 10, { inputTokens: 450, outputTokens: 100 })],
  ]);

  it("reports how much bigger the candidate's prompt is", () => {
    const comparison = compareArms(cheap, rich);
    expect(comparison.inputTokenOverhead).toBeCloseTo(1.25);
    expect(formatComparison(comparison)).toContain("+125.0% per call");
  });

  it("stays silent about overhead when a provider reported no usage", () => {
    const silent = summariseArm("ungrounded", [[result("a", "not-resolved")]]);
    const comparison = compareArms(silent, rich);
    expect(comparison.inputTokenOverhead).toBeNull();
    expect(formatComparison(comparison)).not.toContain("per call");
  });

  it("puts the cost of the win next to the win", () => {
    // The question is never "did it help?" but "did it help enough to be worth
    // what it costs?" — so both numbers have to be on screen together.
    const report = formatComparison(compareArms(cheap, rich));
    expect(report).toContain("delta");
    expect(report).toContain("input tokens");
  });
});

describe("comparing many models", () => {
  const arm = (label: string, verdicts: CaseVerdict[], tokens = 400, cost: number | null = null) =>
    summariseArm(label, [
      verdicts.map((verdict, i) => {
        const base = result(`case-${i}`, verdict, 100, { inputTokens: tokens, outputTokens: 100 });
        return cost === null ? base : { ...base, costUsd: cost };
      }),
    ]);

  it("ranks by resolved rate, best first", () => {
    const weak = arm("weak", ["not-resolved", "not-resolved", "resolved"]);
    const strong = arm("strong", ["resolved", "resolved", "resolved"]);

    expect(rankArms([weak, strong]).map((a) => a.label)).toEqual(["strong", "weak"]);
  });

  it("divides cost by fixes to give a price per fix", () => {
    // The number an operator decides on: not what the run cost, but what a
    // working answer cost.
    const priced = arm("priced", ["resolved", "resolved", "not-resolved"], 400, 0.001);
    expect(priced.costUsd).toBeCloseTo(0.003);
    expect(priced.costPerResolved).toBeCloseTo(0.0015);
  });

  it("has no price per fix when nothing was resolved", () => {
    expect(arm("useless", ["not-resolved"], 400, 0.001).costPerResolved).toBeNull();
  });

  it("has no price per fix when the model has no rate", () => {
    expect(arm("unpriced", ["resolved"]).costPerResolved).toBeNull();
  });

  it("names the cases no arm resolved", () => {
    const a = arm("a", ["resolved", "not-resolved"]);
    const b = arm("b", ["not-resolved", "not-resolved"]);

    // case-0 was solved by one arm; case-1 by nobody.
    expect(resolvedByNobody([a, b])).toEqual(["case-1"]);
  });

  it("does not count a case an arm never ran as one it failed", () => {
    const a = summariseArm("a", [[result("x", "resolved")]]);
    const b = summariseArm("b", [[result("y", "not-resolved")]]);
    // "x" is absent from b, which is silence, not a failure.
    expect(resolvedByNobody([a, b])).toEqual([]);
  });

  it("shows an unpriced model as n/a, never as the cheapest", () => {
    const table = formatArmTable([
      arm("priced", ["resolved"], 400, 0.002),
      arm("unpriced", ["resolved"]),
    ]);

    expect(table).toContain("n/a");
    expect(table).toContain("No rate configured for: unpriced");
    expect(table).not.toContain("$0.0000");
  });

  it("warns about the cases every model failed", () => {
    const table = formatArmTable([arm("a", ["not-resolved"]), arm("b", ["not-resolved"])]);
    expect(table).toContain("No arm resolved: case-0");
    expect(table).toContain("as likely to be a bad case");
  });

  it("says a single repeat is not a measurement", () => {
    const table = formatArmTable([arm("a", ["resolved"]), arm("b", ["resolved"])]);
    expect(table).toContain("Read with care: 1 repeat");
  });

  it("refuses to let the top row read as the right answer", () => {
    // Local and hosted differ by an order of magnitude in latency and by
    // definition in billing. A sorted table implies a winner; this says otherwise.
    const table = formatArmTable([arm("a", ["resolved"]), arm("b", ["not-resolved"])]);
    expect(table).toContain("pick against your own constraint");
  });

  it("handles being given nothing to compare", () => {
    expect(formatArmTable([])).toContain("no arms");
    expect(resolvedByNobody([])).toEqual([]);
  });
});
