/**
 * Outbound rate limiting for LLM calls.
 *
 * Retry-on-429 is *reactive*: it only learns the limit by being punished for
 * crossing it, and each rejected call still costs a round trip. A scan of a
 * broken page produces dozens of rule groups, and the worker runs two audits
 * concurrently, so without a throttle we reliably walk into a free tier's
 * requests-per-minute cap.
 *
 * A token bucket is the right shape because RPM is what providers actually
 * enforce: `capacity` requests may burst immediately, after which calls are
 * paced at the refill rate. Waiters are served FIFO so no request starves.
 */
export interface Throttle {
  /** Resolves once this caller is allowed to issue a request. */
  acquire(): Promise<void>;
}

export interface TokenBucketOptions {
  /** Sustained rate. 0 or less disables throttling entirely. */
  requestsPerMinute: number;
  /**
   * How many requests may burst before pacing kicks in.
   * Defaults to the per-minute rate, i.e. one full minute of budget.
   */
  burst?: number;
  /** Injectable clock + timer, so tests don't wait in real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A throttle that never delays. Used when rate limiting is disabled. */
export const noopThrottle: Throttle = { acquire: () => Promise.resolve() };

export function createTokenBucket(options: TokenBucketOptions): Throttle {
  const { requestsPerMinute } = options;
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) return noopThrottle;

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const capacity = Math.max(1, Math.floor(options.burst ?? requestsPerMinute));
  const msPerToken = 60_000 / requestsPerMinute;

  let tokens = capacity;
  let lastRefill = now();
  // Serialises waiters: each acquire chains onto the previous one, so tokens are
  // handed out in arrival order instead of whoever's timer happens to fire first.
  let queue: Promise<void> = Promise.resolve();

  function refill(): void {
    const current = now();
    const elapsed = current - lastRefill;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed / msPerToken);
    lastRefill = current;
  }

  async function take(): Promise<void> {
    refill();
    if (tokens < 1) {
      // Wait only for the shortfall, not a whole token interval.
      await sleep(Math.ceil((1 - tokens) * msPerToken));
      refill();
    }
    tokens = Math.max(0, tokens - 1);
  }

  return {
    acquire() {
      // Return the tail of the chain, then extend it — later callers queue behind.
      const waitForTurn = queue.then(take);
      // Swallow rejections on the chain itself so one failure can't poison the
      // queue for everyone after it; the caller still sees its own rejection.
      queue = waitForTurn.then(
        () => undefined,
        () => undefined,
      );
      return waitForTurn;
    },
  };
}
