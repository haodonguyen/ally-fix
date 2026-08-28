import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler, type ShutdownDeps } from "./shutdown";
import { createFakeLogger } from "./testing/fake-logger";

function build(overrides: Partial<ShutdownDeps> = {}) {
  const captured = createFakeLogger();
  const deps: ShutdownDeps = {
    closeWorker: vi.fn(async () => undefined),
    closeConnections: vi.fn(async () => undefined),
    graceMs: 50,
    exit: vi.fn(),
    logger: captured.logger,
    ...overrides,
  };
  return { shutdown: createShutdownHandler(deps), deps, captured };
}

describe("graceful shutdown", () => {
  it("stops the worker before releasing its connections", async () => {
    const order: string[] = [];
    const { shutdown, deps } = build({
      closeWorker: vi.fn(async () => void order.push("worker")),
      closeConnections: vi.fn(async () => void order.push("connections")),
    });

    await shutdown("SIGTERM");

    // Reversing these would pull Redis out from under a job still finishing.
    expect(order).toEqual(["worker", "connections"]);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("waits for an in-flight scan rather than killing it", async () => {
    let finished = false;
    const { shutdown } = build({
      closeWorker: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = true;
      }),
    });

    await shutdown("SIGTERM");

    expect(finished).toBe(true);
  });

  it("gives up on its own terms when the close hangs", async () => {
    // Platforms follow SIGTERM with SIGKILL on a fixed timer, so waiting forever
    // just means being killed with less control.
    const { shutdown, deps, captured } = build({
      graceMs: 20,
      closeWorker: vi.fn(() => new Promise(() => undefined)),
    });

    await shutdown("SIGTERM");

    expect(captured.first("shutting down without a clean stop")).toMatchObject({
      err: { message: expect.stringContaining("timed out") },
    });
    // Connections are still released, and we still exit deliberately.
    expect(deps.closeConnections).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("still exits when closing connections throws", async () => {
    const { shutdown, deps } = build({
      closeConnections: vi.fn(async () => {
        throw new Error("redis already gone");
      }),
    });

    await shutdown("SIGTERM");

    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("treats a second signal as 'stop waiting', not a second shutdown", async () => {
    const { shutdown, deps } = build({
      graceMs: 1000,
      closeWorker: vi.fn(() => new Promise(() => undefined)),
    });

    const first = shutdown("SIGINT");
    await shutdown("SIGINT"); // impatient operator hits Ctrl-C again

    expect(deps.exit).toHaveBeenCalledWith(1);
    // The first attempt is still only running one close, not two.
    expect(deps.closeWorker).toHaveBeenCalledOnce();
    void first;
  });

  it("names the signal it received, so the logs explain the exit", async () => {
    const { shutdown, captured } = build();

    await shutdown("SIGTERM");

    expect(captured.first("shutdown started, finishing in-flight scans")).toMatchObject({
      signal: "SIGTERM",
      graceMs: 50,
    });
  });
});
