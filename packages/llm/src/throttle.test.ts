import { describe, expect, it } from "vitest";
import { createTokenBucket, noopThrottle } from "./throttle";

/**
 * A virtual clock: `sleep` advances time instead of waiting, so the pacing
 * behaviour is asserted exactly and the suite stays instant.
 */
function virtualClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createTokenBucket", () => {
  it("degrades to a no-op when the rate is zero or negative", async () => {
    expect(createTokenBucket({ requestsPerMinute: 0 })).toBe(noopThrottle);
    expect(createTokenBucket({ requestsPerMinute: -1 })).toBe(noopThrottle);
    expect(createTokenBucket({ requestsPerMinute: Number.NaN })).toBe(noopThrottle);
  });

  it("lets a full burst through without waiting", async () => {
    const clock = virtualClock();
    const throttle = createTokenBucket({
      requestsPerMinute: 60,
      burst: 3,
      now: clock.now,
      sleep: clock.sleep,
    });

    await throttle.acquire();
    await throttle.acquire();
    await throttle.acquire();

    expect(clock.sleeps).toEqual([]);
  });

  it("paces requests at the refill rate once the burst is spent", async () => {
    const clock = virtualClock();
    // 60/min = one token per 1000ms.
    const throttle = createTokenBucket({
      requestsPerMinute: 60,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await throttle.acquire(); // uses the single burst token
    await throttle.acquire(); // must wait a full interval
    await throttle.acquire();

    expect(clock.sleeps).toEqual([1000, 1000]);
    expect(clock.now()).toBe(2000);
  });

  it("refills while idle, so a later caller does not wait", async () => {
    const clock = virtualClock();
    const throttle = createTokenBucket({
      requestsPerMinute: 60,
      burst: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    await throttle.acquire();
    await throttle.acquire();
    // Two seconds pass with no traffic — the bucket refills to capacity.
    clock.advance(2000);
    await throttle.acquire();
    await throttle.acquire();

    expect(clock.sleeps).toEqual([]);
  });

  it("never refills past capacity", async () => {
    const clock = virtualClock();
    const throttle = createTokenBucket({
      requestsPerMinute: 60,
      burst: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    // An hour of idling must not bank an hour's worth of tokens.
    clock.advance(3_600_000);
    await throttle.acquire();
    await throttle.acquire();
    await throttle.acquire();

    expect(clock.sleeps).toEqual([1000]);
  });

  it("serves concurrent waiters in arrival order", async () => {
    const clock = virtualClock();
    const throttle = createTokenBucket({
      requestsPerMinute: 60,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        await throttle.acquire();
        order.push(i);
      }),
    );

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("keeps serving later waiters after one of them rejects", async () => {
    const clock = virtualClock();
    let calls = 0;
    const throttle = createTokenBucket({
      requestsPerMinute: 60,
      burst: 1,
      now: clock.now,
      sleep: async (ms) => {
        calls++;
        // Fail the first paced wait; the queue must not be poisoned by it.
        if (calls === 1) throw new Error("clock exploded");
        await clock.sleep(ms);
      },
    });

    await throttle.acquire();
    await expect(throttle.acquire()).rejects.toThrow("clock exploded");
    await expect(throttle.acquire()).resolves.toBeUndefined();
  });
});
