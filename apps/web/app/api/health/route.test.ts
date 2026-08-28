import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports ok without touching Postgres or Redis", async () => {
    // The probe must stay dependency-free: a liveness check that opens a database
    // connection reports the database's health, not the app's, and would fail the
    // container during a transient Postgres blip.
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
