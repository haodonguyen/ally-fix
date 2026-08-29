import {
  completeAudit,
  failAudit,
  insertIssues,
  markAuditRunning,
  type Database,
} from "@ally-fix/db";
import type { NewIssueRow } from "@ally-fix/db";
import { auditJobPayloadSchema, computeAccessibilityScore } from "@ally-fix/shared";
import type { LlmClient, LlmConfig, TokenPrices } from "@ally-fix/llm";
import type { Logger } from "@ally-fix/shared/logger";
import type IORedis from "ioredis";
import { analyzeAudit, roundUsd } from "./analyze";
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
  /** Per-million-token rates for costing the audit. Null leaves the cost unreported. */
  llmPrices?: TokenPrices | null;
  /** Injected so tests don't need a browser. */
  scan: (url: string, timeoutMs: number) => Promise<ScannedIssue[]>;
  logger: Logger;
  /** Injectable clock, so durations are assertable. */
  now?: () => number;
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
    const now = deps.now ?? Date.now;
    const startedAt = now();

    const parsed = auditJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      deps.logger.error("discarding malformed job", {
        jobId: job.id,
        reason: parsed.error.message,
      });
      return;
    }
    const { auditId, url } = parsed.data;
    // Every line below is tagged with the audit, which is the only question
    // anyone asks of these logs: what happened to *this* scan?
    const log = deps.logger.child({ auditId, jobId: job.id });

    try {
      log.info("scan started", { url });
      await markAuditRunning(deps.db, auditId);

      const scanStartedAt = now();
      const scanned = await deps.scan(url, deps.scanTimeoutMs);
      const scanMs = now() - scanStartedAt;
      log.info("scan finished", { scanMs, issues: scanned.length });

      const rows: NewIssueRow[] = scanned.map((issue) => ({ auditId, ...issue }));
      await insertIssues(deps.db, rows);

      // Phase 2: enrich issues with LLM explanations + fixes. Best-effort — the
      // raw issues are already saved, so this never fails the audit.
      const analysisStartedAt = now();
      const result = await analyzeAudit(auditId, scanned, {
        db: deps.db,
        redis: deps.cacheRedis,
        config: deps.llmConfig,
        cacheTtlSeconds: deps.cacheTtlSeconds,
        prices: deps.llmPrices ?? null,
        client: deps.llmClient,
        logger: log,
      });
      // Flattened rather than spread, so the fields a cost dashboard groups by
      // are a stable shape rather than whatever AnalyzeResult happens to hold.
      log.info("analysis finished", {
        analysisMs: now() - analysisStartedAt,
        provider: deps.llmConfig.provider,
        model: deps.llmConfig.model,
        analyzed: result.analyzed,
        failed: result.failed,
        skipped: result.skipped,
        cacheHits: result.cacheHits,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        reasoningTokens: result.usage?.reasoningTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
        costUsd: roundUsd(result.costUsd),
      });

      const score = computeAccessibilityScore(scanned.map((issue) => issue.impact));
      await completeAudit(deps.db, auditId, { score });
      log.info("audit completed", { score, issues: scanned.length, totalMs: now() - startedAt });
    } catch (error) {
      // Log a string form server-side (not the raw object, which could carry
      // connection detail in a nested field), but store only a safe generic
      // reason: the report is public.
      // The full error goes to the logs (where it is scrubbed of credentials);
      // only a generic reason is stored, because the report page is public.
      log.error("audit failed", { totalMs: now() - startedAt, err: error });
      // The write can fail for the very reason the audit did — a dead database.
      // Guard it so its rejection cannot replace the original error and skip the
      // rethrow below, which would leave BullMQ recording the wrong cause.
      try {
        await failAudit(deps.db, auditId, toPublicError(error));
      } catch (writeError) {
        log.error("could not record the failure", { err: writeError });
      }
      throw error; // let BullMQ record the failure too
    }
  };
}
