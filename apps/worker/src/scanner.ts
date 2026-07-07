import AxeBuilder from "@axe-core/playwright";
import { assertUrlIsSafe } from "@ally-fix/shared/ssrf";
import { chromium } from "playwright";
import type { Impact, WcagLevel } from "@ally-fix/shared";
import { extractWcagCriteria, extractWcagLevel } from "./wcag";

/**
 * A single accessibility issue produced by a scan, before it is tied to an audit.
 * Mirrors the columns of the `issues` table minus `auditId` (added by the caller).
 */
export interface ScannedIssue {
  ruleId: string;
  wcagCriteria: string | null;
  wcagLevel: WcagLevel | null;
  impact: Impact | null;
  htmlSnippet: string;
  selector: string;
  rawAxe: unknown;
}

/**
 * Open `url` in a headless browser and run axe-core against it.
 * Returns one ScannedIssue per offending DOM node (axe groups nodes under each
 * rule violation; we flatten them so every issue maps to one row).
 */
export async function scanUrl(url: string, timeoutMs: number): Promise<ScannedIssue[]> {
  // SSRF is enforced here, where the request is actually made — not only at the
  // API. Re-validate the entry URL, then block every request (including redirects
  // and sub-resources) whose host resolves to an internal address. This closes the
  // redirect-to-internal and DNS-rebinding gaps the API-time check can't cover.
  const entry = await assertUrlIsSafe(url);
  if (!entry.ok) throw new Error(`Refusing to scan unsafe URL: ${entry.reason}`);

  // Memoise the safety check per host for the duration of this scan.
  const hostChecks = new Map<string, Promise<boolean>>();
  const isRequestAllowed = (requestUrl: string): Promise<boolean> => {
    let host: string;
    try {
      host = new URL(requestUrl).host;
    } catch {
      return Promise.resolve(false);
    }
    let check = hostChecks.get(host);
    if (!check) {
      check = assertUrlIsSafe(requestUrl).then((result) => result.ok);
      hostChecks.set(host, check);
    }
    return check;
  };

  const browser = await chromium.launch();
  try {
    // axe-core/playwright requires a page created from an explicit browser context.
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      if (await isRequestAllowed(route.request().url())) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

    const results = await new AxeBuilder({ page }).analyze();

    const issues: ScannedIssue[] = [];
    for (const violation of results.violations) {
      const wcagCriteria = extractWcagCriteria(violation.tags);
      const wcagLevel = extractWcagLevel(violation.tags);
      for (const node of violation.nodes) {
        issues.push({
          ruleId: violation.id,
          wcagCriteria,
          wcagLevel,
          impact: (node.impact ?? violation.impact ?? null) as Impact | null,
          htmlSnippet: node.html,
          selector: node.target.map(String).join(", "),
          rawAxe: node,
        });
      }
    }
    return issues;
  } finally {
    await browser.close();
  }
}
