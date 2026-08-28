import { failStaleRunningAudits, type Database } from "@ally-fix/db";

/**
 * Recovers audits orphaned by a worker that died mid-scan.
 *
 * Nothing else can: BullMQ will eventually release the job lock, but the `audits`
 * row was already moved to `running` and no other process will ever move it out.
 * The report page then polls a scan that is never coming.
 *
 * Runs once at startup — which is when the previous process's casualties are
 * discovered — and then on an interval, for a worker that stays up while an
 * individual job dies.
 */
export const STALE_AUDIT_REASON = "The scan was interrupted before it finished. Please try again.";

export interface ReaperDeps {
  db: Database;
  /** A `running` audit older than this is considered abandoned. */
  staleAfterMs: number;
  /** How often to sweep after the initial pass. */
  intervalMs: number;
  now?: () => number;
}

/** One sweep. Returns how many audits were failed; never throws. */
export async function sweepStaleAudits(deps: ReaperDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const cutoff = new Date(now() - deps.staleAfterMs);
  try {
    const swept = await failStaleRunningAudits(deps.db, cutoff, STALE_AUDIT_REASON);
    if (swept > 0) {
      console.warn(`[worker] recovered ${swept} audit(s) abandoned by an earlier run`);
    }
    return swept;
  } catch (error) {
    // A sweep failure must not take the worker down with it — scanning is still
    // useful while the database is briefly unhappy.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] stale-audit sweep failed: ${message}`);
    return 0;
  }
}

/**
 * Starts the reaper and returns a function that stops it. The interval is
 * unref'd so a pending sweep can never be the reason the process stays alive
 * during shutdown.
 */
export function startReaper(deps: ReaperDeps): () => void {
  void sweepStaleAudits(deps);

  const timer = setInterval(() => void sweepStaleAudits(deps), deps.intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
