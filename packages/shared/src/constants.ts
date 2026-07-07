import type { Impact } from "./schemas";

/** Name of the BullMQ queue that carries audit jobs from the web app to the worker. */
export const AUDIT_QUEUE_NAME = "audit-scan";

/**
 * Relative weight of each axe-core impact level.
 * Used in Phase 3 to compute a severity-weighted accessibility score:
 * a handful of "critical" issues should hurt the score far more than many
 * "minor" ones. Kept here so the web app and worker agree on the weighting.
 */
export const IMPACT_WEIGHT: Record<Impact, number> = {
  minor: 1,
  moderate: 3,
  serious: 7,
  critical: 10,
};

/**
 * Standard-practice disclaimer. axe-core only detects ~30–40% of WCAG criteria,
 * so every report must state that this is an automated scan, not a substitute
 * for manual testing. Surfacing this is a credibility signal, not a weakness.
 */
export const AUTOMATED_SCAN_DISCLAIMER =
  "This is an automated scan. Automated tools catch roughly 30–40% of WCAG success " +
  "criteria and cannot replace manual testing with assistive technology. " +
  "This report is not a legal certification of compliance.";
