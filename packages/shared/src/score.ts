import { IMPACT_WEIGHT } from "./constants";
import type { Impact } from "./schemas";

/**
 * Controls how quickly the score drops as weighted issues accumulate. With a
 * saturation of 30: no issues → 100, one critical (weight 10) → ~75,
 * a weighted penalty of 30 → 50, 90 → 25. The score approaches but never
 * reaches 0, and can never go negative.
 */
export const SCORE_SATURATION = 30;

/** Severity weight of a single impact (0 for an unrated issue). */
export function impactWeight(impact: Impact | null): number {
  return impact ? IMPACT_WEIGHT[impact] : 0;
}

/**
 * A single 0–100 accessibility score, weighted by issue severity so that a few
 * critical issues hurt far more than many minor ones. Shared between the worker
 * (which stores it) and the dashboard (which displays it).
 */
export function computeAccessibilityScore(impacts: Array<Impact | null>): number {
  const penalty = impacts.reduce<number>((sum, impact) => sum + impactWeight(impact), 0);
  if (penalty === 0) return 100;
  return Math.round((100 * SCORE_SATURATION) / (SCORE_SATURATION + penalty));
}

/** A human label + severity band for a score, so colour is never the only signal. */
export function scoreBand(score: number): { label: string; band: "good" | "fair" | "poor" } {
  if (score >= 90) return { label: "Good", band: "good" };
  if (score >= 50) return { label: "Needs work", band: "fair" };
  return { label: "Poor", band: "poor" };
}
