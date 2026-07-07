import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF protection (required from Phase 1).
 *
 * AllyFix only scans public pages. Before we hand a URL to the worker we resolve
 * its hostname and reject anything that points at the loopback interface, a
 * private network, or a cloud metadata endpoint (169.254.169.254) — the classic
 * targets of a server-side request forgery.
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

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: "This host is not allowed." };
  }

  // Resolve the hostname and reject if ANY resolved address is internal. This also
  // covers IP literals, since dns.lookup returns them unchanged.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "Could not resolve that host." };
  }

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
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
