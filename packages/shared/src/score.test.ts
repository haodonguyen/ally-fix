import { describe, expect, it } from "vitest";
import { computeAccessibilityScore, scoreBand } from "./score";

describe("computeAccessibilityScore", () => {
  it("is 100 when there are no issues", () => {
    expect(computeAccessibilityScore([])).toBe(100);
  });

  it("ignores null impacts", () => {
    expect(computeAccessibilityScore([null, null])).toBe(100);
  });

  it("penalises a critical issue more than a minor one", () => {
    expect(computeAccessibilityScore(["critical"])).toBeLessThan(
      computeAccessibilityScore(["minor"]),
    );
  });

  it("stays in range and keeps dropping as issues accumulate", () => {
    const few = computeAccessibilityScore(["serious"]);
    const many = computeAccessibilityScore(Array.from({ length: 20 }, () => "critical" as const));
    expect(few).toBeLessThanOrEqual(100);
    expect(many).toBeGreaterThanOrEqual(0);
    expect(many).toBeLessThan(few);
  });
});

describe("scoreBand", () => {
  it("maps scores to bands", () => {
    expect(scoreBand(95).band).toBe("good");
    expect(scoreBand(70).band).toBe("fair");
    expect(scoreBand(20).band).toBe("poor");
  });
});
