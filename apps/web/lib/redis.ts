import IORedis from "ioredis";

/**
 * Process-wide Redis connection for the web app (rate limiting + the BullMQ
 * producer). Lazily created and cached on globalThis so Next's dev hot-reload
 * doesn't open a new connection on every change, and read from the environment
 * at call time so `next build` doesn't require Redis to be reachable.
 */
const globalForRedis = globalThis as unknown as { __allyfixRedis?: IORedis };

export function getRedis(): IORedis {
  if (!globalForRedis.__allyfixRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("Missing required environment variable: REDIS_URL");
    globalForRedis.__allyfixRedis = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return globalForRedis.__allyfixRedis;
}
