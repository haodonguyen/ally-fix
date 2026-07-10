// Dogfoods AllyFix on itself: runs axe against the home page and a seeded report
// page, failing (exit 1) if there are any WCAG 2.2 A/AA violations.
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { A11Y_AUDIT_ID } from "./fixture";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const targets = [
  { name: "home", url: `${BASE}/`, waitForScore: false },
  { name: "report", url: `${BASE}/audits/${A11Y_AUDIT_ID}`, waitForScore: true },
];

const browser = await chromium.launch();
let totalViolations = 0;

for (const target of targets) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(target.url, { waitUntil: "networkidle", timeout: 30_000 });
  if (target.waitForScore) {
    await page.getByRole("heading", { name: "Score" }).waitFor({ timeout: 20_000 });
    // Expand the first issue so the accordion's inner content is audited too.
    await page
      .getByRole("button", { name: /occurrence/i })
      .first()
      .click();
  }

  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  console.log(`${target.name}: ${results.violations.length} WCAG A/AA violation(s)`);
  for (const violation of results.violations) {
    console.log(`  [${violation.impact}] ${violation.id} — ${violation.help}`);
  }
  totalViolations += results.violations.length;
  await context.close();
}

await browser.close();

if (totalViolations > 0) {
  console.error(`\nFAIL: ${totalViolations} WCAG 2.2 A/AA violation(s) on AllyFix's own pages.`);
  process.exit(1);
}
console.log("\nPASS: 0 WCAG 2.2 A/AA violations.");
process.exit(0);
