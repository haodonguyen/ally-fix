import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock DNS resolution so tests are deterministic and offline.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";
import { assertUrlIsSafe } from "./ssrf";

const mockLookup = vi.mocked(lookup);

function resolvesTo(ip: string, family = 4): void {
  mockLookup.mockResolvedValue([{ address: ip, family }] as never);
}

beforeEach(() => {
  mockLookup.mockReset();
});

describe("assertUrlIsSafe", () => {
  it("allows a public URL", async () => {
    resolvesTo("93.184.216.34");
    const result = await assertUrlIsSafe("https://example.com");
    expect(result.ok).toBe(true);
  });

  it("rejects non-http(s) schemes without a DNS lookup", async () => {
    const result = await assertUrlIsSafe("ftp://example.com");
    expect(result.ok).toBe(false);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects localhost by hostname without a DNS lookup", async () => {
    const result = await assertUrlIsSafe("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects the loopback address", async () => {
    resolvesTo("127.0.0.1");
    expect((await assertUrlIsSafe("http://127.0.0.1")).ok).toBe(false);
  });

  it("rejects private ranges (10/8, 192.168/16, 172.16/12)", async () => {
    resolvesTo("10.0.0.5");
    expect((await assertUrlIsSafe("http://a.example.com")).ok).toBe(false);
    resolvesTo("192.168.1.1");
    expect((await assertUrlIsSafe("http://b.example.com")).ok).toBe(false);
    resolvesTo("172.16.9.9");
    expect((await assertUrlIsSafe("http://c.example.com")).ok).toBe(false);
  });

  it("rejects the cloud metadata address", async () => {
    resolvesTo("169.254.169.254");
    expect((await assertUrlIsSafe("http://metadata.example.com")).ok).toBe(false);
  });

  it("rejects a domain that resolves (rebinds) to a private IP", async () => {
    resolvesTo("10.1.2.3");
    expect((await assertUrlIsSafe("https://evil.example.com")).ok).toBe(false);
  });

  it("rejects a malformed URL", async () => {
    expect((await assertUrlIsSafe("not a url")).ok).toBe(false);
  });
});
