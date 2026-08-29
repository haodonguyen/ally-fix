import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { AXE_CORE_VERSION, AXE_RULE_FACTS } from "./axe-rules.generated";
import { formatGrounding, groundingFor, MAX_GROUNDED_CRITERIA } from "./index";
import { understandingUrl, WCAG_CRITERIA } from "./wcag-criteria";

/** The same tag parse the generator uses, restated here so the test is independent of it. */
function criteriaFromTags(tags: string[]): string[] {
  const found = new Set<string>();
  for (const tag of tags) {
    const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (match) found.add(`${match[1]}.${match[2]}.${match[3]}`);
  }
  return [...found].sort();
}

describe("the generated rule catalogue", () => {
  // These are the tests that stop the prompt from quietly describing a version
  // of axe the scanner no longer runs. Upgrading axe-core fails the build until
  // `pnpm --filter @ally-fix/llm grounding:generate` has been run.
  it("was generated from the axe-core that is installed", () => {
    expect(AXE_CORE_VERSION).toBe(axe.version);
  });

  it("covers exactly the WCAG-mapped rules axe ships", () => {
    const expected = axe
      .getRules()
      .filter((rule) => criteriaFromTags(rule.tags).length > 0)
      .map((rule) => rule.ruleId)
      .sort();
    expect(Object.keys(AXE_RULE_FACTS).sort()).toEqual(expected);
  });

  it("reproduces axe's own wording and criterion mapping", () => {
    for (const rule of axe.getRules()) {
      const facts = AXE_RULE_FACTS[rule.ruleId];
      if (!facts) continue;
      expect(facts.help).toBe(rule.help);
      expect(facts.description).toBe(rule.description);
      expect(facts.criteria).toEqual(criteriaFromTags(rule.tags));
    }
  });
});

describe("the curated criteria table", () => {
  it("has an entry for every criterion the rules reference", () => {
    const referenced = new Set(Object.values(AXE_RULE_FACTS).flatMap((facts) => facts.criteria));
    const missing = [...referenced].filter((number) => !WCAG_CRITERIA[number]);
    expect(missing).toEqual([]);
  });

  it("has no entry no rule references — dead reference material is still drift", () => {
    const referenced = new Set(Object.values(AXE_RULE_FACTS).flatMap((facts) => facts.criteria));
    const unused = Object.keys(WCAG_CRITERIA).filter((number) => !referenced.has(number));
    expect(unused).toEqual([]);
  });

  it("keys every entry by its own number", () => {
    for (const [key, criterion] of Object.entries(WCAG_CRITERIA)) {
      expect(criterion.number).toBe(key);
    }
  });

  it("gives every entry a requirement, an affected group, and a way to satisfy it", () => {
    for (const criterion of Object.values(WCAG_CRITERIA)) {
      expect(criterion.requirement.length).toBeGreaterThan(20);
      expect(criterion.affects.length).toBeGreaterThan(10);
      expect(criterion.satisfy.length).toBeGreaterThan(0);
    }
  });

  it("builds W3C Understanding URLs from the title", () => {
    const criterion = (number: string) => {
      const found = WCAG_CRITERIA[number];
      if (!found) throw new Error(`no curated entry for ${number}`);
      return found;
    };
    expect(understandingUrl(criterion("1.1.1"))).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content",
    );
    expect(understandingUrl(criterion("1.4.3"))).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum",
    );
    expect(understandingUrl(criterion("2.4.4"))).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context",
    );
    expect(understandingUrl(criterion("2.2.2"))).toBe(
      "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide",
    );
  });

  it("produces a slug with no characters that would break the URL", () => {
    for (const criterion of Object.values(WCAG_CRITERIA)) {
      const slug = understandingUrl(criterion).split("/").pop();
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("groundingFor", () => {
  it("joins axe's facts to the criteria behind them", () => {
    const grounding = groundingFor("label");
    expect(grounding?.axe.help).toContain("labels");
    expect(grounding?.criteria.map((c) => c.number)).toContain("4.1.2");
  });

  it("bounds how many criteria one prompt carries", () => {
    for (const ruleId of Object.keys(AXE_RULE_FACTS)) {
      const grounding = groundingFor(ruleId);
      expect(grounding?.criteria.length).toBeLessThanOrEqual(MAX_GROUNDED_CRITERIA);
    }
  });

  it("returns null for a rule outside the catalogue", () => {
    expect(groundingFor("region")).toBeNull();
    expect(groundingFor("no-such-rule")).toBeNull();
  });

  it("has grounding for every rule in the catalogue", () => {
    const ungrounded = Object.keys(AXE_RULE_FACTS).filter((id) => groundingFor(id) === null);
    expect(ungrounded).toEqual([]);
  });
});

describe("formatGrounding", () => {
  it("states the requirement, the harm, and the accepted fixes", () => {
    const block = formatGrounding("button-name") ?? "";
    expect(block).toContain('axe-core rule "button-name"');
    expect(block).toContain("WCAG Success Criterion 4.1.2 Name, Role, Value (Level A)");
    expect(block).toContain("Who a failure hurts:");
    expect(block).toContain("Accepted ways to satisfy it:");
    expect(block).toContain("https://www.w3.org/WAI/WCAG22/Understanding/name-role-value");
  });

  it("carries the note on a criterion WCAG has retired", () => {
    // 4.1.1 Parsing was dropped in WCAG 2.2. A developer told to fix a duplicate
    // id deserves to know the criterion behind it no longer exists.
    const block = formatGrounding("duplicate-id-active") ?? "";
    expect(block).toContain("Note: Removed in WCAG 2.2");
    expect(formatGrounding("button-name")).not.toContain("Note:");
  });

  it("returns null rather than an empty heading for an unknown rule", () => {
    expect(formatGrounding("no-such-rule")).toBeNull();
  });

  it("renders every rule in the catalogue without blowing up the prompt", () => {
    for (const ruleId of Object.keys(AXE_RULE_FACTS)) {
      const block = formatGrounding(ruleId);
      expect(block).not.toBeNull();
      // Roughly 600 tokens. The reference is context, not the bulk of the call.
      expect(block!.length).toBeLessThan(2400);
    }
  });
});
