import { describe, expect, it } from "vitest";
import {
  isDifferentFromInput,
  looksLikeHtml,
  preservesSubject,
  runStaticChecks,
  tagsIn,
} from "./checks";

describe("tagsIn", () => {
  it("lists tags in document order, lowercased", () => {
    expect(tagsIn('<A href="/x"><IMG src="y"></A>')).toEqual(["a", "img"]);
  });

  it("returns nothing for text with no markup", () => {
    expect(tagsIn("just words")).toEqual([]);
  });
});

describe("preservesSubject — the anti-gaming check", () => {
  it("accepts a fix that keeps the element and adds the attribute", () => {
    expect(preservesSubject('<img src="a.png">', '<img src="a.png" alt="A cat">')).toBe(true);
  });

  it("rejects a fix that simply deletes the offending element", () => {
    // This is the degenerate solution: axe stops reporting image-alt because
    // there is no image any more. It passes the oracle and helps nobody, so the
    // oracle alone cannot be trusted without this.
    expect(preservesSubject('<img src="a.png">', "<div></div>")).toBe(false);
  });

  it("rejects replacing the element with a different one", () => {
    expect(preservesSubject("<button></button>", '<a href="/x">Save</a>')).toBe(false);
  });

  it("uses an explicit subject when the first tag is not the one under test", () => {
    const original = '<map name="m"><area shape="rect" href="/a"></map>';
    // Keeping <map> but dropping <area> is still a deletion of the subject.
    expect(preservesSubject(original, '<map name="m"></map>', "area")).toBe(false);
    expect(preservesSubject(original, '<map name="m"><area alt="A" href="/a"></map>', "area")).toBe(
      true,
    );
  });
});

describe("looksLikeHtml", () => {
  it.each([
    ['<img src="a.png" alt="A cat">', true],
    ["<button>Save</button>", true],
    ['<a href="/x"><img src="l.png" alt="Home"></a>', true],
    ["<ul><li>One</li></ul>", true],
    ['<input type="text" aria-label="Email" />', true],
  ])("accepts %s", (html, expected) => {
    expect(looksLikeHtml(html)).toBe(expected);
  });

  it.each([
    ["Add an alt attribute to the image.", "prose instead of markup"],
    ["<button>Save", "unclosed tag"],
    ["<div><span></div></span>", "crossed tags"],
    ["", "empty"],
  ])("rejects %s (%s)", (html) => {
    expect(looksLikeHtml(html)).toBe(false);
  });
});

describe("isDifferentFromInput", () => {
  it("rejects a fix that only reformats the input", () => {
    expect(isDifferentFromInput('<img  src="a.png">', '<img src="a.png">')).toBe(false);
  });

  it("accepts a fix that actually adds something", () => {
    expect(isDifferentFromInput('<img src="a.png">', '<img src="a.png" alt="A cat">')).toBe(true);
  });
});

describe("runStaticChecks", () => {
  it("summarises a good answer", () => {
    const result = runStaticChecks('<img src="a.png">', {
      explanation: "Screen readers announce nothing for this image.",
      affectedUsers: ["screen reader users"],
      fixCode: '<img src="a.png" alt="A tabby cat asleep on a windowsill">',
      priority: "high",
    });

    expect(result).toMatchObject({
      fixParses: true,
      fixChanged: true,
      preservesSubject: true,
      affectedUsersCount: 1,
    });
    expect(result.explanationLength).toBeGreaterThan(20);
  });

  it("flags an answer whose fix is prose rather than code", () => {
    const result = runStaticChecks('<img src="a.png">', {
      explanation: "x",
      affectedUsers: ["screen reader users"],
      fixCode: "Just add an alt attribute.",
      priority: "high",
    });

    expect(result.fixParses).toBe(false);
  });
});
