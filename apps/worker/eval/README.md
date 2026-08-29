# LLM eval

Measures whether the model's answers are any good, rather than whether the call
succeeded. The pipeline's reliability is covered by unit tests; this covers its
**output quality**, which nothing else can see.

```bash
pnpm --filter @ally-fix/worker eval           # score the model against the golden set
pnpm --filter @ally-fix/worker eval:validate  # check the dataset itself is still valid
```

Both need a real provider (and `eval` needs Chromium). They are manual scripts,
not CI jobs: a red build on a model's off day tells you nothing you can act on.

## The oracle

Evaluating generated text usually means asking another model whether it liked the
answer. This project does not have to. Every issue comes from an axe-core rule,
and axe will happily re-run — so the question becomes:

> Apply the model's own `fixCode`. Does the rule still fire?

That is deterministic, free, and not a matter of opinion. The headline metric,
**`resolved`**, is the share of cases where the fix actually silences the rule.

## Why the oracle alone would lie

"Make axe stop reporting `image-alt`" has a trivial degenerate solution: delete
the `<img>`. It passes, and helps nobody.

So a fix only counts if it still contains the element the rule was about. Cases
where removal genuinely _is_ the correct fix — `nested-interactive` is resolved by
dropping one of two nested controls — opt in with `allowsRemoval`. That is a real
hole in the check, which is why it is per-case and explicit rather than inferred.

## Verdicts

| Verdict           | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `resolved`        | The fix silences the rule and keeps the element. The only pass.   |
| `not-resolved`    | Plausible answer, rule still fires.                               |
| `degenerate`      | Passed axe by deleting the subject. Gaming, not fixing.           |
| `unparseable-fix` | `fixCode` was prose, or malformed markup.                         |
| `llm-error`       | The provider failed. Not a wrong answer — a missing one.          |
| `broken-case`     | The **dataset** is wrong: the sample no longer violates its rule. |

`broken-case` is excluded from the rate rather than counted against the model.
A rotted fixture must not look like a regression — that is how a team spends a
week tuning a prompt to fix a typo in test data.

## The dataset

22 snippets, each failing exactly one rule, verified on every run.

Scope is deliberately node-level. Page-level rules (`html-has-lang`,
`landmark-one-main`) depend on the surrounding document, so the wrapper would
decide the outcome instead of the fix. Contrast rules depend on CSS that is not in
the snippet. Neither can be measured honestly this way, so neither is claimed.

Three of the first twenty cases were wrong when written — axe accepts a
`placeholder` as an accessible name, among other surprises — and `eval:validate`
caught all three. Hence the check running on every eval.
