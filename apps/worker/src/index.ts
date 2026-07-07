import { createDb, completeAudit, failAudit, insertIssues, markAuditRunning } from "@ally-fix/db";
import type { NewIssueRow } from "@ally-fix/db";
import {
  AUDIT_QUEUE_NAME,
  auditJobPayloadSchema,
  computeAccessibilityScore,
} from "@ally-fix/shared";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { analyzeAudit } from "./analyze";
import { env, resolveLlmConfig } from "./env";
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
// A separate connection for the LLM cache, so it never contends with BullMQ's
// blocking queue commands.
const cacheRedis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const db = createDb(env.DATABASE_URL);
const llmConfig = resolveLlmConfig();

const worker = new Worker(
  AUDIT_QUEUE_NAME,
  async (job) => {
    // Validate the job shape defensively — a malformed job must not throw an
    // unhandled error, and there's no audit row to fail if we can't read its id.
    const parsed = auditJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      console.error(`[worker] discarding malformed job ${job.id}: ${parsed.error.message}`);
      return;
    }
    const { auditId, url } = parsed.data;

    try {
      await markAuditRunning(db, auditId);
      const scanned = await scanUrl(url, env.SCAN_TIMEOUT_MS);
      const rows: NewIssueRow[] = scanned.map((issue) => ({ auditId, ...issue }));
      await insertIssues(db, rows);

      // Phase 2: enrich issues with LLM explanations + fixes. Best-effort — the
      // raw issues are already saved, so this never fails the audit.
      const result = await analyzeAudit(auditId, scanned, {
        db,
        redis: cacheRedis,
        config: llmConfig,
        cacheTtlSeconds: env.LLM_CACHE_TTL_SECONDS,
      });
      console.log(
        `[worker] audit ${auditId}: analysed ${result.analyzed} rule group(s), ${result.failed} failed`,
      );

      const score = computeAccessibilityScore(scanned.map((issue) => issue.impact));
      await completeAudit(db, auditId, { score });
    } catch (error) {
      // Log the full error server-side, but store only a safe, generic reason:
      // the report is public and the raw message can carry internal detail.
      console.error(`[worker] audit ${auditId} failed:`, error);
      await failAudit(db, auditId, toPublicError(error));
      throw error; // let BullMQ record the failure too
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

/**
 * Maps an internal scan error to a safe, user-facing reason. Keeps raw exception
 * text (which can include internal hosts/paths) out of the public report.
 */
function toPublicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unsafe URL|blockedbyclient|ERR_BLOCKED/i.test(message)) {
    return "This URL could not be scanned because it points to a disallowed address.";
  }
  if (/timeout|timed out/i.test(message)) {
    return "The page took too long to load and the scan timed out.";
  }
  return "The page could not be scanned. Please check the URL and try again.";
}
