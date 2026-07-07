import { createDb, completeAudit, failAudit, insertIssues, markAuditRunning } from "@ally-fix/db";
import type { NewIssueRow } from "@ally-fix/db";
import { AUDIT_QUEUE_NAME, auditJobPayloadSchema } from "@ally-fix/shared";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env";
import { scanUrl } from "./scanner";

/**
 * AllyFix scanner worker.
 *
 * Consumes audit jobs from BullMQ, scans the URL with Playwright + axe-core,
 * and persists the raw issues to Postgres. Runs as its own process because
 * Playwright's Chromium binary cannot run on serverless.
 */

// BullMQ requires `maxRetriesPerRequest: null` on its Redis connection.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const db = createDb(env.DATABASE_URL);

const worker = new Worker(
  AUDIT_QUEUE_NAME,
  async (job) => {
    const { auditId, url } = auditJobPayloadSchema.parse(job.data);
    await markAuditRunning(db, auditId);

    try {
      const scanned = await scanUrl(url, env.SCAN_TIMEOUT_MS);
      const rows: NewIssueRow[] = scanned.map((issue) => ({ auditId, ...issue }));
      await insertIssues(db, rows);
      await completeAudit(db, auditId);
    } catch (error) {
      // Record the failure on the audit so the UI can show it, then rethrow
      // so BullMQ also marks the job failed.
      const message = error instanceof Error ? error.message : String(error);
      await failAudit(db, auditId, message);
      throw error;
    }
  },
  { connection, concurrency: 2 },
);

worker.on("completed", (job) => {
  console.log(`[worker] audit ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] audit ${job?.id} failed: ${error.message}`);
});

console.log(`[worker] AllyFix scanner worker started, listening on "${AUDIT_QUEUE_NAME}".`);
