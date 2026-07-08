import { AUDIT_QUEUE_NAME, type AuditJobPayload } from "@ally-fix/shared";
import { Queue } from "bullmq";
import { getRedis } from "./redis";

/**
 * BullMQ producer side. The web app only enqueues jobs; the worker consumes them.
 * The queue is cached on globalThis to survive Next dev hot-reload and built
 * lazily so `next build` doesn't require Redis to be reachable.
 */
const globalForQueue = globalThis as unknown as { __allyfixQueue?: Queue };

function getQueue(): Queue {
  if (!globalForQueue.__allyfixQueue) {
    globalForQueue.__allyfixQueue = new Queue(AUDIT_QUEUE_NAME, { connection: getRedis() });
  }
  return globalForQueue.__allyfixQueue;
}

/** Push an audit job onto the queue for the worker to pick up. */
export async function enqueueAudit(payload: AuditJobPayload): Promise<void> {
  await getQueue().add("scan", payload, { removeOnComplete: 1000, removeOnFail: 1000 });
}
