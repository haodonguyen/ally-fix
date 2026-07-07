import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt, MAX_PROMPT_SNIPPETS } from "./prompt";

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
});
