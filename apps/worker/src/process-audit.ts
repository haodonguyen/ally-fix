import {
  completeAudit,
  failAudit,
  insertIssues,
  markAuditRunning,
  type Database,
} from "@ally-fix/db";
import type { NewIssueRow } from "@ally-fix/db";
import { auditJobPayloadSchema, computeAccessibilityScore } from "@ally-fix/shared";
import type { LlmClient, LlmConfig } from "@ally-fix/llm";
import type IORedis from "ioredis";
import { analyzeAudit } from "./analyze";
import { toPublicError } from "./public-error";
import type { ScannedIssue } from "./scanner";

/**
 * The audit pipeline, expressed as a plain function of its dependencies.
 *
 * `index.ts` is process wiring: importing it opens two Redis connections, a
 * Postgres pool, and a BullMQ worker. The orchestration below — validate, scan,
 * store, enrich, score — is the part with decisions in it, so it lives here where
 * it can be driven with fakes.
 */
export interface ProcessAuditDeps {
  db: Database;
  cacheRedis: IORedis;
  llmConfig: LlmConfig;
  llmClient: LlmClient;
  scanTimeoutMs: number;
  cacheTtlSeconds: number;
  /** Injected so tests don't need a browser. */
  scan: (url: string, timeoutMs: number) => Promise<ScannedIssue[]>;
}

/** The shape BullMQ hands the processor. Narrowed to what we actually read. */
export interface AuditJob {
  id?: string;
  data: unknown;
}

export function createAuditProcessor(deps: ProcessAuditDeps) {
  return async function processAudit(job: AuditJob): Promise<void> {
    // Validate the job shape defensively — a malformed job must not throw an
    // unhandled error, and there's no audit row to fail if we can't read its id.
    const parsed = auditJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      console.error(`[worker] discarding malformed job ${job.id}: ${parsed.error.message}`);
      return;
    }
    const { auditId, url } = parsed.data;

    try {
      await markAuditRunning(deps.db, auditId);
      const scanned = await deps.scan(url, deps.scanTimeoutMs);
      const rows: NewIssueRow[] = scanned.map((issue) => ({ auditId, ...issue }));
      await insertIssues(deps.db, rows);

      // Phase 2: enrich issues with LLM explanations + fixes. Best-effort — the
      // raw issues are already saved, so this never fails the audit.
      const result = await analyzeAudit(auditId, scanned, {
        db: deps.db,
        redis: deps.cacheRedis,
        config: deps.llmConfig,
        cacheTtlSeconds: deps.cacheTtlSeconds,
        client: deps.llmClient,
      });
      console.log(
        `[worker] audit ${auditId}: analysed ${result.analyzed} rule group(s), ` +
          `${result.failed} failed, ${result.skipped} skipped`,
      );

      const score = computeAccessibilityScore(scanned.map((issue) => issue.impact));
      await completeAudit(deps.db, auditId, { score });
    } catch (error) {
      // Log a string form server-side (not the raw object, which could carry
      // connection detail in a nested field), but store only a safe generic
      // reason: the report is public.
      console.error(
        `[worker] audit ${auditId} failed:`,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      // The write can fail for the very reason the audit did — a dead database.
      // Guard it so its rejection cannot replace the original error and skip the
      // rethrow below, which would leave BullMQ recording the wrong cause.
      try {
        await failAudit(deps.db, auditId, toPublicError(error));
      } catch (writeError) {
        const message = writeError instanceof Error ? writeError.message : String(writeError);
        console.error(`[worker] audit ${auditId}: could not record the failure: ${message}`);
      }
      throw error; // let BullMQ record the failure too
    }
  };
}
