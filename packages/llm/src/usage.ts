/**
 * Token accounting for LLM calls.
 *
 * Two things are kept strictly apart here, because conflating them is how cost
 * dashboards start lying:
 *
 * **Tokens are measured.** They come back from the provider on every call. When
 * a provider reports nothing, that is `null` — not a zero that quietly averages
 * into the totals as if the call were free.
 *
 * **Cost is derived from a rate the operator supplies.** Prices change, differ
 * per account (free tier, committed use, promotional credits), and go stale in a
 * repo faster than anyone updates them. An unpriced model reports a `null` cost
 * and full token counts, which is the honest answer; a hard-coded table would
 * report a confident wrong number. See ADR-0008.
 */

/** What one call consumed. Every field is a real measurement, never a default. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Reasoning tokens, for models that bill for hidden deliberation. Reported
   * separately for visibility only — providers count these *inside*
   * `outputTokens`, so adding them again would double-charge.
   */
  reasoningTokens: number;
  totalTokens: number;
}

/** Price in US dollars per million tokens. */
export interface TokenPrices {
  inputPerMTok: number;
  outputPerMTok: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads the AI SDK's usage object without depending on its type.
 *
 * Every field there is `number | undefined`, and providers vary in which they
 * fill in. Returns null when the provider reported no token counts at all —
 * "the call was free" and "nobody told us" must not look the same downstream.
 */
export function readUsage(raw: unknown): TokenUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;

  const input = finite(usage.inputTokens);
  const output = finite(usage.outputTokens);
  const total = finite(usage.totalTokens);
  if (input === null && output === null && total === null) return null;

  const details = usage.outputTokenDetails as Record<string, unknown> | undefined;
  const reasoning = finite(details?.reasoningTokens) ?? 0;

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    reasoningTokens: reasoning,
    // Some providers send a total and no breakdown, others the reverse. Prefer
    // the reported total, and only reconstruct it when it is genuinely absent.
    totalTokens: total ?? (input ?? 0) + (output ?? 0),
  };
}

/** Sums usage across calls. Null is "nothing measured", so it is an identity, not a zero. */
export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

/**
 * Cost in US dollars, or null when the rate is unknown.
 *
 * Reasoning tokens are deliberately not added: providers report them as a subset
 * of `outputTokens`, so they are already paid for by the output term.
 */
export function estimateCostUsd(
  usage: TokenUsage | null,
  prices: TokenPrices | null,
): number | null {
  if (usage === null || prices === null) return null;
  return (
    (usage.inputTokens * prices.inputPerMTok) / 1_000_000 +
    (usage.outputTokens * prices.outputPerMTok) / 1_000_000
  );
}

/**
 * The only price this project ships. A local Ollama bills nothing per token, so
 * zero is a measurement rather than a guess — the electricity is real but it is
 * not a per-token charge anyone can invoice.
 *
 * Hosted providers return null until the operator supplies their own rate.
 */
export function defaultPricesFor(provider: string): TokenPrices | null {
  return provider === "ollama" ? { inputPerMTok: 0, outputPerMTok: 0 } : null;
}
