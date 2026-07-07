import { AUDIT_QUEUE_NAME, type AuditJobPayload } from "@ally-fix/shared";
import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * BullMQ producer side. The web app only enqueues jobs; the worker consumes them.
 * Connection + queue are cached on globalThis to survive Next dev hot-reload, and
 * built lazily so `next build` doesn't require Redis to be reachable.
 */
const globalForQueue = globalThis as unknown as {
  __allyfixRedis?: IORedis;
  __allyfixQueue?: Queue;
};

function getQueue(): Queue {
  if (!globalForQueue.__allyfixQueue) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("Missing required environment variable: REDIS_URL");
    const connection =
      globalForQueue.__allyfixRedis ?? new IORedis(url, { maxRetriesPerRequest: null });
    globalForQueue.__allyfixRedis = connection;
    globalForQueue.__allyfixQueue = new Queue(AUDIT_QUEUE_NAME, { connection });
  }
  return globalForQueue.__allyfixQueue;
}

/** Push an audit job onto the queue for the worker to pick up. */
export async function enqueueAudit(payload: AuditJobPayload): Promise<void> {
  await getQueue().add("scan", payload, { removeOnComplete: 1000, removeOnFail: 1000 });
}
