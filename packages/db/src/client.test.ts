import { describe, expect, it, vi } from "vitest";

const { postgres, drizzle } = vi.hoisted(() => ({
  postgres: vi.fn(() => ({ tag: "sql" })),
  drizzle: vi.fn(() => ({ tag: "db" })),
}));

vi.mock("postgres", () => ({ default: postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle }));

import { createDb } from "./client";

describe("createDb", () => {
  it("takes the connection string as an argument rather than reading a global", () => {
    // The web app and the worker each own their own pool, and tests can inject a
    // URL — none of which works if the module reads process.env at import time.
    createDb("postgres://user:pass@localhost:5432/allyfix");

    expect(postgres).toHaveBeenCalledWith("postgres://user:pass@localhost:5432/allyfix");
  });

  it("binds the schema so relational queries are typed", () => {
    createDb("postgres://localhost:5432/db");

    expect(drizzle).toHaveBeenCalledWith({ tag: "sql" }, { schema: expect.any(Object) });
  });

  it("returns a distinct client per call", () => {
    drizzle.mockReturnValueOnce({ tag: "one" }).mockReturnValueOnce({ tag: "two" });
    expect(createDb("postgres://a")).not.toBe(createDb("postgres://b"));
  });
});
