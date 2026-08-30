# LLM eval

Measures whether the model's answers are any good, rather than whether the call
succeeded. The pipeline's reliability is covered by unit tests; this covers its
**output quality**, which nothing else can see.

```bash
pnpm --filter @ally-fix/worker eval           # score the model against the golden set
pnpm --filter @ally-fix/worker eval:compare   # score it with and without WCAG grounding
pnpm --filter @ally-fix/worker eval:models    # score several models side by side
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

## What a run costs

Every case reports the tokens it consumed, **retries included** — a case that
only parsed on the third attempt was billed three times. Dollars need a rate, and
rates are configuration rather than code (see
[ADR-0008](../../../docs/adr/0008-tokens-are-measured-cost-is-configured.md)):

```bash
LLM_PRICE_INPUT_PER_MTOK=0.10 LLM_PRICE_OUTPUT_PER_MTOK=0.50   pnpm --filter @ally-fix/worker eval:compare
```

Without a rate the report prints exact token counts and `no rate configured` —
never `$0.0000`. "Free" and "unknown" are different facts and only one of them
belongs in a sentence about money.

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

## Comparing two prompts

`eval:compare` runs the whole set twice — once with the WCAG reference block in
the prompt, once without — and reports the difference. It exists because a prompt
change with no number attached is a preference, not an improvement.

```bash
EVAL_REPEATS=3 pnpm --filter @ally-fix/worker eval:compare
```

Three things keep the comparison from flattering itself:

- **It prints every repeat's rate, not just the pooled one.** The model is not
  deterministic. A five-point gap between arms means nothing if the runs within
  an arm already spread that far, and a single repeat per arm is labelled as
  unmeasured rather than reported as a result.
- **It names the cases that got _worse_.** A prompt that fixes four rules and
  breaks three moves the headline up. That is not the same change as one that
  only adds, and the report refuses to let the two look alike.
- **It prints what the candidate prompt costs**, as input tokens per call, right
  next to the delta. A prompt change always has a price; a report showing only
  the benefit is half an answer.

Everything except the reference block is held constant across the arms —
including the instruction not to delete the offending element, which lives in the
base prompt precisely so grounding cannot take credit for it. See
[ADR-0007](../../../docs/adr/0007-ground-prompts-in-wcag.md).

## Comparing models

"Which model should this use?" is otherwise answered by whichever one someone
tried first. With an oracle and token accounting already in place, it becomes a
table.

```bash
cp apps/worker/eval/models.example.json apps/worker/eval/models.json   # then edit
pnpm --filter @ally-fix/worker eval:models
```

```
  model             resolved      p50   in/call        run    per fix
  ----------------  --------  -------  --------  ---------  ---------
  gemini/2.0-flash     83.3%    627ms       440        n/a        n/a
  groq/gpt-oss-20b     77.8%    347ms       440    $0.0018   $0.00013
  ollama/llama3.1      38.9%   7414ms       440    $0.0000   $0.00000
```

**`per fix` is the column that decides things.** Not what a run cost, but what a
_working answer_ cost. A model twice as good and five times the price is a real
trade; a headline rate alone hides it.

The config file, not environment variables, because per-model prices are the
whole point — one `LLM_PRICE_*` pair cannot express three models at three rates —
and because a comparison is worth keeping: the file records exactly which models,
at which prices, produced a given table.

**It never holds a key.** An entry names the _environment variable_ the key lives
in (`apiKeyEnv`), and an inline `apiKey` is rejected with an error explaining the
alternative rather than silently accepted into a file that looks committable. The
working copy is gitignored; only the example is tracked. Keys are resolved for
every arm before the first call, so a missing one fails in a second rather than
after a long run has already scored that model at zero.

Four things stop the table from reading as more than it is:

- **An unpriced model shows `n/a`, never `$0`** — otherwise it wins on price by
  virtue of nobody having told us what it costs.
- **Cases no arm resolved are listed separately.** A case every model fails is as
  likely to be a bad case as a hard rule. `eval:validate` catches a snippet that
  stopped violating its rule; it cannot catch one whose only correct fix the
  oracle refuses to accept.
- **Per-run rates are printed under the table**, as the error bar. A gap smaller
  than the spread within an arm is not a result.
- **The top row is the best _score_, not the right answer.** A local model bills
  nothing per token and costs seconds of latency. The report says so rather than
  letting a sorted table imply a winner.
