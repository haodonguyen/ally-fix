import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmAnalysisResult, LlmClient, LlmConfig } from "@ally-fix/llm";
import type IORedis from "ioredis";

const { markAuditRunning, insertIssues, completeAudit, failAudit, setAnalysisForRule } = vi.hoisted(
  () => ({
    markAuditRunning: vi.fn(),
    insertIssues: vi.fn(),
    completeAudit: vi.fn(),
    failAudit: vi.fn(),
    setAnalysisForRule: vi.fn(),
  }),
);

vi.mock("@ally-fix/db", () => ({
  markAuditRunning,
  insertIssues,
  completeAudit,
  failAudit,
  setAnalysisForRule,
}));

import { createAuditProcessor, type ProcessAuditDeps } from "./process-audit";
import type { ScannedIssue } from "./scanner";
import { createFakeLogger, type CapturedLogger } from "./testing/fake-logger";

const AUDIT_ID = "3f1a9c22-7b4e-4d51-9a2c-8e6f0b1d4a77";
const config: LlmConfig = { provider: "ollama", model: "llama3.1" };

const analysis = {
  explanation: "x",
  affectedUsers: ["screen reader users"],
  fixCode: "<img alt>",
  priority: "high" as const,
};

/** What the client hands back: the analysis plus what it cost to get. */
const analysisResult: LlmAnalysisResult = {
  analysis,
  usage: { inputTokens: 900, outputTokens: 120, reasoningTokens: 0, totalTokens: 1020 },
  costUsd: 0,
  attempts: 1,
};

function issue(ruleId: string, impact: ScannedIssue["impact"]): ScannedIssue {
  return {
    ruleId,
    wcagCriteria: "1.1.1",
    wcagLevel: "A",
    impact,
    htmlSnippet: `<${ruleId}>`,
    selector: ruleId,
    rawAxe: {},
  };
}

function fakeRedis() {
  return { get: vi.fn(async () => null), set: vi.fn(async () => "OK") } as unknown as IORedis;
}

let clock = 0;

function build(overrides: Partial<ProcessAuditDeps> = {}) {
  const scan = vi.fn<ProcessAuditDeps["scan"]>().mockResolvedValue([]);
  const llmClient: LlmClient = {
    promptFingerprint: "test",
    analyzeIssueGroup: vi.fn().mockResolvedValue(analysisResult),
  };
  const captured: CapturedLogger = createFakeLogger();
  const deps: ProcessAuditDeps = {
    db: {} as ProcessAuditDeps["db"],
    cacheRedis: fakeRedis(),
    llmConfig: config,
    llmClient,
    scanTimeoutMs: 30_000,
    cacheTtlSeconds: 3600,
    scan,
    logger: captured.logger,
    // A clock that advances 10ms per read, so durations are deterministic.
    now: () => (clock += 10),
    ...overrides,
  };
  // Return the deps actually in use, not the locals — an override must be what
  // assertions see.
  return {
    process: createAuditProcessor(deps),
    scan: deps.scan as ReturnType<typeof vi.fn>,
    llmClient: deps.llmClient,
    captured,
    deps,
  };
}

beforeEach(() => {
  clock = 0;
  vi.clearAllMocks();
  for (const fn of [markAuditRunning, insertIssues, completeAudit, failAudit, setAnalysisForRule]) {
    fn.mockResolvedValue(undefined);
  }
});

describe("malformed jobs", () => {
  it.each([
    ["a non-uuid auditId", { auditId: "nope", url: "https://example.com" }],
    ["a missing url", { auditId: AUDIT_ID }],
    ["a non-url url", { auditId: AUDIT_ID, url: "not a url" }],
    ["an empty object", {}],
    ["null", null],
    ["a string", "scan example.com"],
  ])("discards %s without throwing", async (_label, data) => {
    const { process, scan } = build();

    // Throwing here would make BullMQ retry a job that can never succeed, and
    // there is no audit row to mark failed — we cannot even read its id.
    await expect(process({ id: "j-1", data })).resolves.toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
    expect(failAudit).not.toHaveBeenCalled();
  });
});

describe("the happy path", () => {
  it("runs the pipeline in order and completes with a score", async () => {
    const scanned = [issue("image-alt", "critical"), issue("label", "minor")];
    const { process, scan } = build({ scan: vi.fn().mockResolvedValue(scanned) });

    await process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } });

    expect(markAuditRunning).toHaveBeenCalledWith(expect.anything(), AUDIT_ID);
    expect(scan).toHaveBeenCalledWith("https://example.com", 30_000);
    expect(completeAudit).toHaveBeenCalledWith(expect.anything(), AUDIT_ID, {
      score: expect.any(Number),
    });
    expect(failAudit).not.toHaveBeenCalled();
  });

  it("stores every scanned issue tagged with its audit id", async () => {
    const scanned = [issue("image-alt", "critical"), issue("label", "minor")];
    const { process } = build({ scan: vi.fn().mockResolvedValue(scanned) });

    await process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } });

    const rows = insertIssues.mock.calls[0]?.[1] as Array<{ auditId: string; ruleId: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.auditId === AUDIT_ID)).toBe(true);
  });

  it("stores the issues before analysing them", async () => {
    // The ordering is the whole basis of the best-effort contract (ADR-0004):
    // the raw results must already be durable when the LLM is first called.
    const order: string[] = [];
    insertIssues.mockImplementation(async () => void order.push("insert"));
    const llmClient: LlmClient = {
      promptFingerprint: "test",
      analyzeIssueGroup: vi.fn(async () => {
        order.push("analyze");
        return analysisResult;
      }),
    };
    const { process } = build({
      scan: vi.fn().mockResolvedValue([issue("image-alt", "critical")]),
      llmClient,
    });

    await process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } });

    expect(order).toEqual(["insert", "analyze"]);
  });

  it("scores a clean page 100 and still completes it", async () => {
    const { process } = build({ scan: vi.fn().mockResolvedValue([]) });

    await process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } });

    expect(completeAudit).toHaveBeenCalledWith(expect.anything(), AUDIT_ID, { score: 100 });
  });

  it("weights the score by severity", async () => {
    const critical = build({ scan: vi.fn().mockResolvedValue([issue("a", "critical")]) });
    await critical.process({ id: "j", data: { auditId: AUDIT_ID, url: "https://example.com" } });
    const criticalScore = completeAudit.mock.calls[0]?.[2] as { score: number };

    vi.clearAllMocks();
    completeAudit.mockResolvedValue(undefined);

    const minor = build({ scan: vi.fn().mockResolvedValue([issue("a", "minor")]) });
    await minor.process({ id: "j", data: { auditId: AUDIT_ID, url: "https://example.com" } });
    const minorScore = completeAudit.mock.calls[0]?.[2] as { score: number };

    expect(criticalScore.score).toBeLessThan(minorScore.score);
  });
});

describe("the best-effort contract", () => {
  it("completes the audit even when every LLM call fails", async () => {
    const llmClient: LlmClient = {
      promptFingerprint: "test",
      analyzeIssueGroup: vi.fn().mockRejectedValue(new Error("no provider reachable")),
    };
    const { process } = build({
      scan: vi.fn().mockResolvedValue([issue("image-alt", "critical")]),
      llmClient,
    });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).resolves.toBeUndefined();

    expect(insertIssues).toHaveBeenCalled();
    expect(completeAudit).toHaveBeenCalled();
    expect(failAudit).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("marks the audit failed and rethrows so BullMQ records it", async () => {
    const { process } = build({ scan: vi.fn().mockRejectedValue(new Error("page crashed")) });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow("page crashed");

    expect(failAudit).toHaveBeenCalledWith(expect.anything(), AUDIT_ID, expect.any(String));
    expect(completeAudit).not.toHaveBeenCalled();
  });

  it("never writes raw exception text into the public report", async () => {
    const { process } = build({
      scan: vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED postgres.internal:5432 /app/secret")),
    });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow();

    const stored = failAudit.mock.calls[0]?.[2] as string;
    expect(stored).not.toContain("postgres.internal");
    expect(stored).not.toContain("/app/secret");
  });

  it("translates an SSRF refusal into the disallowed-address reason", async () => {
    const { process } = build({
      scan: vi.fn().mockRejectedValue(new Error("Refusing to scan unsafe URL: 10.0.0.1")),
    });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow();

    expect(failAudit.mock.calls[0]?.[2]).toContain("disallowed address");
  });

  it("rethrows the original cause when recording the failure also fails", async () => {
    // The status write hits the same database that just went down, so it rejects
    // too. Its rejection must not replace the real error: BullMQ would then
    // record "db unavailable" for a job that actually failed on the page.
    failAudit.mockRejectedValue(new Error("db unavailable"));
    const { process } = build({ scan: vi.fn().mockRejectedValue(new Error("page crashed")) });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow("page crashed");

    expect(failAudit).toHaveBeenCalled();
  });

  it("fails the audit when the database write fails, not just the scan", async () => {
    insertIssues.mockRejectedValue(new Error('relation "issues" does not exist'));
    const { process } = build({ scan: vi.fn().mockResolvedValue([issue("a", "minor")]) });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow();

    expect(failAudit).toHaveBeenCalled();
  });
});

describe("what the logs say", () => {
  it("tags every line with the audit, so one scan can be traced end to end", async () => {
    const { process, captured } = build({
      scan: vi.fn().mockResolvedValue([issue("image-alt", "critical")]),
    });

    await process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } });

    // This is the whole point: "what happened to THIS audit?" must be answerable
    // by filtering on one field.
    const correlated = captured.records.filter((r) => r.auditId === AUDIT_ID);
    expect(correlated.length).toBeGreaterThanOrEqual(4);
    expect(correlated.map((r) => r.msg)).toEqual(
      expect.arrayContaining([
        "scan started",
        "scan finished",
        "analysis finished",
        "audit completed",
      ]),
    );
  });

  it("records timings and outcome, not just that something happened", async () => {
    const { process, captured } = build({
      scan: vi.fn().mockResolvedValue([issue("image-alt", "critical"), issue("label", "minor")]),
    });

    await process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } });

    expect(captured.first("scan finished")).toMatchObject({
      issues: 2,
      scanMs: expect.any(Number),
    });
    expect(captured.first("audit completed")).toMatchObject({
      score: expect.any(Number),
      issues: 2,
      totalMs: expect.any(Number),
    });
  });

  it("reports which provider and model did the analysis", async () => {
    const { process, captured } = build({
      scan: vi.fn().mockResolvedValue([issue("image-alt", "critical")]),
    });

    await process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } });

    expect(captured.first("analysis finished")).toMatchObject({
      provider: "ollama",
      model: "llama3.1",
      analyzed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("logs the full error even though the stored reason is generic", async () => {
    const { process, captured } = build({
      scan: vi.fn().mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED at nowhere.example")),
    });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow();

    // The public report gets a generic sentence; the logs must keep the detail
    // that makes the failure diagnosable.
    const logged = captured.first("audit failed");
    expect(logged).toMatchObject({ auditId: AUDIT_ID, level: "error" });
    expect((logged?.err as { message: string }).message).toContain("ERR_NAME_NOT_RESOLVED");
    expect(failAudit.mock.calls[0]?.[2]).not.toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("names a malformed job without inventing an audit id it does not have", async () => {
    const { process, captured } = build();

    await process({ id: "j-9", data: { nonsense: true } });

    const logged = captured.first("discarding malformed job");
    expect(logged).toMatchObject({ jobId: "j-9", level: "error" });
    expect(logged).not.toHaveProperty("auditId");
  });
});
