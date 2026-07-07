import { asc, eq } from "drizzle-orm";
import type { Database } from "./client";
import { audits, issues, type AuditRow, type IssueRow, type NewIssueRow } from "./schema";

/**
 * Data-access helpers for the audit pipeline. Kept thin and explicit — each
 * function does one query — so the web app and worker share the same DB logic
 * without an ORM abstraction layer in between.
 */

/** Create a new audit in the "queued" state and return the created row. */
export async function createAudit(db: Database, url: string): Promise<AuditRow> {
  const [row] = await db.insert(audits).values({ url }).returning();
  // `returning()` always yields the inserted row; the check keeps TS honest.
  if (!row) throw new Error("Failed to create audit");
  return row;
}

/** Mark an audit as running (worker picked up the job). */
export async function markAuditRunning(db: Database, id: string): Promise<void> {
  await db.update(audits).set({ status: "running" }).where(eq(audits.id, id));
}

/** Mark an audit as completed. Score is computed in Phase 3, so it stays null for now. */
export async function completeAudit(
  db: Database,
  id: string,
  opts: { score?: number | null } = {},
): Promise<void> {
  await db
    .update(audits)
    .set({ status: "completed", completedAt: new Date(), score: opts.score ?? null })
    .where(eq(audits.id, id));
}

/** Mark an audit as failed with a human-readable reason. */
export async function failAudit(db: Database, id: string, error: string): Promise<void> {
  await db
    .update(audits)
    .set({ status: "failed", completedAt: new Date(), error })
    .where(eq(audits.id, id));
}

/** Bulk-insert the issues found in a scan. No-op when the list is empty. */
export async function insertIssues(db: Database, rows: NewIssueRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(issues).values(rows);
}

/** Fetch a single audit by id, or undefined if it does not exist. */
export async function getAuditById(db: Database, id: string): Promise<AuditRow | undefined> {
  const [row] = await db.select().from(audits).where(eq(audits.id, id)).limit(1);
  return row;
}

/** Fetch all issues for an audit, oldest first (stable display order). */
export async function getIssuesByAudit(db: Database, auditId: string): Promise<IssueRow[]> {
  return db.select().from(issues).where(eq(issues.auditId, auditId)).orderBy(asc(issues.id));
}
