import type IORedis from "ioredis";
import { getRedis } from "./redis";

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

export async function checkAndConsume(
  ip: string,
  limit: number,
  redis: IORedis = getRedis(),
): Promise<RateLimitResult> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, limit: 0, remaining: Number.POSITIVE_INFINITY };
  }

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `ratelimit:audit:${day}:${ip}`;

  const count = await redis.incr(key);
  // Set the 24h expiry only on the first hit of the day.
  if (count === 1) await redis.expire(key, DAY_IN_SECONDS);

  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count) };
}

/** Best-effort client IP from proxy headers (Render/Vercel set x-forwarded-for). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
