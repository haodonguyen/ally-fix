import { AUDIT_QUEUE_NAME, type AuditJobPayload } from "@ally-fix/shared";
import { SpanKind, injectTraceContext, withSpan } from "@ally-fix/telemetry";
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

/**
 * Push an audit job onto the queue for the worker to pick up.
 *
 * The job carries this request's trace context, so the worker's spans continue
 * the same trace: in New Relic, one trace runs from the POST, through however
 * long the job waited in Redis, to the finished scan. A queue is otherwise
 * where distributed traces go to die — nothing propagates through it unless
 * the payload carries it.
 */
export async function enqueueAudit(payload: Omit<AuditJobPayload, "trace">): Promise<void> {
  await withSpan(
    `publish ${AUDIT_QUEUE_NAME}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "bullmq",
        "messaging.operation.type": "send",
        "messaging.destination.name": AUDIT_QUEUE_NAME,
        "allyfix.audit.id": payload.auditId,
      },
    },
    async (span) => {
      // Injected inside the producer span, so the worker's span is its child.
      const trace = injectTraceContext();
      const job = await getQueue().add(
        "scan",
        { ...payload, ...(Object.keys(trace).length > 0 && { trace }) },
        { removeOnComplete: 1000, removeOnFail: 1000 },
      );
      if (job.id) span.setAttribute("messaging.message.id", job.id);
    },
  );
}
