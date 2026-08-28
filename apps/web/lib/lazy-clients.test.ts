import { beforeEach, describe, expect, it, vi } from "vitest";

// Two constraints pull against each other here. The return types are widened to
// `unknown` because each test swaps in a different fake shape. But these two are
// invoked with `new`, so they must stay `function` expressions — an arrow is not
// a constructor and `new IORedis(...)` would throw at runtime.
const { createDb, IORedisCtor, QueueCtor, add } = vi.hoisted(() => ({
  createDb: vi.fn((..._args: unknown[]): unknown => ({ tag: "db" })),
  IORedisCtor: vi.fn(function (..._args: unknown[]): unknown {
    return { tag: "redis" };
  }),
  QueueCtor: vi.fn(function (..._args: unknown[]): unknown {
    return { add: vi.fn() };
  }),
  add: vi.fn(),
}));

vi.mock("@ally-fix/db", () => ({ createDb }));
vi.mock("ioredis", () => ({ default: IORedisCtor }));
vi.mock("bullmq", () => ({ Queue: QueueCtor }));

import { getDb } from "./db";
import { getRedis } from "./redis";
import { enqueueAudit } from "./queue";
import { checkAndConsume } from "./rate-limit";

/**
 * These three modules are the same pattern: a client that is expensive to build,
 * created lazily and cached on `globalThis`. Two behaviours matter and are easy
 * to regress:
 *
 *   - the environment is read at *call* time, not import time, so `next build`
 *     succeeds on a machine with no database or Redis;
 *   - the client is built once, so Next's dev hot-reload doesn't leak a new
 *     connection pool on every file save.
 */
const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  delete globals.__allyfixDb;
  delete globals.__allyfixRedis;
  delete globals.__allyfixQueue;
  delete globals.__allyfixRateLimitRedis;
  vi.unstubAllEnvs();
});

describe("getDb", () => {
  it("throws a named error when DATABASE_URL is absent", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });

  it("builds the client once and reuses it", () => {
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/db");

    const first = getDb();
    const second = getDb();

    expect(first).toBe(second);
    expect(createDb).toHaveBeenCalledOnce();
  });

  it("does not read the environment until it is called", () => {
    // Importing the module with no env set must not have thrown — reaching this
    // line at all is the assertion.
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/db");
    expect(() => getDb()).not.toThrow();
  });
});

describe("getRedis", () => {
  it("throws a named error when REDIS_URL is absent", () => {
    vi.stubEnv("REDIS_URL", "");
    expect(() => getRedis()).toThrow(/REDIS_URL/);
  });

  it("opens one connection and reuses it", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    expect(getRedis()).toBe(getRedis());
    expect(IORedisCtor).toHaveBeenCalledOnce();
  });

  it("uses the option BullMQ requires on its connection", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    getRedis();

    expect(IORedisCtor).toHaveBeenCalledWith("redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
  });
});

describe("enqueueAudit", () => {
  it("adds a scan job with retention bounds so the queue cannot grow forever", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    QueueCtor.mockImplementation(function () {
      return { add };
    });

    await enqueueAudit({ auditId: "a-1", url: "https://example.com/" });

    expect(add).toHaveBeenCalledWith(
      "scan",
      { auditId: "a-1", url: "https://example.com/" },
      { removeOnComplete: 1000, removeOnFail: 1000 },
    );
  });

  it("builds the queue once across calls", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    QueueCtor.mockImplementation(function () {
      return { add };
    });

    await enqueueAudit({ auditId: "a-1", url: "https://example.com/" });
    await enqueueAudit({ auditId: "a-2", url: "https://example.com/" });

    expect(QueueCtor).toHaveBeenCalledOnce();
  });
});

describe("the rate limiter's own connection", () => {
  it("throws a named error when REDIS_URL is absent", async () => {
    vi.stubEnv("REDIS_URL", "");
    await expect(checkAndConsume("1.2.3.4", 10)).rejects.toThrow(/REDIS_URL/);
  });

  it("fails fast instead of queueing forever during a Redis blip", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    IORedisCtor.mockImplementation(function () {
      return { incr: async () => 1, expire: async () => 1 };
    });

    await checkAndConsume("1.2.3.4", 10);

    // Deliberately NOT `maxRetriesPerRequest: null` like the BullMQ connection:
    // this one is on the synchronous request path, where retrying forever would
    // hang POST /api/audits rather than degrade it.
    expect(IORedisCtor).toHaveBeenCalledWith("redis://localhost:6379", {
      maxRetriesPerRequest: 2,
      commandTimeout: 3000,
    });
  });

  it("reuses the connection across requests", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    IORedisCtor.mockImplementation(function () {
      return { incr: async () => 1, expire: async () => 1 };
    });

    await checkAndConsume("1.2.3.4", 10);
    await checkAndConsume("5.6.7.8", 10);

    expect(IORedisCtor).toHaveBeenCalledOnce();
  });
});
