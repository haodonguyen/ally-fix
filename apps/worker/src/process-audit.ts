import {
  completeAudit,
  failAudit,
  insertIssues,
  markAuditRunning,
  type Database,
} from "@ally-fix/db";
import type { NewIssueRow } from "@ally-fix/db";
import {
  AUDIT_QUEUE_NAME,
  auditJobPayloadSchema,
  computeAccessibilityScore,
} from "@ally-fix/shared";
import type { LlmClient, LlmConfig, TokenPrices } from "@ally-fix/llm";
import type { Logger } from "@ally-fix/shared/logger";
import { SpanKind, extractTraceContext, withSpan } from "@ally-fix/telemetry";
import type IORedis from "ioredis";
import { analyzeAudit, roundUsd } from "./analyze";
import { toPublicError } from "./public-error";
import type { ScannedIssue } from "./scanner";
import { createAuditMetrics, type AuditMetrics } from "./telemetry";

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
  /** Defaults to the global meter — a no-op unless the SDK was started. */
  metrics?: AuditMetrics;
  /** Injectable clock, so durations are assertable. */
  now?: () => number;
}

/** The shape BullMQ hands the processor. Narrowed to what we actually read. */
export interface AuditJob {
  id?: string;
  data: unknown;
  /** When the job was enqueued, in epoch ms. Set by BullMQ. */
  timestamp?: number;
}

export function createAuditProcessor(deps: ProcessAuditDeps) {
  const metrics = deps.metrics ?? createAuditMetrics();

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
    const { auditId, url, trace } = parsed.data;
    // Every line below is tagged with the audit, which is the only question
    // anyone asks of these logs: what happened to *this* scan?
    const log = deps.logger.child({ auditId, jobId: job.id });

    // In the on-demand model this is the number that matters to a visitor: how
    // long their scan waited for someone to start a worker.
    const queueWaitMs =
      job.timestamp === undefined ? undefined : Math.max(0, startedAt - job.timestamp);
    if (queueWaitMs !== undefined) metrics.queueWait(queueWaitMs / 1000);

    // A child of the web request that enqueued the job, so one trace runs from
    // the POST through the queue to the finished report. When the job carries
    // no context (an older web build, or tracing off there), this is a new root.
    return withSpan(
      `process ${AUDIT_QUEUE_NAME}`,
      {
        kind: SpanKind.CONSUMER,
        parent: extractTraceContext(trace),
        attributes: {
          "messaging.system": "bullmq",
          "messaging.operation.type": "process",
          // The pre-1.26 name for the same thing. New Relic still keys its
          // consumer transactions on it: without it this span is named
          // `OtherTransaction/consumer/unknown` and the Summary page is empty.
          "messaging.operation": "process",
          "messaging.destination.name": AUDIT_QUEUE_NAME,
          ...(job.id ? { "messaging.message.id": job.id } : {}),
          ...(queueWaitMs !== undefined ? { "allyfix.audit.queue_wait_ms": queueWaitMs } : {}),
          "allyfix.audit.id": auditId,
          "url.full": url,
        },
      },
      async (span) => {
        try {
          log.info("scan started", { url, ...(queueWaitMs !== undefined && { queueWaitMs }) });
          await markAuditRunning(deps.db, auditId);

          const scanned = await withSpan("audit.scan", {}, async (scanSpan) => {
            const scanStartedAt = now();
            const issues = await deps.scan(url, deps.scanTimeoutMs);
            const scanMs = now() - scanStartedAt;
            scanSpan.setAttribute("allyfix.scan.issues", issues.length);
            metrics.scanned(scanMs / 1000, issues.length);
            log.info("scan finished", { scanMs, issues: issues.length });
            return issues;
          });

          const rows: NewIssueRow[] = scanned.map((issue) => ({ auditId, ...issue }));
          await insertIssues(deps.db, rows);

          // Phase 2: enrich issues with LLM explanations + fixes. Best-effort — the
          // raw issues are already saved, so this never fails the audit.
          await withSpan("audit.analyze", {}, async (analyzeSpan) => {
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
            metrics.analysed(result);
            analyzeSpan.setAttributes({
              "allyfix.llm.analyzed": result.analyzed,
              "allyfix.llm.failed": result.failed,
              "allyfix.llm.skipped": result.skipped,
              "allyfix.llm.cache_hits": result.cacheHits,
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
          });

          const score = computeAccessibilityScore(scanned.map((issue) => issue.impact));
          await completeAudit(deps.db, auditId, { score });
          const totalMs = now() - startedAt;
          span.setAttributes({
            "allyfix.audit.score": score,
            "allyfix.audit.issues": scanned.length,
          });
          metrics.finished("completed", totalMs / 1000);
          log.info("audit completed", { score, issues: scanned.length, totalMs });
        } catch (error) {
          // The full error goes to the logs (where it is scrubbed of credentials);
          // only a generic reason is stored, because the report page is public.
          const totalMs = now() - startedAt;
          metrics.finished("failed", totalMs / 1000);
          log.error("audit failed", { totalMs, err: error });
          // The write can fail for the very reason the audit did — a dead database.
          // Guard it so its rejection cannot replace the original error and skip the
          // rethrow below, which would leave BullMQ recording the wrong cause.
          try {
            await failAudit(deps.db, auditId, toPublicError(error));
          } catch (writeError) {
            log.error("could not record the failure", { err: writeError });
          }
          throw error; // let BullMQ record the failure too — and the span, on the way out
        }
      },
    );
  };
}
