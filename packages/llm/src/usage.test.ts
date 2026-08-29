import { describe, expect, it } from "vitest";
import { addUsage, defaultPricesFor, estimateCostUsd, readUsage, type TokenUsage } from "./usage";

const sdkUsage = {
  inputTokens: 1200,
  outputTokens: 300,
  totalTokens: 1500,
  inputTokenDetails: { noCacheTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 220, reasoningTokens: 80 },
};

describe("readUsage", () => {
  it("reads the AI SDK's usage object", () => {
    expect(readUsage(sdkUsage)).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 80,
      totalTokens: 1500,
    });
  });

  it("returns null when the provider reported nothing", () => {
    // The distinction that matters: a provider that stays silent must not look
    // like a call that was free, or the silent ones average the cost down.
    expect(readUsage(undefined)).toBeNull();
    expect(readUsage(null)).toBeNull();
    expect(readUsage({})).toBeNull();
    expect(readUsage({ inputTokens: undefined, outputTokens: undefined })).toBeNull();
  });

  it("keeps a partial report rather than discarding it", () => {
    expect(readUsage({ totalTokens: 900 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 900,
    });
  });

  it("reconstructs a missing total from the breakdown, but prefers a reported one", () => {
    expect(readUsage({ inputTokens: 10, outputTokens: 5 })?.totalTokens).toBe(15);
    // Providers that bill for more than input+output (tool tokens, images) report
    // their own total. Recomputing it would quietly undercount the bill.
    expect(readUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 40 })?.totalTokens).toBe(40);
  });

  it("ignores values that are not finite numbers", () => {
    expect(readUsage({ inputTokens: "1200", outputTokens: NaN })).toBeNull();
  });

  it("survives a provider that omits the output-token breakdown", () => {
    expect(readUsage({ inputTokens: 5, outputTokens: 5 })?.reasoningTokens).toBe(0);
  });
});

describe("addUsage", () => {
  const a: TokenUsage = { inputTokens: 10, outputTokens: 2, reasoningTokens: 1, totalTokens: 12 };
  const b: TokenUsage = { inputTokens: 20, outputTokens: 4, reasoningTokens: 0, totalTokens: 24 };

  it("sums every field", () => {
    expect(addUsage(a, b)).toEqual({
      inputTokens: 30,
      outputTokens: 6,
      reasoningTokens: 1,
      totalTokens: 36,
    });
  });

  it("treats null as nothing measured, not as zero", () => {
    // Adding an unmeasured call must not invent a zero-token attempt.
    expect(addUsage(null, b)).toBe(b);
    expect(addUsage(a, null)).toBe(a);
    expect(addUsage(null, null)).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  const prices = { inputPerMTok: 0.5, outputPerMTok: 1.5 };
  const used: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 400_000,
    totalTokens: 2_000_000,
  };

  it("charges input and output at their own rates", () => {
    expect(estimateCostUsd(used, prices)).toBeCloseTo(2.0);
  });

  it("does not bill reasoning tokens twice", () => {
    // Providers report reasoning as a slice of outputTokens, so the output term
    // has already paid for it. Adding it again inflates every reasoning model.
    const noReasoning = { ...used, reasoningTokens: 0 };
    expect(estimateCostUsd(used, prices)).toBe(estimateCostUsd(noReasoning, prices));
  });

  it("returns null when there is no rate, rather than a free-looking zero", () => {
    expect(estimateCostUsd(used, null)).toBeNull();
  });

  it("returns null when nothing was measured", () => {
    expect(estimateCostUsd(null, prices)).toBeNull();
  });

  it("scales linearly and handles small counts without rounding to zero", () => {
    const small: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1000,
    };
    expect(estimateCostUsd(small, prices)).toBeCloseTo(0.0005);
  });
});

describe("defaultPricesFor", () => {
  it("prices a local Ollama at zero, because it genuinely bills nothing per token", () => {
    expect(defaultPricesFor("ollama")).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it("refuses to guess a hosted provider's rate", () => {
    // Published prices go stale and differ per account. Null means "the operator
    // has not told us", which is the truth; a shipped number would be a guess
    // presented as a measurement.
    expect(defaultPricesFor("groq")).toBeNull();
    expect(defaultPricesFor("gemini")).toBeNull();
  });
});
