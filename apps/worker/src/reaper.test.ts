import { beforeEach, describe, expect, it, vi } from "vitest";

const { failStaleRunningAudits } = vi.hoisted(() => ({ failStaleRunningAudits: vi.fn() }));
vi.mock("@ally-fix/db", () => ({ failStaleRunningAudits }));

import { STALE_AUDIT_REASON, startReaper, sweepStaleAudits, type ReaperDeps } from "./reaper";
import { createFakeLogger } from "./testing/fake-logger";

const NOW = 1_700_000_000_000;

function deps(overrides: Partial<ReaperDeps> = {}): ReaperDeps {
  return {
    db: {} as ReaperDeps["db"],
    staleAfterMs: 15 * 60_000,
    intervalMs: 5 * 60_000,
    logger: createFakeLogger().logger,
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  failStaleRunningAudits.mockResolvedValue(0);
});

describe("sweepStaleAudits", () => {
  it("sweeps audits that started before the staleness cutoff", async () => {
    await sweepStaleAudits(deps({ staleAfterMs: 15 * 60_000 }));

    const [, cutoff, reason] = failStaleRunningAudits.mock.calls[0] as [unknown, Date, string];
    expect(cutoff.getTime()).toBe(NOW - 15 * 60_000);
    expect(reason).toBe(STALE_AUDIT_REASON);
  });

  it("reports how many it recovered", async () => {
    failStaleRunningAudits.mockResolvedValue(3);
    await expect(sweepStaleAudits(deps())).resolves.toBe(3);
  });

  it("stays quiet when there is nothing to recover", async () => {
    const captured = createFakeLogger();
    await sweepStaleAudits(deps({ logger: captured.logger }));
    expect(captured.records).toHaveLength(0);
  });

  it("says how many it recovered, and after how long they were considered stale", async () => {
    failStaleRunningAudits.mockResolvedValue(2);
    const captured = createFakeLogger();

    await sweepStaleAudits(deps({ logger: captured.logger, staleAfterMs: 900_000 }));

    expect(captured.first("recovered abandoned audits")).toMatchObject({
      level: "warn",
      swept: 2,
      staleAfterMs: 900_000,
    });
  });

  it("never throws when the database is unhappy", async () => {
    // Scanning still works while Postgres is briefly unreachable; a failed sweep
    // must not be the thing that takes the worker down.
    failStaleRunningAudits.mockRejectedValue(new Error("connection refused"));

    const captured = createFakeLogger();

    await expect(sweepStaleAudits(deps({ logger: captured.logger }))).resolves.toBe(0);

    expect(captured.first("stale-audit sweep failed")).toMatchObject({
      level: "error",
      err: { message: "connection refused" },
    });
  });
});

describe("startReaper", () => {
  it("sweeps immediately, because startup is when a dead predecessor is found", async () => {
    const stop = startReaper(deps());
    await vi.waitFor(() => expect(failStaleRunningAudits).toHaveBeenCalledOnce());
    stop();
  });

  it("keeps sweeping on the interval", async () => {
    vi.useFakeTimers();
    try {
      const stop = startReaper(deps({ intervalMs: 1000 }));
      await vi.advanceTimersByTimeAsync(3000);
      // One at startup plus three ticks.
      expect(failStaleRunningAudits).toHaveBeenCalledTimes(4);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops sweeping once cancelled", async () => {
    vi.useFakeTimers();
    try {
      const stop = startReaper(deps({ intervalMs: 1000 }));
      await vi.advanceTimersByTimeAsync(1000);
      const afterFirst = failStaleRunningAudits.mock.calls.length;

      stop();
      await vi.advanceTimersByTimeAsync(5000);

      expect(failStaleRunningAudits).toHaveBeenCalledTimes(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});
