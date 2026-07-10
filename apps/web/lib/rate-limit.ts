import IORedis from "ioredis";

/**
 * Per-IP daily rate limit for the hosted demo (which shares one LLM key). A limit
 * of 0 or less means unlimited — the default for self-hosting, where cost isn't a
 * concern. Backed by a Redis counter that resets each UTC day.
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
}

const DAY_IN_SECONDS = 60 * 60 * 24;

/**
 * A dedicated Redis connection with fail-fast options. Unlike the BullMQ
 * connection (which needs `maxRetriesPerRequest: null`), a synchronous
 * request-path command must not queue and retry forever during a Redis blip —
 * that would hang POST /api/audits.
 */
const globalForRateLimit = globalThis as unknown as { __allyfixRateLimitRedis?: IORedis };

function getRateLimitRedis(): IORedis {
  if (!globalForRateLimit.__allyfixRateLimitRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("Missing required environment variable: REDIS_URL");
    // Finite retries + a command timeout so a Redis blip rejects quickly instead
    // of queueing forever (the BullMQ connection uses null, which would hang here).
    globalForRateLimit.__allyfixRateLimitRedis = new IORedis(url, {
      maxRetriesPerRequest: 2,
      commandTimeout: 3000,
    });
  }
  return globalForRateLimit.__allyfixRateLimitRedis;
}

export async function checkAndConsume(
  ip: string,
  limit: number,
  redis: IORedis = getRateLimitRedis(),
): Promise<RateLimitResult> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, limit: 0, remaining: Number.POSITIVE_INFINITY };
  }

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `ratelimit:audit:${day}:${ip}`;

  try {
    const count = await redis.incr(key);
    // Ensure a TTL exists on every hit (NX = only if unset), so a missed expiry
    // on the first request is repaired by a later one — no orphaned keys.
    await redis.expire(key, DAY_IN_SECONDS, "NX");
    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) };
  } catch (error) {
    // Fail open: a rate-limiter outage shouldn't block scans. The queue enqueue
    // shares the same Redis, so a genuine outage stops work regardless.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[rate-limit] Redis error, allowing request: ${message}`);
    return { allowed: true, limit, remaining: limit };
  }
}

/**
 * Best-effort client IP. Prefers `x-real-ip`: on Vercel that's the platform-set
 * client IP (a single value), not the client-appendable `x-forwarded-for` list
 * whose leftmost entry a caller can spoof to dodge the limit.
 */
export function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return "unknown";
}
