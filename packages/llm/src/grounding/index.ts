import { AXE_CORE_VERSION, AXE_RULE_FACTS, type AxeRuleFacts } from "./axe-rules.generated";
import { WCAG_CRITERIA, understandingUrl, type WcagCriterion } from "./wcag-criteria";

/**
 * Grounding: the reference material a prompt carries about the rule it is asking
 * about, so the model reasons from the standard instead of from memory.
 *
 * Two sources, kept apart because their provenance differs. The axe half is
 * generated from the installed axe-core, so it cannot drift from what the
 * scanner actually runs. The WCAG half is written by hand at criterion level,
 * never per rule — see the note in `wcag-criteria.ts` on why that boundary is
 * what keeps the eval honest.
 *
 * A rule with no WCAG mapping (axe's best-practice checks) has no grounding, and
 * the prompt falls back to the ungrounded form. An invented citation would be
 * worse than none: it is exactly the failure this is meant to prevent.
 */
export { AXE_CORE_VERSION };
export type { AxeRuleFacts, WcagCriterion };

/**
 * At most this many criteria go into one prompt. A handful of rules map to three
 * or more; the tail adds tokens without adding much the model can act on.
 */
export const MAX_GROUNDED_CRITERIA = 2;

export interface RuleGrounding {
  ruleId: string;
  axe: AxeRuleFacts;
  criteria: WcagCriterion[];
}

/** Looks up what is known about `ruleId`. Returns null when nothing is. */
export function groundingFor(ruleId: string): RuleGrounding | null {
  const axe = AXE_RULE_FACTS[ruleId];
  if (!axe) return null;

  const criteria = axe.criteria
    .map((number) => WCAG_CRITERIA[number])
    .filter((criterion): criterion is WcagCriterion => criterion !== undefined)
    .slice(0, MAX_GROUNDED_CRITERIA);
  if (criteria.length === 0) return null;

  return { ruleId, axe, criteria };
}

/** Renders one criterion as prompt text. */
function formatCriterion(criterion: WcagCriterion): string {
  const lines = [
    `WCAG Success Criterion ${criterion.number} ${criterion.title} (Level ${criterion.level})`,
    `  Requirement: ${criterion.requirement}`,
    `  Who a failure hurts: ${criterion.affects}`,
    "  Accepted ways to satisfy it:",
    ...criterion.satisfy.map((way) => `    - ${way}`),
  ];
  if (criterion.note) lines.push(`  Note: ${criterion.note}`);
  lines.push(`  Reference: ${understandingUrl(criterion)}`);
  return lines.join("\n");
}

/**
 * The reference block that goes into the prompt above the failing markup.
 * Returns null when the rule is unknown, so the caller can omit the section
 * rather than emit an empty heading.
 */
export function formatGrounding(ruleId: string): string | null {
  const grounding = groundingFor(ruleId);
  if (!grounding) return null;

  return [
    "Reference material for this rule. Treat it as authoritative and prefer it over recollection.",
    "",
    `axe-core rule "${grounding.ruleId}": ${grounding.axe.help}.`,
    `  ${grounding.axe.description}.`,
    "",
    grounding.criteria.map(formatCriterion).join("\n\n"),
  ].join("\n");
}

/**
 * Every reference block this module can produce, in a stable order. Used to
 * fingerprint the prompt — see `promptFingerprint` in `prompt.ts`.
 */
export function allGroundingBlocks(): string[] {
  return Object.keys(AXE_RULE_FACTS)
    .sort()
    .map((ruleId) => formatGrounding(ruleId))
    .filter((block): block is string => block !== null);
}
