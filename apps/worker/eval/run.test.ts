import { describe, expect, it, vi } from "vitest";
import type { LlmIssueAnalysis } from "@ally-fix/shared";
import type { EvalCase } from "./cases";
import { formatReport, runCase, runEval, summarise, type CaseResult, type EvalDeps } from "./run";
import type { AxeVerifier, RuleOutcome } from "./verify";

const IMAGE_CASE: EvalCase = {
  id: "image-alt/missing",
  ruleId: "image-alt",
  html: '<img src="/cat.png">',
  expectation: "adds a descriptive alt attribute",
};

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
      analyzeIssueGroup: vi.fn().mockResolvedValue(analysis('<img src="/cat.png" alt="A cat">')),
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
        client: { analyzeIssueGroup: vi.fn().mockResolvedValue(analysis("<div></div>")) },
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
        client: { analyzeIssueGroup: vi.fn().mockResolvedValue(analysis("<div></div>")) },
      }),
    );

    expect(result.verdict).toBe("resolved");
  });

  it("separates a fix that isn't HTML from a fix that didn't work", async () => {
    const result = await runCase(
      IMAGE_CASE,
      deps({
        verifier: fakeVerifier("violates"),
        client: { analyzeIssueGroup: vi.fn().mockResolvedValue(analysis("Add an alt attribute.")) },
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
