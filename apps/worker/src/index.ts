import { createDb } from "@ally-fix/db";
import { AUDIT_QUEUE_NAME } from "@ally-fix/shared";
import { createLlmClient } from "@ally-fix/llm";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env, resolveLlmClientOptions, resolveLlmConfig } from "./env";
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
});

const worker = new Worker(AUDIT_QUEUE_NAME, processAudit, { connection, concurrency: 2 });

// Recovers audits left `running` by a worker that died mid-scan — including, on
// the first pass, casualties of this process's own predecessor.
const stopReaper = startReaper({
  db,
  staleAfterMs: env.STALE_AUDIT_AFTER_MS,
  intervalMs: env.STALE_SWEEP_INTERVAL_MS,
});

worker.on("completed", (job) => {
  console.log(`[worker] audit ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] audit ${job?.id} failed: ${error.message}`);
});

const shutdown = createShutdownHandler({
  closeWorker: () => worker.close(),
  closeConnections: async () => {
    stopReaper();
    await Promise.allSettled([connection.quit(), cacheRedis.quit()]);
  },
  graceMs: env.SHUTDOWN_GRACE_MS,
  exit: (code) => process.exit(code),
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

console.log(`[worker] AllyFix scanner worker started, listening on "${AUDIT_QUEUE_NAME}".`);
