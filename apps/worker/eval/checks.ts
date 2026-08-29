import type { LlmIssueAnalysis } from "@ally-fix/shared";

/**
 * Cheap, deterministic checks on a model's answer — the ones that need no
 * browser and no judgement. They run before the axe oracle, because a fix that
 * is not even HTML should be reported as such rather than as "did not resolve".
 */

/** Tag names present in a snippet, lowercased, in document order. */
export function tagsIn(html: string): string[] {
  return [...html.matchAll(/<\s*([a-z][a-z0-9-]*)/gi)].map((m) => (m[1] ?? "").toLowerCase());
}

/**
 * Whether the fix kept the element the rule was about.
 *
 * This is the anti-gaming check, and the reason the oracle is trustworthy.
 * "Make axe stop reporting `image-alt`" has a trivial degenerate solution:
 * delete the `<img>`. That passes the oracle and helps nobody. A fix only counts
 * if the offending element still exists in it.
 */
export function preservesSubject(original: string, fixed: string, subjectTag?: string): boolean {
  const tag = subjectTag ?? tagsIn(original)[0];
  if (!tag) return true;
  return tagsIn(fixed).includes(tag);
}

/** Rough well-formedness: every opened non-void tag is closed, nothing stray. */
export function looksLikeHtml(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed || !trimmed.includes("<")) return false;

  const VOID = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const stack: string[] = [];
  for (const match of trimmed.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9-]*)([^>]*)>/gi)) {
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const selfClosing = (match[3] ?? "").trimEnd().endsWith("/");
    if (VOID.has(tag) || selfClosing) continue;
    if (closing) {
      if (stack.pop() !== tag) return false;
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

/** A fix that just restates the input teaches the developer nothing. */
export function isDifferentFromInput(original: string, fixed: string): boolean {
  const normalise = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return normalise(original) !== normalise(fixed);
}

export interface StaticCheckResult {
  fixParses: boolean;
  fixChanged: boolean;
  preservesSubject: boolean;
  explanationLength: number;
  affectedUsersCount: number;
}

export function runStaticChecks(
  original: string,
  analysis: LlmIssueAnalysis,
  subjectTag?: string,
): StaticCheckResult {
  return {
    fixParses: looksLikeHtml(analysis.fixCode),
    fixChanged: isDifferentFromInput(original, analysis.fixCode),
    preservesSubject: preservesSubject(original, analysis.fixCode, subjectTag),
    explanationLength: analysis.explanation.trim().length,
    affectedUsersCount: analysis.affectedUsers.length,
  };
}
