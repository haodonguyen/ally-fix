import { createDb } from "@ally-fix/db";
import { AUDIT_QUEUE_NAME } from "@ally-fix/shared";
import { createLlmClient } from "@ally-fix/llm";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env, resolveLlmClientOptions, resolveLlmConfig } from "./env";
import { logger } from "./logger";
import { createAuditProcessor } from "./process-audit";
import { startReaper } from "./reaper";
import { scanUrl } from "./scanner";
import { createShutdownHandler } from "./shutdown";

/**
 * AllyFix scanner worker — process wiring only.
 *
 * Consumes audit jobs from BullMQ and hands each to the processor in
 * `process-audit.ts`. Runs as its own process because Playwright's Chromium
 * binary cannot run on serverless.
 */

// BullMQ requires `maxRetriesPerRequest: null` on its Redis connection.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
// A separate connection for the LLM cache, so it never contends with BullMQ's
// blocking queue commands.
const cacheRedis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const db = createDb(env.DATABASE_URL);
const llmConfig = resolveLlmConfig();
// One client for the whole process, not one per job: its rate limiter and circuit
// breaker are only meaningful if every concurrent audit shares the same instance.
const llmClient = createLlmClient(llmConfig, resolveLlmClientOptions(llmConfig));

const processAudit = createAuditProcessor({
  db,
  cacheRedis,
  llmConfig,
  llmClient,
  scanTimeoutMs: env.SCAN_TIMEOUT_MS,
  cacheTtlSeconds: env.LLM_CACHE_TTL_SECONDS,
  scan: scanUrl,
  logger,
});

const worker = new Worker(AUDIT_QUEUE_NAME, processAudit, { connection, concurrency: 2 });

// Recovers audits left `running` by a worker that died mid-scan — including, on
// the first pass, casualties of this process's own predecessor.
const stopReaper = startReaper({
  db,
  staleAfterMs: env.STALE_AUDIT_AFTER_MS,
  intervalMs: env.STALE_SWEEP_INTERVAL_MS,
  logger,
});

// Queue-level outcomes. The processor logs the detail; these record what BullMQ
// itself concluded, which can differ (a stalled job, a retry it gave up on).
worker.on("completed", (job) => {
  logger.debug("job completed", { jobId: job.id });
});

worker.on("failed", (job, error) => {
  logger.error("job failed", { jobId: job?.id, err: error });
});

const shutdown = createShutdownHandler({
  closeWorker: () => worker.close(),
  closeConnections: async () => {
    stopReaper();
    await Promise.allSettled([connection.quit(), cacheRedis.quit()]);
  },
  graceMs: env.SHUTDOWN_GRACE_MS,
  exit: (code) => process.exit(code),
  logger,
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

logger.info("worker started", {
  queue: AUDIT_QUEUE_NAME,
  concurrency: 2,
  provider: llmConfig.provider,
  model: llmConfig.model,
  scanTimeoutMs: env.SCAN_TIMEOUT_MS,
});
