import { beforeEach, describe, expect, it, vi } from "vitest";

const { pingDatabase, ping } = vi.hoisted(() => ({
  pingDatabase: vi.fn(),
  ping: vi.fn(),
}));

vi.mock("@ally-fix/db", () => ({ pingDatabase }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ ping }) }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { GET } from "./route";

interface Body {
  status: string;
  checks: Array<{ name: string; ok: boolean; error?: string; durationMs: number }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  pingDatabase.mockResolvedValue(undefined);
  ping.mockResolvedValue("PONG");
});

describe("GET /api/ready", () => {
  it("reports ready when both dependencies answer", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body.status).toBe("ready");
    expect(body.checks.map((c) => c.name).sort()).toEqual(["postgres", "redis"]);
    expect(body.checks.every((c) => c.ok)).toBe(true);
  });

  it("answers 503 and names which dependency is down", async () => {
    // A readiness probe that only says "not ready" sends you looking in the
    // wrong place; the whole value is in knowing which one failed.
    pingDatabase.mockRejectedValue(new Error("connection refused"));

    const response = await GET();

    expect(response.status).toBe(503);
    const body = (await response.json()) as Body;
    expect(body.status).toBe("degraded");
    const postgres = body.checks.find((c) => c.name === "postgres");
    expect(postgres).toMatchObject({ ok: false, error: "connection refused" });
    // Redis was still checked, rather than short-circuiting on the first failure.
    expect(body.checks.find((c) => c.name === "redis")?.ok).toBe(true);
  });

  it("checks both dependencies even when the first one fails", async () => {
    pingDatabase.mockRejectedValue(new Error("down"));
    ping.mockRejectedValue(new Error("also down"));

    const body = (await (await GET()).json()) as Body;

    expect(body.checks.filter((c) => !c.ok)).toHaveLength(2);
  });

  it("times each check, so a slow dependency is visible before it is a broken one", async () => {
    const body = (await (await GET()).json()) as Body;

    for (const check of body.checks) {
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not throw when a dependency rejects with a non-Error", async () => {
    ping.mockRejectedValue("just a string");

    const response = await GET();

    expect(response.status).toBe(503);
    const body = (await response.json()) as Body;
    expect(body.checks.find((c) => c.name === "redis")?.error).toBe("just a string");
  });
});
