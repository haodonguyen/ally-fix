/**
 * The golden set.
 *
 * Every case is a snippet that genuinely fails exactly one axe rule, chosen so
 * the fix can be verified in isolation. The runner re-checks that claim on each
 * run: a case whose `html` does not actually violate `ruleId` is reported as a
 * broken case, not as a model failure. A dataset that silently rots is worse
 * than no dataset.
 *
 * Scope is deliberately node-level. Page-level rules (`html-has-lang`,
 * `landmark-one-main`, `region`) depend on the surrounding document, and the
 * wrapper the runner supplies would decide the outcome rather than the fix.
 * Contrast rules are excluded for the same reason: they depend on CSS that is
 * not in the snippet.
 */
export interface EvalCase {
  id: string;
  /** The axe rule this snippet must violate. */
  ruleId: string;
  html: string;
  /** Element the fix must keep, if the first tag in `html` isn't it. */
  subjectTag?: string;
  /**
   * Set when removing the offending element IS a correct fix, which makes the
   * anti-gaming check inapplicable — `nested-interactive` is resolved precisely
   * by dropping one of the two controls. Skipping the check is a real hole, so
   * it must be opted into per case rather than inferred.
   */
  allowsRemoval?: boolean;
  /** What a correct fix does, for the report. Not machine-checked. */
  expectation: string;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: "image-alt/missing",
    ruleId: "image-alt",
    html: '<img src="/cat.png">',
    expectation: "adds a descriptive alt attribute",
  },
  {
    id: "image-alt/empty-informative",
    ruleId: "image-alt",
    html: '<img src="/chart-q4-revenue.png" class="chart">',
    expectation: "adds alt describing the chart, not the filename",
  },
  {
    id: "input-image-alt/missing",
    ruleId: "input-image-alt",
    html: '<input type="image" src="/search.png">',
    expectation: "adds alt to the image input",
  },
  {
    id: "area-alt/missing",
    ruleId: "area-alt",
    html: '<map name="m"><area shape="rect" coords="0,0,10,10" href="/a"></map>',
    subjectTag: "area",
    expectation: "adds alt to the image map area",
  },
  {
    id: "label/input-no-label",
    ruleId: "label",
    html: '<input type="text" name="email">',
    expectation: "associates a <label>, or adds aria-label",
  },
  {
    id: "label/unassociated",
    ruleId: "label",
    html: '<label>Email</label><input type="text" name="email">',
    subjectTag: "input",
    expectation: "connects the label to the input with for/id",
  },
  {
    id: "button-name/empty",
    ruleId: "button-name",
    html: "<button></button>",
    expectation: "gives the button an accessible name",
  },
  {
    id: "button-name/icon-only",
    ruleId: "button-name",
    html: '<button><svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg></button>',
    expectation: "adds aria-label; the icon carries no name",
  },
  {
    id: "link-name/empty",
    ruleId: "link-name",
    html: '<a href="/pricing"></a>',
    expectation: "gives the link discernible text",
  },
  {
    id: "link-name/image-no-alt",
    ruleId: "link-name",
    html: '<a href="/home"><img src="/logo.png"></a>',
    subjectTag: "a",
    expectation: "names the link, usually via alt on the image",
  },
  {
    id: "frame-title/missing",
    ruleId: "frame-title",
    html: '<iframe src="/embed"></iframe>',
    expectation: "adds a title describing the frame",
  },
  {
    id: "object-alt/missing",
    ruleId: "object-alt",
    html: '<object data="/chart.svg" type="image/svg+xml"></object>',
    expectation: "gives the object an accessible name",
  },
  {
    id: "list/invalid-child",
    ruleId: "list",
    html: "<ul><div>Not an item</div></ul>",
    subjectTag: "ul",
    expectation: "wraps content in <li>, or stops using a list",
  },
  {
    id: "definition-list/invalid-child",
    ruleId: "definition-list",
    html: "<dl><p>Loose text</p></dl>",
    subjectTag: "dl",
    expectation: "uses <dt>/<dd> inside the definition list",
  },
  {
    id: "listitem/orphan",
    ruleId: "listitem",
    html: "<li>Orphaned item</li>",
    expectation: "wraps the item in <ul> or <ol>",
  },
  {
    id: "aria-required-attr/missing",
    ruleId: "aria-required-attr",
    html: '<div role="checkbox"></div>',
    expectation: "adds aria-checked, which the role requires",
  },
  {
    id: "aria-valid-attr-value/bad-enum",
    ruleId: "aria-valid-attr-value",
    html: '<div role="checkbox" aria-checked="maybe"></div>',
    expectation: "uses a value aria-checked actually allows",
  },
  {
    id: "aria-roles/invalid",
    ruleId: "aria-roles",
    html: '<div role="buton">Save</div>',
    expectation: "corrects the misspelled role",
  },
  {
    id: "select-name/missing",
    ruleId: "select-name",
    html: "<select><option>One</option></select>",
    expectation: "gives the select an accessible name",
  },
  {
    id: "empty-table-header/blank-th",
    ruleId: "empty-table-header",
    html: "<table><tr><th></th><th>Age</th></tr><tr><td>Ada</td><td>36</td></tr></table>",
    subjectTag: "table",
    expectation: "gives the empty header cell text",
  },
  {
    id: "aria-allowed-attr/wrong-for-role",
    ruleId: "aria-allowed-attr",
    html: '<div role="heading" aria-checked="true">Title</div>',
    expectation: "drops the attribute the heading role does not allow",
  },
  {
    id: "nested-interactive/link-in-button",
    ruleId: "nested-interactive",
    html: '<button><a href="/x">Link</a></button>',
    allowsRemoval: true,
    expectation: "keeps one control, not a link inside a button",
  },
];
