import type { WcagLevel } from "@ally-fix/shared";

/**
 * Helpers for reading WCAG metadata out of axe-core's rule tags.
 * Kept separate from the scanner so they can be unit-tested without a browser.
 */

/**
 * axe tags carry the WCAG success criterion as e.g. "wcag143" (→ 1.4.3) or
 * "wcag1410" (→ 1.4.10). First digit is the principle, second the guideline,
 * the rest the criterion number.
 */
export function extractWcagCriteria(tags: string[]): string | null {
  for (const tag of tags) {
    const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (match) return `${match[1]}.${match[2]}.${match[3]}`;
  }
  return null;
}

/** Level tags look like "wcag2a", "wcag21aa", "wcag22aaa". Prefer the strictest present. */
export function extractWcagLevel(tags: string[]): WcagLevel | null {
  const levelTags = tags.filter((tag) => /^wcag2\d?(a|aa|aaa)$/.test(tag));
  if (levelTags.some((tag) => tag.endsWith("aaa"))) return "AAA";
  if (levelTags.some((tag) => tag.endsWith("aa"))) return "AA";
  if (levelTags.some((tag) => tag.endsWith("a"))) return "A";
  return null;
}
