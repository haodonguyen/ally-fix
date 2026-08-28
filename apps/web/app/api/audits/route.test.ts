import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertUrlIsSafe, createAudit, enqueueAudit, checkAndConsume } = vi.hoisted(() => ({
  assertUrlIsSafe: vi.fn(),
  createAudit: vi.fn(),
  enqueueAudit: vi.fn(),
  checkAndConsume: vi.fn(),
}));

vi.mock("@ally-fix/shared/ssrf", () => ({ assertUrlIsSafe }));
vi.mock("@ally-fix/db", () => ({ createAudit }));
vi.mock("@/lib/queue", () => ({ enqueueAudit }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/rate-limit", async () => {
  // clientIp is pure, so exercise the real one; only the Redis-backed half is faked.
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, checkAndConsume };
});

import { POST } from "./route";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/audits", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  assertUrlIsSafe.mockResolvedValue({ ok: true, url: "https://example.com/" });
  createAudit.mockResolvedValue({ id: "audit-uuid" });
  enqueueAudit.mockResolvedValue(undefined);
  checkAndConsume.mockResolvedValue({ allowed: true, limit: 10, remaining: 9 });
});

describe("POST /api/audits — request validation", () => {
  it("creates the audit and queues the scan for a valid URL", async () => {
    const response = await POST(post({ url: "https://example.com" }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ auditId: "audit-uuid" });
    // The *normalised* URL from the SSRF check is what gets stored and queued,
    // not the raw string the caller sent.
    expect(createAudit).toHaveBeenCalledWith(expect.anything(), "https://example.com/");
    expect(enqueueAudit).toHaveBeenCalledWith({
      auditId: "audit-uuid",
      url: "https://example.com/",
    });
  });

  it.each([
    ["a missing url field", {}],
    ["a non-string url", { url: 42 }],
    ["a string that is not a URL", { url: "not a url" }],
    ["null", null],
    ["an array", []],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "A valid URL is required." });
    expect(createAudit).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body instead of throwing", async () => {
    const response = await POST(post("{ not json"));

    expect(response.status).toBe(400);
    expect(createAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/audits — SSRF", () => {
  it("refuses a blocked URL with the guard's reason, and never queues it", async () => {
    assertUrlIsSafe.mockResolvedValue({
      ok: false,
      reason: "That URL resolves to a private or internal address.",
    });

    const response = await POST(post({ url: "http://evil.example.com" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "That URL resolves to a private or internal address.",
    });
    expect(createAudit).not.toHaveBeenCalled();
    expect(enqueueAudit).not.toHaveBeenCalled();
  });

  it("checks SSRF before spending rate-limit budget", async () => {
    assertUrlIsSafe.mockResolvedValue({ ok: false, reason: "This host is not allowed." });

    await POST(post({ url: "http://localhost:3000" }));

    // Otherwise an attacker could exhaust a victim IP's daily quota with URLs
    // that were never going to be scanned.
    expect(checkAndConsume).not.toHaveBeenCalled();
  });
});

describe("POST /api/audits — rate limiting", () => {
  it("returns 429 once the daily cap is reached, without creating an audit", async () => {
    checkAndConsume.mockResolvedValue({ allowed: false, limit: 10, remaining: 0 });

    const response = await POST(post({ url: "https://example.com" }));

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("10/day per IP");
    expect(body.error).toContain("self-host");
    expect(createAudit).not.toHaveBeenCalled();
    expect(enqueueAudit).not.toHaveBeenCalled();
  });

  it("keys the limit on the platform-trusted client IP", async () => {
    await POST(
      post(
        { url: "https://example.com" },
        { "x-real-ip": "198.51.100.9", "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
      ),
    );

    // x-forwarded-for is caller-appendable; x-real-ip is set by the platform.
    expect(checkAndConsume).toHaveBeenCalledWith("198.51.100.9", expect.any(Number));
  });
});
