import { describe, expect, it } from "vitest";
import { analysisSystemPrompt, buildAnalysisPrompt, MAX_PROMPT_SNIPPETS } from "./prompt";

describe("buildAnalysisPrompt", () => {
  it("includes the rule id and the html snippets", () => {
    const prompt = buildAnalysisPrompt({
      ruleId: "image-alt",
      htmlSnippets: ['<img src="a.png">'],
    });
    expect(prompt).toContain("image-alt");
    expect(prompt).toContain('<img src="a.png">');
  });

  it("caps the number of snippets it includes", () => {
    const many = Array.from({ length: 10 }, (_, i) => `<img id="img-${i}">`);
    const prompt = buildAnalysisPrompt({ ruleId: "image-alt", htmlSnippets: many });
    const included = many.filter((snippet) => prompt.includes(snippet));
    expect(included).toHaveLength(MAX_PROMPT_SNIPPETS);
  });

  it("grounds a known rule in its WCAG criterion by default", () => {
    const prompt = buildAnalysisPrompt({ ruleId: "image-alt", htmlSnippets: ["<img>"] });
    expect(prompt).toContain("1.1.1 Non-text Content");
    expect(prompt).toContain("Level A");
    expect(prompt).toContain("https://www.w3.org/WAI/WCAG22/Understanding/non-text-content");
    expect(prompt).toContain("Images must have alternative text");
  });

  it("omits the reference block when grounding is turned off", () => {
    const input = { ruleId: "image-alt", htmlSnippets: ["<img>"] };
    const ungrounded = buildAnalysisPrompt(input, { grounded: false });
    expect(ungrounded).not.toContain("1.1.1");
    expect(ungrounded).not.toContain("Reference material");
    // Turning grounding off must leave the rest of the prompt untouched, or the
    // eval's two arms would differ by more than the thing being measured.
    expect(buildAnalysisPrompt(input).endsWith(ungrounded)).toBe(true);
  });

  it("falls back to the ungrounded prompt for a rule with no WCAG mapping", () => {
    // "region" is one of axe's best-practice rules: real, but tied to no criterion.
    const prompt = buildAnalysisPrompt({ ruleId: "region", htmlSnippets: ["<div>"] });
    expect(prompt).not.toContain("Reference material");
    expect(prompt).toBe(
      buildAnalysisPrompt({ ruleId: "region", htmlSnippets: ["<div>"] }, { grounded: false }),
    );
  });

  it("says nothing about a rule it does not know", () => {
    const prompt = buildAnalysisPrompt({ ruleId: "not-a-real-rule", htmlSnippets: ["<p>"] });
    expect(prompt).not.toContain("Reference material");
    expect(prompt).toContain("not-a-real-rule");
  });
});

describe("analysisSystemPrompt", () => {
  it("asks for the criterion to be cited only in the grounded variant", () => {
    expect(analysisSystemPrompt(true)).toContain("Name the success criterion");
    expect(analysisSystemPrompt(false)).not.toContain("Name the success criterion");
  });

  it("warns against deleting the element in both variants", () => {
    // The anti-deletion instruction is shared on purpose: if only the grounded
    // arm carried it, the eval would credit grounding for its effect.
    for (const grounded of [true, false]) {
      expect(analysisSystemPrompt(grounded)).toContain("Keep the element the rule is about");
    }
  });

  it("defaults to grounded", () => {
    expect(analysisSystemPrompt()).toBe(analysisSystemPrompt(true));
  });
});
