/**
 * Graceful shutdown for the scanner worker.
 *
 * Without this, a deploy or a Ctrl-C kills the process mid-scan: the audit row
 * is already `running`, so it stays that way forever (see reaper.ts), and the
 * Chromium child process can be left behind. Closing the BullMQ worker first
 * stops it taking new jobs and lets the in-flight one finish.
 *
 * The deadline matters as much as the close. Platforms send SIGTERM and then
 * SIGKILL a fixed time later, so an unbounded wait just means being killed
 * anyway with less control — better to give up on our own terms and let the
 * reaper recover whatever did not finish.
 */
export interface ShutdownDeps {
  /** Stops accepting jobs and resolves once in-flight work settles. */
  closeWorker: () => Promise<unknown>;
  /** Connections to release once the worker is done with them. */
  closeConnections: () => Promise<unknown>;
  /** How long to wait for in-flight work before exiting anyway. */
  graceMs: number;
  exit: (code: number) => void;
  onLog?: (message: string) => void;
}

/** Rejects after `ms`, so a hung close cannot outlast the platform's own timer. */
function deadline(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`shutdown timed out after ${ms}ms`)), ms);
  });
  promise.catch(() => undefined);
  return { promise, cancel: () => clearTimeout(timer) };
}

export function createShutdownHandler(deps: ShutdownDeps) {
  const log = deps.onLog ?? ((message: string) => console.log(message));
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    // A second Ctrl-C from an impatient operator means "stop waiting", not
    // "start a second shutdown".
    if (shuttingDown) {
      log(`[worker] ${signal} received again — exiting immediately`);
      deps.exit(1);
      return;
    }
    shuttingDown = true;
    log(`[worker] ${signal} received, finishing in-flight scans…`);

    const timer = deadline(deps.graceMs);
    try {
      await Promise.race([deps.closeWorker(), timer.promise]);
      log("[worker] in-flight scans finished");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[worker] shutting down without a clean stop: ${message}`);
    } finally {
      timer.cancel();
    }

    try {
      await deps.closeConnections();
    } catch (error) {
      // Nothing useful is left to do about it; we are exiting either way.
      const message = error instanceof Error ? error.message : String(error);
      log(`[worker] could not close connections cleanly: ${message}`);
    }

    deps.exit(0);
  };
}
