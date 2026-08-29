import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";

/**
 * The oracle.
 *
 * Evaluating an LLM's prose normally means asking another LLM whether it liked
 * it. This project does not have to: axe-core already decides, deterministically,
 * whether a rule is satisfied. So "is this fix any good?" becomes "does the rule
 * still fire?" — a real measurement rather than a second opinion.
 *
 * Only the rule under test is run. Fixing `image-alt` should not be marked wrong
 * because the snippet happens to trip some unrelated rule.
 */
export type RuleOutcome = "violates" | "passes" | "rule-not-run";

export interface AxeVerifier {
  check(html: string, ruleId: string): Promise<RuleOutcome>;
  close(): Promise<void>;
}

/**
 * A minimal valid document around the snippet. Without `lang` and a title the
 * wrapper itself would trip document-level rules; with them, the snippet is the
 * only thing under test.
 */
function wrap(html: string): string {
  return `<!doctype html><html lang="en"><head><title>eval</title></head><body>${html}</body></html>`;
}

export async function createAxeVerifier(): Promise<AxeVerifier> {
  const browser: Browser = await chromium.launch();
  const context = await browser.newContext();
  const page: Page = await context.newPage();

  return {
    async check(html, ruleId) {
      await page.setContent(wrap(html), { waitUntil: "domcontentloaded" });
      const results = await new AxeBuilder({ page }).withRules([ruleId]).analyze();

      if (results.violations.some((v) => v.id === ruleId)) return "violates";

      // A rule that appears in none of the four buckets never executed — usually
      // a typo in the rule id. Reporting that as "passes" would quietly turn a
      // broken case into a perfect score, which is the worst possible failure
      // mode for an oracle.
      const ran = [
        ...results.violations,
        ...results.passes,
        ...results.incomplete,
        ...results.inapplicable,
      ].some((r) => r.id === ruleId);

      return ran ? "passes" : "rule-not-run";
    },

    async close() {
      await browser.close();
    },
  };
}
