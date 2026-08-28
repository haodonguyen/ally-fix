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
import type { Logger } from "@ally-fix/shared/logger";

export interface ShutdownDeps {
  /** Stops accepting jobs and resolves once in-flight work settles. */
  closeWorker: () => Promise<unknown>;
  /** Connections to release once the worker is done with them. */
  closeConnections: () => Promise<unknown>;
  /** How long to wait for in-flight work before exiting anyway. */
  graceMs: number;
  exit: (code: number) => void;
  logger: Logger;
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
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    // A second Ctrl-C from an impatient operator means "stop waiting", not
    // "start a second shutdown".
    if (shuttingDown) {
      deps.logger.warn("signal received again, exiting immediately", { signal });
      deps.exit(1);
      return;
    }
    shuttingDown = true;
    deps.logger.info("shutdown started, finishing in-flight scans", {
      signal,
      graceMs: deps.graceMs,
    });

    const timer = deadline(deps.graceMs);
    try {
      await Promise.race([deps.closeWorker(), timer.promise]);
      deps.logger.info("in-flight scans finished");
    } catch (error) {
      deps.logger.warn("shutting down without a clean stop", { err: error });
    } finally {
      timer.cancel();
    }

    try {
      await deps.closeConnections();
    } catch (error) {
      // Nothing useful is left to do about it; we are exiting either way.
      deps.logger.warn("could not close connections cleanly", { err: error });
    }

    deps.exit(0);
  };
}
