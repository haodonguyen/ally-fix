import { describe, expect, it } from "vitest";
import { extractWcagCriteria, extractWcagLevel } from "./wcag";

describe("extractWcagCriteria", () => {
  it("parses a single-digit criterion", () => {
    expect(extractWcagCriteria(["cat.text-alternatives", "wcag2a", "wcag111"])).toBe("1.1.1");
  });

  it("parses a multi-digit criterion", () => {
    expect(extractWcagCriteria(["wcag1410"])).toBe("1.4.10");
  });

  it("returns null when no criterion tag is present", () => {
    expect(extractWcagCriteria(["best-practice", "cat.forms"])).toBeNull();
  });
});

describe("extractWcagLevel", () => {
  it("detects level A", () => {
    expect(extractWcagLevel(["wcag2a", "wcag111"])).toBe("A");
  });

  it("detects level AA", () => {
    expect(extractWcagLevel(["wcag2aa", "wcag143"])).toBe("AA");
  });

  it("prefers the strictest level present", () => {
    expect(extractWcagLevel(["wcag2a", "wcag2aaa"])).toBe("AAA");
  });

  it("returns null when no level tag is present", () => {
    expect(extractWcagLevel(["best-practice"])).toBeNull();
  });
});
