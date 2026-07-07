import type { IssueGroupInput } from "./types";

/** At most this many example snippets go into a prompt — enough context, bounded cost. */
export const MAX_PROMPT_SNIPPETS = 3;

export const ANALYSIS_SYSTEM_PROMPT = [
  "You are an accessibility expert helping a developer fix a WCAG issue that axe-core detected.",
  "Given the rule id and the HTML that triggered it, respond with:",
  "- explanation: what is wrong, in plain language a non-expert developer understands.",
  "- affectedUsers: the groups of people this hurts (e.g. screen reader users, keyboard-only users).",
  "- fixCode: a concrete, corrected HTML/code snippet based only on the provided markup.",
  "- priority: how urgently it should be fixed (low, medium, or high).",
  "Base your answer only on the HTML provided. The fix is a suggestion the developer must review.",
].join("\n");

/** Builds the user prompt for a rule group. Pure and deterministic, so it is easy to test. */
export function buildAnalysisPrompt(input: IssueGroupInput): string {
  const snippets = input.htmlSnippets
    .slice(0, MAX_PROMPT_SNIPPETS)
    .map((html, index) => `Example ${index + 1}:\n${html}`)
    .join("\n\n");

  return [
    `axe-core rule: ${input.ruleId}`,
    "",
    "The following HTML element(s) failed this rule:",
    snippets,
    "",
    "Explain why this matters, who is affected, and how to fix it.",
  ].join("\n");
}
