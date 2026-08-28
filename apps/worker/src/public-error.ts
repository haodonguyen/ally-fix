/**
 * Maps an internal scan error to a safe, user-facing reason.
 *
 * Audit reports are public: anyone with the URL can read the `error` column. Raw
 * exception text from Playwright or the DNS layer routinely carries internal
 * hostnames, container paths, and connection strings, so it must never be stored
 * verbatim. The full error is logged server-side instead.
 *
 * Lives in its own module because `index.ts` opens Redis connections, a Postgres
 * pool, and a BullMQ worker at import time — importing it from a test is not
 * possible, and a security-relevant mapping deserves tests.
 */
export function toPublicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unsafe URL|blockedbyclient|ERR_BLOCKED/i.test(message)) {
    return "This URL could not be scanned because it points to a disallowed address.";
  }
  if (/timeout|timed out/i.test(message)) {
    return "The page took too long to load and the scan timed out.";
  }
  return "The page could not be scanned. Please check the URL and try again.";
}
