import AxeBuilder from "@axe-core/playwright";
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
  const browser = await chromium.launch();
  try {
    // axe-core/playwright requires a page created from an explicit browser context.
    const context = await browser.newContext();
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
