import { beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitOpenError, LlmAnalysisError, type LlmClient, type LlmConfig } from "@ally-fix/llm";
import type IORedis from "ioredis";

const { setAnalysisForRule } = vi.hoisted(() => ({ setAnalysisForRule: vi.fn() }));
vi.mock("@ally-fix/db", () => ({ setAnalysisForRule }));

import { analyzeAudit, type AnalyzeDeps } from "./analyze";
import type { ScannedIssue } from "./scanner";

const config: LlmConfig = { provider: "ollama", model: "llama3.1" };

const analysis = {
  explanation: "Images need alternative text.",
  affectedUsers: ["screen reader users"],
  fixCode: '<img alt="A cat">',
  priority: "high" as const,
};

function issue(ruleId: string, htmlSnippet: string): ScannedIssue {
  return {
    ruleId,
    wcagCriteria: "1.1.1",
    wcagLevel: "A",
    impact: "critical",
    htmlSnippet,
    selector: "img",
    rawAxe: {},
  };
}

/** In-memory stand-in for the two Redis commands the cache uses. */
function fakeRedis(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
  };
}

function deps(overrides: Partial<AnalyzeDeps> & { client: LlmClient }): AnalyzeDeps {
  return {
    db: {} as AnalyzeDeps["db"],
    redis: fakeRedis() as unknown as IORedis,
    config,
    cacheTtlSeconds: 3600,
    ...overrides,
  };
}

function clientReturning(
  value = analysis,
): LlmClient & { analyzeIssueGroup: ReturnType<typeof vi.fn> } {
  return { analyzeIssueGroup: vi.fn().mockResolvedValue(value) } as never;
}

beforeEach(() => {
  setAnalysisForRule.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("analyzeAudit — batching", () => {
  it("makes one call per rule, not one per issue", async () => {
    const client = clientReturning();
    const issues = [
      issue("image-alt", "<img src=1>"),
      issue("image-alt", "<img src=2>"),
      issue("image-alt", "<img src=3>"),
      issue("label", "<input>"),
    ];

    const result = await analyzeAudit("audit-1", issues, deps({ client }));

    expect(client.analyzeIssueGroup).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ analyzed: 2, failed: 0, skipped: 0 });
  });

  it("caps and deduplicates the snippets it sends", async () => {
    const client = clientReturning();
    const issues = [
      issue("image-alt", "<img src=1>"),
      issue("image-alt", "<img src=1>"), // duplicate markup
      issue("image-alt", "<img src=2>"),
      issue("image-alt", "<img src=3>"),
      issue("image-alt", "<img src=4>"), // beyond the cap
    ];

    await analyzeAudit("audit-1", issues, deps({ client }));

    expect(client.analyzeIssueGroup).toHaveBeenCalledWith({
      ruleId: "image-alt",
      htmlSnippets: ["<img src=1>", "<img src=2>", "<img src=3>"],
    });
  });

  it("writes the analysis onto every issue sharing that rule", async () => {
    const client = clientReturning();

    await analyzeAudit("audit-1", [issue("image-alt", "<img>")], deps({ client }));

    expect(setAnalysisForRule).toHaveBeenCalledWith(
      expect.anything(),
      "audit-1",
      "image-alt",
      analysis,
    );
  });

  it("does nothing when the scan found no issues", async () => {
    const client = clientReturning();

    const result = await analyzeAudit("audit-1", [], deps({ client }));

    expect(client.analyzeIssueGroup).not.toHaveBeenCalled();
    expect(result).toEqual({ analyzed: 0, failed: 0, skipped: 0 });
  });
});

describe("analyzeAudit — caching", () => {
  it("serves a cache hit without calling the model", async () => {
    const client = clientReturning();
    const redis = fakeRedis();
    // Prime the cache by running once, then run again with a fresh client.
    await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client, redis: redis as never }),
    );
    expect(redis.set).toHaveBeenCalledOnce();

    const second = clientReturning();
    await analyzeAudit(
      "audit-2",
      [issue("image-alt", "<img>")],
      deps({ client: second, redis: redis as never }),
    );

    expect(second.analyzeIssueGroup).not.toHaveBeenCalled();
    expect(setAnalysisForRule).toHaveBeenCalledTimes(2); // both audits still get the analysis
  });

  it("caches with the configured TTL", async () => {
    const redis = fakeRedis();

    await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client: clientReturning(), redis: redis as never, cacheTtlSeconds: 60 }),
    );

    expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), "EX", 60);
  });

  it("keeps separate cache entries per provider and model", async () => {
    const redis = fakeRedis();
    const issues = [issue("image-alt", "<img>")];

    await analyzeAudit("a", issues, deps({ client: clientReturning(), redis: redis as never }));
    const groq = clientReturning();
    await analyzeAudit(
      "b",
      issues,
      deps({
        client: groq,
        redis: redis as never,
        config: { provider: "groq", model: "openai/gpt-oss-20b" },
      }),
    );

    // A different model must not inherit the first model's answer.
    expect(groq.analyzeIssueGroup).toHaveBeenCalledOnce();
    expect(redis.store.size).toBe(2);
  });

  it("ignores markup whitespace when keying the cache", async () => {
    const redis = fakeRedis();

    await analyzeAudit(
      "a",
      [issue("image-alt", "<img   src=1>")],
      deps({ client: clientReturning(), redis: redis as never }),
    );
    const second = clientReturning();
    await analyzeAudit(
      "b",
      [issue("image-alt", "<img\n src=1>")],
      deps({ client: second, redis: redis as never }),
    );

    expect(second.analyzeIssueGroup).not.toHaveBeenCalled();
  });

  it("regenerates when the cached entry is not valid JSON", async () => {
    const client = clientReturning();
    const redis = fakeRedis();
    redis.get.mockResolvedValueOnce("{ not json");

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client, redis: redis as never }),
    );

    expect(client.analyzeIssueGroup).toHaveBeenCalledOnce();
    expect(result.analyzed).toBe(1);
  });

  it("regenerates when the cached entry is from an older schema", async () => {
    const client = clientReturning();
    const redis = fakeRedis();
    // A payload that parses as JSON but no longer satisfies the schema.
    redis.get.mockResolvedValueOnce(JSON.stringify({ explanation: "old", priority: "high" }));

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client, redis: redis as never }),
    );

    expect(client.analyzeIssueGroup).toHaveBeenCalledOnce();
    expect(result.analyzed).toBe(1);
  });

  it("degrades to generating when the cache read fails", async () => {
    const client = clientReturning();
    const redis = fakeRedis();
    redis.get.mockRejectedValueOnce(new Error("Redis is down"));

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client, redis: redis as never }),
    );

    expect(result).toEqual({ analyzed: 1, failed: 0, skipped: 0 });
  });

  it("does not lose an answer it already paid for when the cache write fails", async () => {
    const client = clientReturning();
    const redis = fakeRedis();
    redis.set.mockRejectedValueOnce(new Error("Redis is down"));

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client, redis: redis as never }),
    );

    expect(result).toEqual({ analyzed: 1, failed: 0, skipped: 0 });
    expect(setAnalysisForRule).toHaveBeenCalledOnce();
  });
});

describe("analyzeAudit — best-effort contract", () => {
  it("never throws when the LLM fails, so the audit still completes", async () => {
    const client = { analyzeIssueGroup: vi.fn().mockRejectedValue(new Error("no provider")) };

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client: client as never }),
    );

    expect(result).toEqual({ analyzed: 0, failed: 1, skipped: 0 });
    expect(setAnalysisForRule).not.toHaveBeenCalled();
  });

  it("keeps going after one rule fails", async () => {
    const client = {
      analyzeIssueGroup: vi
        .fn()
        .mockRejectedValueOnce(new Error("bad output"))
        .mockResolvedValueOnce(analysis),
    };

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>"), issue("label", "<input>")],
      deps({ client: client as never }),
    );

    expect(result).toEqual({ analyzed: 1, failed: 1, skipped: 0 });
  });

  it("does not fail the audit when writing the analysis to the DB fails", async () => {
    setAnalysisForRule.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>")],
      deps({ client: clientReturning() }),
    );

    expect(result.failed).toBe(1);
  });
});

describe("analyzeAudit — circuit breaker", () => {
  it("abandons the remaining rule groups once the circuit is open", async () => {
    const client = {
      analyzeIssueGroup: vi
        .fn()
        .mockRejectedValueOnce(new LlmAnalysisError(4, new Error("ECONNREFUSED")))
        .mockRejectedValue(new LlmAnalysisError(1, new CircuitOpenError(30_000))),
    };
    const issues = [
      issue("image-alt", "<img>"),
      issue("label", "<input>"),
      issue("color-contrast", "<p>"),
      issue("link-name", "<a>"),
    ];

    const result = await analyzeAudit("audit-1", issues, deps({ client: client as never }));

    // One real failure, then the breaker's first refusal ends the loop —
    // the last two groups are never attempted.
    expect(result).toEqual({ analyzed: 0, failed: 1, skipped: 3 });
    expect(client.analyzeIssueGroup).toHaveBeenCalledTimes(2);
  });

  it("recognises a bare CircuitOpenError as well as a wrapped one", async () => {
    const client = { analyzeIssueGroup: vi.fn().mockRejectedValue(new CircuitOpenError(30_000)) };

    const result = await analyzeAudit(
      "audit-1",
      [issue("image-alt", "<img>"), issue("label", "<input>")],
      deps({ client: client as never }),
    );

    expect(result).toEqual({ analyzed: 0, failed: 0, skipped: 2 });
    expect(client.analyzeIssueGroup).toHaveBeenCalledOnce();
  });
});
