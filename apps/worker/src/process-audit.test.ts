import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmAnalysisResult, LlmClient, LlmConfig } from "@ally-fix/llm";
import { SpanKind, injectTraceContext, traceLogFields, withSpan } from "@ally-fix/telemetry";
import { captureMetrics, captureSpans } from "@ally-fix/telemetry/testing";
import { SpanStatusCode } from "@opentelemetry/api";
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
import { createAuditMetrics } from "./telemetry";
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

const spans = captureSpans();
afterAll(() => spans.stop());

beforeEach(() => {
  spans.reset();
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

describe("what the trace says", () => {
  const job = { id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } };

  it("opens a consumer span for the job, with scan and analysis beneath it", async () => {
    const { process } = build({
      scan: vi.fn().mockResolvedValue([issue("image-alt", "critical")]),
    });

    await process(job);

    const consumer = spans.span("process audit-scan");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.attributes).toMatchObject({
      "messaging.system": "bullmq",
      "messaging.destination.name": "audit-scan",
      "messaging.operation": "process",
      "messaging.message.id": "j-1",
      "allyfix.audit.id": AUDIT_ID,
      "allyfix.audit.issues": 1,
      "url.full": "https://example.com",
    });
    expect(consumer.attributes["allyfix.audit.score"]).toEqual(expect.any(Number));
    for (const child of ["audit.scan", "audit.analyze"]) {
      expect(spans.span(child).parentSpanContext?.spanId).toBe(consumer.spanContext().spanId);
    }
    expect(spans.span("audit.scan").attributes["allyfix.scan.issues"]).toBe(1);
    expect(spans.span("audit.analyze").attributes).toMatchObject({
      "allyfix.llm.analyzed": 1,
      "allyfix.llm.failed": 0,
    });
  });

  it("joins the trace of the request that enqueued the job", async () => {
    let carrier: Record<string, string> = {};
    await withSpan("POST /api/audits", { kind: SpanKind.SERVER }, async () => {
      carrier = injectTraceContext();
    });
    const { process } = build();

    await process({ ...job, data: { ...job.data, trace: carrier } });

    const web = spans.span("POST /api/audits");
    const consumer = spans.span("process audit-scan");
    expect(consumer.spanContext().traceId).toBe(web.spanContext().traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(web.spanContext().spanId);
  });

  it("starts a trace of its own for a job with no context", async () => {
    const { process } = build();
    await process(job);
    expect(spans.span("process audit-scan").parentSpanContext).toBeUndefined();
  });

  it("marks the span failed with the original error when the audit fails", async () => {
    const { process } = build({ scan: vi.fn().mockRejectedValue(new Error("net::ERR_TIMED_OUT")) });

    await expect(process(job)).rejects.toThrow("net::ERR_TIMED_OUT");

    const consumer = spans.span("process audit-scan");
    expect(consumer.status).toEqual({ code: SpanStatusCode.ERROR, message: "net::ERR_TIMED_OUT" });
    expect(spans.span("audit.scan").status.code).toBe(SpanStatusCode.ERROR);
  });

  it("stamps each log line with the trace it was written in", async () => {
    // The production logger's hook (see logger.ts).
    const captured = createFakeLogger({ context: traceLogFields });
    const { process } = build({ logger: captured.logger });

    await process(job);

    const consumer = spans.span("process audit-scan");
    expect(captured.first("scan started")).toMatchObject({
      "trace.id": consumer.spanContext().traceId,
      "span.id": consumer.spanContext().spanId,
    });
    // Written inside the scan span, so it points at that span instead.
    expect(captured.first("scan finished")?.["span.id"]).toBe(
      spans.span("audit.scan").spanContext().spanId,
    );
  });

  it("records nothing for a malformed job, which has no audit to trace", async () => {
    const { process } = build();
    await process({ id: "j-9", data: { nonsense: true } });
    expect(spans.spans()).toEqual([]);
  });
});

describe("what the metrics say", () => {
  it("records queue wait, scan, analysis outcomes and the audit's duration", async () => {
    const { meter, points } = captureMetrics();
    const { process } = build({
      metrics: createAuditMetrics(meter),
      scan: vi.fn().mockResolvedValue([issue("image-alt", "critical"), issue("label", "minor")]),
    });
    clock = 5_000;

    await process({
      id: "j-1",
      timestamp: 2_000,
      data: { auditId: AUDIT_ID, url: "https://example.com" },
    });

    // The first clock read is 5010; the job was enqueued at 2000.
    expect((await points("allyfix.audit.queue_wait"))[0]?.value).toEqual({ count: 1, sum: 3.01 });
    expect((await points("allyfix.scan.issues"))[0]?.value).toEqual({ count: 1, sum: 2 });
    expect(await points("allyfix.llm.rule_groups")).toEqual([
      { attributes: { "allyfix.llm.outcome": "generated" }, value: 2 },
    ]);
    expect(await points("allyfix.audit.duration")).toEqual([
      { attributes: { "allyfix.audit.outcome": "completed" }, value: expect.anything() },
    ]);
  });

  it("records a failed audit's duration under its own outcome", async () => {
    const { meter, points } = captureMetrics();
    const { process } = build({
      metrics: createAuditMetrics(meter),
      scan: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await expect(
      process({ id: "j-1", data: { auditId: AUDIT_ID, url: "https://example.com" } }),
    ).rejects.toThrow();

    const durations = await points("allyfix.audit.duration");
    expect(durations.map((p) => p.attributes["allyfix.audit.outcome"])).toEqual(["failed"]);
    // No timestamp on the job, so no wait is invented for it.
    expect(await points("allyfix.audit.queue_wait")).toEqual([]);
  });
});
