import { describe, expect, it, vi } from "vitest";
import { checkAndConsume, clientIp } from "./rate-limit";

/** Minimal fake of the ioredis methods checkAndConsume uses. */
function fakeRedis(initial = 0) {
  let value = initial;
  return {
    incr: vi.fn(async () => ++value),
    expire: vi.fn(async () => 1),
  };
}

describe("checkAndConsume", () => {
  it("treats a limit of 0 as unlimited and never touches Redis", async () => {
    const redis = fakeRedis();
    const result = await checkAndConsume("1.2.3.4", 0, redis as never);
    expect(result.allowed).toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("allows up to the limit then blocks", async () => {
    const redis = fakeRedis();
    const first = await checkAndConsume("1.2.3.4", 2, redis as never);
    const second = await checkAndConsume("1.2.3.4", 2, redis as never);
    const third = await checkAndConsume("1.2.3.4", 2, redis as never);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("sets the daily expiry only on the first hit", async () => {
    const redis = fakeRedis();
    await checkAndConsume("1.2.3.4", 5, redis as never);
    await checkAndConsume("1.2.3.4", 5, redis as never);
    expect(redis.expire).toHaveBeenCalledOnce();
  });
});

describe("clientIp", () => {
  it("takes the first entry of x-forwarded-for", () => {
    const request = new Request("http://x", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then 'unknown'", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "198.51.100.9" } }))).toBe(
      "198.51.100.9",
    );
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
