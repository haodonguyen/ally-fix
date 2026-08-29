/**
 * The WCAG success criteria that axe-core's rules map to.
 *
 * Hand-written, unlike `axe-rules.generated.ts`. Every entry is a *paraphrase*
 * of the normative requirement, not a quotation: the prompt needs the model to
 * reason with the rule, and a link lets the developer check the wording against
 * the source. `understandingUrl()` builds that link from the title.
 *
 * Deliberately criterion-level, never rule-level. Writing per-rule fix hints for
 * the rules the eval happens to cover would teach to the test — the score would
 * rise without the system getting better at the other 60-odd rules. Twenty-nine
 * criteria cover all 75 of axe's WCAG-mapped rules, so nothing here is tuned to
 * a case in the golden set.
 *
 * Source: W3C, Web Content Accessibility Guidelines 2.2 (https://www.w3.org/TR/WCAG22/).
 */
export type WcagLevel = "A" | "AA" | "AAA";

export interface WcagCriterion {
  /** Dotted criterion number, e.g. "1.1.1". */
  number: string;
  /** Official title, e.g. "Non-text Content". Also the source of the URL slug. */
  title: string;
  level: WcagLevel;
  /** What the criterion requires, in our own words. One or two sentences. */
  requirement: string;
  /** Who a failure actually hurts. */
  affects: string;
  /** Accepted ways to satisfy it — the mechanisms, not a specific snippet. */
  satisfy: string[];
  /** Set when WCAG itself has retired the criterion, so the note reaches the reader. */
  note?: string;
}

/** The W3C Understanding page, whose slug is the lowercased title minus punctuation. */
export function understandingUrl(criterion: WcagCriterion): string {
  const slug = criterion.title
    .toLowerCase()
    .replace(/[(),.]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `https://www.w3.org/WAI/WCAG22/Understanding/${slug}`;
}

const CRITERIA: WcagCriterion[] = [
  {
    number: "1.1.1",
    title: "Non-text Content",
    level: "A",
    requirement:
      "Every non-text element carries a text alternative that serves the same purpose. Purely decorative content is the exception, and must be hidden from assistive technology instead.",
    affects: "Screen reader users, and anyone whose images fail to load.",
    satisfy: [
      "An alt attribute on img, input type=image, and area.",
      "aria-label or aria-labelledby where no native alternative exists.",
      "Text inside the element itself, as with object or svg title.",
      'alt="" plus role="presentation" for decoration that carries no meaning.',
    ],
  },
  {
    number: "1.2.1",
    title: "Audio-only and Video-only (Prerecorded)",
    level: "A",
    requirement:
      "Prerecorded audio-only and video-only content has an alternative that presents the same information.",
    affects: "Deaf and hard-of-hearing users; blind users, for video-only content.",
    satisfy: ["A transcript for audio-only.", "A text or audio description for video-only."],
  },
  {
    number: "1.2.2",
    title: "Captions (Prerecorded)",
    level: "A",
    requirement: "Prerecorded audio in synchronised media is captioned.",
    affects: "Deaf and hard-of-hearing users.",
    satisfy: ['A caption track, e.g. <track kind="captions"> on video.'],
  },
  {
    number: "1.3.1",
    title: "Info and Relationships",
    level: "A",
    requirement:
      "Structure and relationships conveyed visually are also available programmatically. If sighted users can see that something is a heading, a list, or a label for a field, assistive technology must be able to determine the same.",
    affects: "Screen reader users, who lose the structure sighted users read from layout.",
    satisfy: [
      "Semantic elements: heading levels, ul/ol/dl, table with th and scope, fieldset with legend.",
      "label with a for attribute matching the control's id.",
      "ARIA roles and relationship attributes where no native element fits.",
    ],
  },
  {
    number: "1.3.4",
    title: "Orientation",
    level: "AA",
    requirement:
      "Content does not lock itself to one screen orientation unless that orientation is essential.",
    affects: "Users with a device fixed in one orientation, including wheelchair-mounted devices.",
    satisfy: ["Support both portrait and landscape rather than restricting either."],
  },
  {
    number: "1.3.5",
    title: "Identify Input Purpose",
    level: "AA",
    requirement:
      "Fields collecting information about the user expose that purpose programmatically.",
    affects: "Users who rely on autofill, and on icons or symbols added by their own tooling.",
    satisfy: ["An autocomplete attribute with the appropriate token."],
  },
  {
    number: "1.4.1",
    title: "Use of Color",
    level: "A",
    requirement: "Colour is never the only way information is conveyed.",
    affects: "Colour-blind users, and users of monochrome displays.",
    satisfy: ["Pair colour with text, an icon, underlining, or another visual cue."],
  },
  {
    number: "1.4.2",
    title: "Audio Control",
    level: "A",
    requirement:
      "Audio that plays automatically for more than three seconds can be paused, stopped, or have its volume controlled independently.",
    affects: "Screen reader users, whose own speech output is drowned out.",
    satisfy: ["Do not autoplay, or provide a control that stops the audio."],
  },
  {
    number: "1.4.3",
    title: "Contrast (Minimum)",
    level: "AA",
    requirement:
      "Text has a contrast ratio of at least 4.5:1 against its background; large text needs 3:1.",
    affects: "Users with low vision, and anyone reading in poor lighting.",
    satisfy: ["Adjust the foreground or background colour until the ratio is met."],
  },
  {
    number: "1.4.4",
    title: "Resize Text",
    level: "AA",
    requirement: "Text can be resized up to 200% without loss of content or functionality.",
    affects: "Users with low vision who rely on browser zoom.",
    satisfy: [
      "Relative units for text, and layouts that reflow.",
      "No user-scalable=no or maximum-scale in the viewport meta tag.",
    ],
  },
  {
    number: "1.4.6",
    title: "Contrast (Enhanced)",
    level: "AAA",
    requirement: "Text has a contrast ratio of at least 7:1; large text needs 4.5:1.",
    affects: "Users with low vision, at the enhanced level.",
    satisfy: ["Adjust the foreground or background colour until the ratio is met."],
  },
  {
    number: "1.4.12",
    title: "Text Spacing",
    level: "AA",
    requirement:
      "No content or functionality is lost when the user overrides line height, paragraph spacing, letter spacing, and word spacing.",
    affects: "Users with dyslexia and low vision who adjust spacing to read.",
    satisfy: ["Avoid fixed heights on text containers; let them grow."],
  },
  {
    number: "2.1.1",
    title: "Keyboard",
    level: "A",
    requirement: "Every function is operable through a keyboard alone.",
    affects: "Keyboard-only users, switch users, and screen reader users.",
    satisfy: [
      "Use natively focusable elements — button, a with href, input — for interactive controls.",
      "Where a custom control is unavoidable, give it tabindex, a role, and key handlers.",
      "Never nest one interactive control inside another; only the outer one stays reachable.",
    ],
  },
  {
    number: "2.1.3",
    title: "Keyboard (No Exception)",
    level: "AAA",
    requirement:
      "Every function is keyboard operable with no exception for timing-dependent input.",
    affects: "Keyboard-only users, at the enhanced level.",
    satisfy: ["Provide a keyboard path for every action, including drag and freehand input."],
  },
  {
    number: "2.2.1",
    title: "Timing Adjustable",
    level: "A",
    requirement: "Time limits can be turned off, adjusted, or extended by the user.",
    affects: "Users who read or type slowly, including users of assistive technology.",
    satisfy: ["Remove the limit, or let the user extend it before it expires."],
  },
  {
    number: "2.2.2",
    title: "Pause, Stop, Hide",
    level: "A",
    requirement:
      "Content that moves, blinks, scrolls, or auto-updates for more than five seconds can be paused, stopped, or hidden.",
    affects:
      "Users with attention-related disabilities, and screen reader users whose reading position shifts.",
    satisfy: ["Provide a pause control; avoid marquee and blink entirely."],
  },
  {
    number: "2.2.4",
    title: "Interruptions",
    level: "AAA",
    requirement: "Interruptions can be postponed or suppressed by the user, except in emergencies.",
    affects: "Users with attention-related disabilities.",
    satisfy: ["Let the user defer or turn off non-essential alerts and refreshes."],
  },
  {
    number: "2.4.1",
    title: "Bypass Blocks",
    level: "A",
    requirement: "A mechanism exists to skip content repeated across pages.",
    affects: "Keyboard and screen reader users, who otherwise traverse the nav on every page.",
    satisfy: [
      "A skip link to the main content.",
      "Landmark regions, so a screen reader can jump between them.",
      "A title attribute on each frame and iframe, naming its content.",
    ],
  },
  {
    number: "2.4.2",
    title: "Page Titled",
    level: "A",
    requirement: "Pages have titles that describe their topic or purpose.",
    affects: "Screen reader users orienting themselves, and anyone scanning tabs or history.",
    satisfy: ["A <title> element whose text identifies the page, not just the site."],
  },
  {
    number: "2.4.4",
    title: "Link Purpose (In Context)",
    level: "A",
    requirement:
      "The purpose of each link can be determined from its text, or from its text together with its surrounding context.",
    affects: "Screen reader users, who often browse by pulling up a list of links alone.",
    satisfy: [
      "Link text that describes the destination — not 'click here' or 'read more'.",
      "aria-label or aria-labelledby when the visible text must stay short.",
      "For an icon-only link, alternative text on the image inside it.",
    ],
  },
  {
    number: "2.4.9",
    title: "Link Purpose (Link Only)",
    level: "AAA",
    requirement: "The purpose of each link is clear from the link text alone.",
    affects: "Screen reader users, at the enhanced level.",
    satisfy: ["Make the link text self-describing without relying on the sentence around it."],
  },
  {
    number: "2.5.3",
    title: "Label in Name",
    level: "A",
    requirement:
      "For a control with a visible text label, the accessible name contains that visible text.",
    affects: "Speech input users, who say what they see to activate a control.",
    satisfy: [
      "Start the accessible name with the visible label text when adding an aria-label.",
      "Prefer aria-labelledby pointing at the visible text over retyping it.",
    ],
  },
  {
    number: "2.5.8",
    title: "Target Size (Minimum)",
    level: "AA",
    requirement: "Pointer targets are at least 24 by 24 CSS pixels, with listed exceptions.",
    affects: "Users with tremor or reduced dexterity, and touch-screen users generally.",
    satisfy: ["Enlarge the target, or leave enough spacing around a small one."],
  },
  {
    number: "3.1.1",
    title: "Language of Page",
    level: "A",
    requirement: "The default human language of the page is set programmatically.",
    affects: "Screen reader users, whose speech synthesiser picks a voice from it.",
    satisfy: ["A valid lang attribute on the html element."],
  },
  {
    number: "3.1.2",
    title: "Language of Parts",
    level: "AA",
    requirement: "Passages in a different language than the page declare that language.",
    affects: "Screen reader users, who otherwise hear foreign words in the wrong accent.",
    satisfy: ["A lang attribute on the element wrapping the passage."],
  },
  {
    number: "3.2.5",
    title: "Change on Request",
    level: "AAA",
    requirement: "Changes of context happen only on user request, or can be turned off.",
    affects: "Screen reader users and users with cognitive disabilities, who lose their place.",
    satisfy: ["Avoid automatic refreshes and redirects; let the user trigger the change."],
  },
  {
    number: "3.3.2",
    title: "Labels or Instructions",
    level: "A",
    requirement: "Labels or instructions are provided when content requires user input.",
    affects: "Everyone filling in a form, and screen reader users above all.",
    satisfy: [
      "A visible label associated with the control.",
      "aria-label or aria-labelledby where a visible label is not possible.",
      "A placeholder is not a label — it disappears on typing and many tools ignore it.",
    ],
  },
  {
    number: "4.1.1",
    title: "Parsing",
    level: "A",
    requirement:
      "Markup avoids the parsing errors that break assistive technology, most importantly duplicate ids.",
    affects: "Users of assistive technology that relies on well-formed markup.",
    satisfy: ["Keep ids unique within the document; nest and close elements correctly."],
    note: "Removed in WCAG 2.2 as obsolete — modern parsers recover. The underlying breakage, such as a duplicate id an aria-labelledby resolves to, still matters.",
  },
  {
    number: "4.1.2",
    title: "Name, Role, Value",
    level: "A",
    requirement:
      "For every user interface component, the name and role can be determined programmatically, and states, properties, and values can be set and read.",
    affects:
      "Screen reader users, and every other assistive technology that reads the accessibility tree.",
    satisfy: [
      "Native HTML elements first — they carry a role and expose state for free.",
      "An accessible name from visible text, alt, aria-label, or aria-labelledby.",
      "Valid ARIA: a role that exists, only attributes that role allows, all required attributes present.",
      "An aria-labelledby or aria-describedby must reference the id of an element that exists.",
    ],
  },
];

export const WCAG_CRITERIA: Record<string, WcagCriterion> = Object.fromEntries(
  CRITERIA.map((criterion) => [criterion.number, criterion]),
);
