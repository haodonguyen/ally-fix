import { describe, expect, it } from "vitest";
import {
  completeAudit,
  createAudit,
  failAudit,
  getAuditById,
  getIssuesByAudit,
  insertIssues,
  markAuditRunning,
  setAnalysisForRule,
} from "./queries";
import type { Database } from "./client";
import type { NewIssueRow } from "./schema";

/**
 * A chainable stand-in for Drizzle's query builder. Every builder method records
 * its call and returns itself; the object is thenable, so awaiting the end of a
 * chain yields the configured result.
 *
 * These tests deliberately do not assert the generated SQL — that would test
 * Drizzle, not us. They assert the behaviour this module adds on top of it: the
 * empty-list guard, the missing-row guard, and which columns each helper writes.
 */
function fakeDb(result: unknown = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of [
    "insert",
    "values",
    "returning",
    "update",
    "set",
    "where",
    "select",
    "from",
    "limit",
    "orderBy",
  ]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  return { db: builder as unknown as Database, calls };
}

/** The argument passed to the first `.set(...)` in the chain. */
function setPayload(calls: Array<{ method: string; args: unknown[] }>) {
  return calls.find((c) => c.method === "set")?.args[0] as Record<string, unknown>;
}

const analysis = {
  explanation: "x",
  affectedUsers: ["screen reader users"],
  fixCode: "<img alt>",
  priority: "high" as const,
};

describe("createAudit", () => {
  it("returns the inserted row", async () => {
    const row = { id: "a-1", url: "https://example.com/" };
    const { db, calls } = fakeDb([row]);

    await expect(createAudit(db, "https://example.com/")).resolves.toBe(row);
    expect(calls.find((c) => c.method === "values")?.args[0]).toEqual({
      url: "https://example.com/",
    });
  });

  it("throws rather than returning undefined when nothing came back", async () => {
    // Callers immediately read `audit.id`; a silent undefined would surface far
    // from here as a queue job with an undefined auditId.
    const { db } = fakeDb([]);

    await expect(createAudit(db, "https://example.com/")).rejects.toThrow("Failed to create audit");
  });
});

describe("insertIssues", () => {
  it("does not touch the database for an empty list", async () => {
    // A clean page finds zero issues, and `INSERT ... VALUES ()` is a SQL error.
    const { db, calls } = fakeDb();

    await insertIssues(db, []);

    expect(calls).toHaveLength(0);
  });

  it("bulk-inserts a non-empty list in one statement", async () => {
    const rows = [
      { auditId: "a-1", ruleId: "image-alt" },
      { auditId: "a-1", ruleId: "label" },
    ] as NewIssueRow[];
    const { db, calls } = fakeDb();

    await insertIssues(db, rows);

    expect(calls.filter((c) => c.method === "insert")).toHaveLength(1);
    expect(calls.find((c) => c.method === "values")?.args[0]).toBe(rows);
  });
});

describe("status transitions", () => {
  it("marks an audit running without touching completedAt", async () => {
    const { db, calls } = fakeDb();

    await markAuditRunning(db, "a-1");

    expect(setPayload(calls)).toEqual({ status: "running" });
  });

  it("completes with a score and a completion timestamp", async () => {
    const { db, calls } = fakeDb();

    await completeAudit(db, "a-1", { score: 42 });

    const payload = setPayload(calls);
    expect(payload).toMatchObject({ status: "completed", score: 42 });
    expect(payload.completedAt).toBeInstanceOf(Date);
  });

  it("defaults the score to null when none is supplied", async () => {
    const { db, calls } = fakeDb();

    await completeAudit(db, "a-1");

    expect(setPayload(calls)).toMatchObject({ status: "completed", score: null });
  });

  it("records a failure reason and still stamps completedAt", async () => {
    const { db, calls } = fakeDb();

    await failAudit(db, "a-1", "The page could not be scanned.");

    const payload = setPayload(calls);
    expect(payload).toMatchObject({
      status: "failed",
      error: "The page could not be scanned.",
    });
    expect(payload.completedAt).toBeInstanceOf(Date);
  });
});

describe("reads", () => {
  it("returns undefined for an audit that does not exist", async () => {
    const { db } = fakeDb([]);

    await expect(getAuditById(db, "missing")).resolves.toBeUndefined();
  });

  it("returns the row when it exists", async () => {
    const row = { id: "a-1" };
    const { db } = fakeDb([row]);

    await expect(getAuditById(db, "a-1")).resolves.toBe(row);
  });

  it("orders issues so the report has a stable layout across polls", async () => {
    const { db, calls } = fakeDb([]);

    await getIssuesByAudit(db, "a-1");

    expect(calls.some((c) => c.method === "orderBy")).toBe(true);
  });
});

describe("setAnalysisForRule", () => {
  it("writes only the analysis column", async () => {
    const { db, calls } = fakeDb();

    await setAnalysisForRule(db, "a-1", "image-alt", analysis);

    expect(setPayload(calls)).toEqual({ llmAnalysis: analysis });
  });
});
