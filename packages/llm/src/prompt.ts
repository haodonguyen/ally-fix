import { allGroundingBlocks, formatGrounding } from "./grounding";
import type { IssueGroupInput } from "./types";

/** At most this many example snippets go into a prompt — enough context, bounded cost. */
export const MAX_PROMPT_SNIPPETS = 3;

const BASE_INSTRUCTIONS = [
  "You are an accessibility expert helping a developer fix a WCAG issue that axe-core detected.",
  "Given the rule id and the HTML that triggered it, respond with:",
  "- explanation: what is wrong, in plain language a non-expert developer understands.",
  "- affectedUsers: the groups of people this hurts (e.g. screen reader users, keyboard-only users).",
  "- fixCode: a concrete, corrected HTML/code snippet based only on the provided markup.",
  "- priority: how urgently it should be fixed (low, medium, or high).",
  "Base your answer only on the HTML provided. The fix is a suggestion the developer must review.",
  // Deleting the offending element silences the checker and helps nobody. This
  // belongs to both prompt variants, not to grounding: putting it in only the
  // grounded arm would let it take credit for grounding's improvement.
  "Keep the element the rule is about. Removing it makes the checker stop complaining without fixing anything.",
  "Respond with a single valid JSON object containing exactly those fields, and nothing else.",
];

const GROUNDED_INSTRUCTIONS = [
  "The prompt includes reference material for the rule: what axe-core checks, and the WCAG success criteria behind it.",
  "Ground your answer in that material rather than in recollection, and prefer the mechanisms it lists.",
  "Name the success criterion by number and title in your explanation.",
  "If the reference does not cover the case in front of you, say so plainly instead of inventing a citation.",
];

/**
 * The system prompt. Grounded and ungrounded variants exist so the eval can run
 * both and attribute the difference — see `docs/adr/0007-*`.
 */
export function analysisSystemPrompt(grounded = true): string {
  return (grounded ? [...BASE_INSTRUCTIONS, "", ...GROUNDED_INSTRUCTIONS] : BASE_INSTRUCTIONS).join(
    "\n",
  );
}

export interface BuildPromptOptions {
  /** Include the WCAG/axe reference block. Default true. */
  grounded?: boolean;
}

/** Builds the user prompt for a rule group. Pure and deterministic, so it is easy to test. */
export function buildAnalysisPrompt(
  input: IssueGroupInput,
  options: BuildPromptOptions = {},
): string {
  const snippets = input.htmlSnippets
    .slice(0, MAX_PROMPT_SNIPPETS)
    .map((html, index) => `Example ${index + 1}:\n${html}`)
    .join("\n\n");

  // A rule outside axe's WCAG mapping has no reference block; the prompt then
  // reads exactly like the ungrounded one instead of announcing an empty section.
  const grounding = options.grounded === false ? null : formatGrounding(input.ruleId);

  return [
    ...(grounding ? [grounding, ""] : []),
    `axe-core rule: ${input.ruleId}`,
    "",
    "The following HTML element(s) failed this rule:",
    snippets,
    "",
    "Explain why this matters, who is affected, and how to fix it.",
  ].join("\n");
}

/**
 * FNV-1a. Not a security hash — this only has to change when the prompt changes.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A short id for "the prompt this client sends".
 *
 * Callers that cache an answer must put it in the key. An answer produced by a
 * different prompt is a different answer, and a 30-day cache would otherwise go
 * on serving pre-grounding results long after the change shipped — hiding the
 * very thing the eval is trying to measure.
 *
 * It covers the rendered reference material, not just the system prompt, so
 * editing a criterion in `wcag-criteria.ts` invalidates the entries that were
 * generated from the old wording. That is the point: nobody has to remember to
 * bump a version constant.
 */
export function promptFingerprint(grounded = true): string {
  const material = grounded ? allGroundingBlocks().join("\n") : "";
  return fnv1a(`${analysisSystemPrompt(grounded)}\n${material}`);
}
