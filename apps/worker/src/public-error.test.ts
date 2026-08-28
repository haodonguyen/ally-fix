import { describe, expect, it } from "vitest";
import { toPublicError } from "./public-error";

/**
 * These assertions are security assertions, not string-formatting ones: the
 * `error` column is served on a public report page, so the test's real job is to
 * prove that internal detail cannot reach it.
 */
describe("toPublicError", () => {
  it("explains a blocked address without echoing the address", () => {
    const message = toPublicError(new Error("Refusing to scan unsafe URL: 169.254.169.254"));
    expect(message).toBe(
      "This URL could not be scanned because it points to a disallowed address.",
    );
    expect(message).not.toContain("169.254");
  });

  it("recognises Playwright's own block reason", () => {
    expect(toPublicError(new Error("net::ERR_BLOCKED_BY_CLIENT at http://10.0.0.5/"))).toContain(
      "disallowed address",
    );
  });

  it("explains a timeout", () => {
    expect(toPublicError(new Error("page.goto: Timeout 30000ms exceeded"))).toBe(
      "The page took too long to load and the scan timed out.",
    );
  });

  it("matches regardless of case", () => {
    expect(toPublicError(new Error("TIMED OUT waiting for load"))).toContain("timed out");
    expect(toPublicError(new Error("UNSAFE URL"))).toContain("disallowed address");
  });

  it.each([
    [
      "an internal hostname",
      "connect ECONNREFUSED postgres.internal:5432",
      ["postgres.internal", "5432"],
    ],
    [
      "a container filesystem path",
      "Error: ENOENT /app/node_modules/playwright-core/.local-browsers/chromium-1234/chrome",
      ["/app/", "node_modules", "chromium-1234"],
    ],
    [
      "a connection string",
      "getaddrinfo EAI_AGAIN redis://:hunter2@cache.internal:6379",
      ["hunter2", "redis://", "cache.internal"],
    ],
    ["a private IP", "Navigation failed for http://192.168.1.50/admin", ["192.168.1.50", "admin"]],
  ])("never leaks %s into the public report", (_label, raw, secrets) => {
    const message = toPublicError(new Error(raw));
    for (const secret of secrets) {
      expect(message).not.toContain(secret);
    }
    // It still has to say something useful.
    expect(message.length).toBeGreaterThan(0);
  });

  it("returns a generic reason for anything unrecognised", () => {
    expect(toPublicError(new Error("something nobody anticipated"))).toBe(
      "The page could not be scanned. Please check the URL and try again.",
    );
  });

  it("survives a non-Error being thrown", () => {
    expect(toPublicError("a bare string")).toContain("could not be scanned");
    expect(toPublicError(undefined)).toContain("could not be scanned");
    expect(toPublicError({ nested: { host: "10.0.0.1" } })).not.toContain("10.0.0.1");
  });
});
