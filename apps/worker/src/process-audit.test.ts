import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmConfig } from "@ally-fix/llm";
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

const AUDIT_ID = "3f1a9c22-7b4e-4d51-9a2c-8e6f0b1d4a77";
const config: LlmConfig = { provider: "ollama", model: "llama3.1" };

const analysis = {
  explanation: "x",
  affectedUsers: ["screen reader users"],
  fixCode: "<img alt>",
  priority: "high" as const,
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

function build(overrides: Partial<ProcessAuditDeps> = {}) {
  const scan = vi.fn<ProcessAuditDeps["scan"]>().mockResolvedValue([]);
  const llmClient: LlmClient = { analyzeIssueGroup: vi.fn().mockResolvedValue(analysis) };
  const deps: ProcessAuditDeps = {
    db: {} as ProcessAuditDeps["db"],
    cacheRedis: fakeRedis(),
    llmConfig: config,
    llmClient,
    scanTimeoutMs: 30_000,
    cacheTtlSeconds: 3600,
    scan,
    ...overrides,
  };
  // Return the deps actually in use, not the locals — an override must be what
  // assertions see.
  return {
    process: createAuditProcessor(deps),
    scan: deps.scan as ReturnType<typeof vi.fn>,
    llmClient: deps.llmClient,
    deps,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [markAuditRunning, insertIssues, completeAudit, failAudit, setAnalysisForRule]) {
    fn.mockResolvedValue(undefined);
  }
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
      analyzeIssueGroup: vi.fn(async () => {
        order.push("analyze");
        return analysis;
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

  it("fails the audit when the database write fails, not just the scan", async () => {
    insertIssues.mockRejectedValue(new Error('relation "issues" does not exist'));
    const { process } = build({ scan: vi.fn().mockResolvedValue([issue("a", "minor")]) });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow();

    expect(failAudit).toHaveBeenCalled();
  });
});
