import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF protection (required from Phase 1), shared by the web API (at enqueue time)
 * and the worker (at scan time). AllyFix only scans public pages, so we resolve a
 * URL's hostname and reject anything pointing at the loopback interface, a private
 * network, or a cloud metadata endpoint (169.254.169.254).
 *
 * This lives in a Node-only subpath (`@ally-fix/shared/ssrf`) and is never exported
 * from the package index, so it never reaches the browser bundle.
 */
export type SsrfResult = { ok: true; url: string } | { ok: false; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal", // GCP metadata
]);

export async function assertUrlIsSafe(rawUrl: string): Promise<SsrfResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "That doesn't look like a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http and https URLs can be scanned." };
  }

  // URL keeps IPv6 literals wrapped in brackets (e.g. "[::1]"); strip them so
  // both the blocklist and dns.lookup see the bare host.
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: "This host is not allowed." };
  }

  // For an IP literal we check it directly; otherwise resolve the hostname and
  // reject if ANY resolved address is internal.
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      return { ok: false, reason: "Could not resolve that host." };
    }
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return { ok: false, reason: "That URL resolves to a private or internal address." };
  }

  return { ok: true, url: parsed.toString() };
}

function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // Unknown format — fail closed.
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return true; // Malformed — fail closed.
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // "this", private, loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const address = ip.toLowerCase();
  if (address === "::1" || address === "::") return true; // loopback, unspecified

  // IPv4-mapped addresses like ::ffff:169.254.169.254 — check the embedded IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);

  const firstGroup = address.split(":")[0] ?? "";
  if (firstGroup.startsWith("fc") || firstGroup.startsWith("fd")) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(firstGroup)) return true; // fe80::/10 link-local
  return false;
}
