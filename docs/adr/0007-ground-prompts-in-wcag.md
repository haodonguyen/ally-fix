# ADR-0007: Ground prompts in the standard, at criterion level only

## Status

Accepted — 2026-08-29

## Context

The prompt sent to the model was, in full, the rule id and the offending markup:

```
axe-core rule: image-alt

The following HTML element(s) failed this rule:
Example 1:
<img src="/chart.png">
```

Everything else — what `image-alt` checks, which success criterion it enforces,
what counts as a valid alternative, who a failure hurts — came from whatever the
model happened to remember. That has three problems, in increasing order of how
much they matter.

It is **unverifiable**. When the model says a fix satisfies WCAG 1.1.1, nothing in
the system knows whether 1.1.1 is even the right criterion. AllyFix is an
accessibility tool; a confidently wrong citation is worse output than no citation.

It is **variable**. A 7B local model and a hosted 70B model do not remember the
same standard, so the same scan produces materially different advice depending on
which provider the operator configured — with no way to tell which is right.

And it is **unimprovable**. [ADR-0001](./0001-schema-validated-llm-output.md) made
the output's _shape_ enforceable and the eval harness made its _correctness_
measurable, but nothing made the input better. Retrieval is the obvious lever, and
the material is small, stable, and already partly in the repo: axe ships every
rule's metadata, and the whole of axe's WCAG surface is 29 success criteria.

## Decision

Put reference material for the failing rule into the prompt, assembled from two
sources kept deliberately separate because their provenance differs.

**The axe half is generated, not written.** `scripts/generate-axe-rules.ts` reads
the installed `axe-core` and emits `axe-rules.generated.ts`: for each of the 75
WCAG-mapped rules, axe's own `help` and `description` text and the criteria its
tags map to. A test asserts the snapshot matches the installed axe-core, so
upgrading axe fails the build until the snapshot is regenerated — the prompt
cannot end up describing a version of a rule the scanner no longer runs.

**The WCAG half is hand-written, and only at criterion level.** Twenty-nine
entries, each with the requirement in our own words, who a failure hurts, the
accepted mechanisms for satisfying it, and a link to the W3C Understanding page
so a reader can check the paraphrase against the source.

**Per-rule fix hints are refused.** This is the load-bearing part of the
decision. Writing "for `image-alt`, add an `alt` attribute" for each of the
eighteen rules the golden set covers would raise the eval score immediately —
and the rise would mean nothing, because the eval measures those eighteen rules.
Criterion-level material is written without reference to any case in the set and
covers all 75 rules, so what the eval measures is what a user of any of the other
57 rules also gets.

**Grounding is switchable, so it can be measured.** `LLM_GROUNDING=false` sends
the ungrounded prompt, and `pnpm --filter @ally-fix/worker eval:compare` runs the
golden set under both and reports the delta. Two details keep that comparison
honest:

- The anti-deletion instruction ("keep the element the rule is about") lives in
  the **base** prompt, in both arms. It was written at the same time as the
  grounding, it targets the `degenerate` verdict directly, and putting it in only
  the grounded arm would have let grounding take credit for its effect.
- The comparison reports each repeat's own rate alongside the pooled one, and
  labels a one-repeat run as unmeasured. The model is not deterministic; a
  five-point delta between arms means nothing if the runs _within_ an arm already
  spread that far.

**The cache key carries a fingerprint of the prompt.** Analyses are cached in
Redis for 30 days keyed by provider, model, rule, and markup. Grounding changes
the answer for an unchanged key, so without this a deployed prompt change would
keep serving pre-change answers for a month — long enough to look like the change
did nothing. The fingerprint hashes the system prompt _and_ all 75 rendered
reference blocks, so editing a criterion invalidates exactly the entries it
affects, with no version constant for anyone to forget to bump.

## Alternatives considered

**Leave the prompt as it is and pick a bigger model.** Cheapest, and it does
raise quality. Rejected because it fixes none of the three problems: a bigger
model's recollection is still unverifiable, still varies by provider, and still
cannot be improved by anything the project controls. It also pushes the tool away
from the local-Ollama default that makes it free to self-host.

**Retrieve from the live W3C documents (real RAG: chunk, embed, search).** The
textbook answer, and the wrong shape for this problem. Retrieval earns its
complexity when the corpus is too large to fit in context and the query is
open-ended. Here neither holds: the "query" is an exact rule id, the mapping from
rule to criterion is a lookup table axe already ships, and one criterion is ~950
characters. A vector store, an embedding model, and a similarity search would add
three failure modes to replace `AXE_RULE_FACTS[ruleId]`. **If the corpus grew to
the WCAG Techniques documents — hundreds of pages, no exact key — that trade
flips and retrieval becomes right.**

**Quote the normative WCAG text verbatim.** Rejected in favour of paraphrase plus
a link. The normative wording is written to be unambiguous to a standards
audience, not clear to a developer looking at one broken `<img>`; the paraphrase
is what the prompt actually needs. The link keeps the source one click away.

**Fine-tune a model on accessibility fixes.** Rejected: it needs a dataset that
does not exist, it re-opens the multi-provider support this project deliberately
kept, and it makes the knowledge unauditable — the opposite of the goal. A
checked-in table is reviewable in a pull request.

**Curate all 105 axe rules by hand instead of generating 75.** Rejected. The 30
rules axe classes as best practice map to no criterion, and inventing one for
them would produce exactly the fabricated citation this ADR exists to prevent.
Those rules get no reference block and fall back to the ungrounded prompt.

## Consequences

**Good**

- Every citation in the output is checkable: the criterion came from a table in
  the repo, and the table is joined to the criterion by axe's own tags.
- The reference is identical across providers, so switching from Ollama to Groq
  changes fluency rather than the substance of the advice.
- An axe upgrade that changes a rule's wording or mapping fails the test suite
  instead of silently degrading the prompt.
- The prompt is now a thing that can be improved _and measured_ —
  `eval:compare` gives any future change to it a number.
- A prompt change can no longer be masked by the cache.

**Bad**

- **Twenty-nine paraphrases are a maintenance surface, and they are ours.** WCAG
  moves slowly, but 4.1.1 Parsing was already retired between 2.1 and 2.2, and
  nothing in the build will notice when the next one is. The only mitigation is
  that each entry links to its source.
- Every call costs ~250 more input tokens. Negligible against one generation,
  but it is a real per-scan cost that was not there before.
- The reference material is a second thing that can be wrong, and a paraphrase
  stated authoritatively is a confident error rather than an obvious gap.
- Refusing per-rule hints leaves measurable score on the table. That is the
  price of the eval measuring generalisation rather than memorisation, and it
  is the right trade — but it is a real cost, not a free win.
- `LlmClient` gained a `promptFingerprint` field, so every implementation and
  every test double has to supply one.

## See also

- [ADR-0001](./0001-schema-validated-llm-output.md) — the output contract. This
  is the same idea applied to the input.
- [ADR-0005](./0005-two-axis-llm-error-taxonomy.md) — the failure policy for the
  call. This one is about the quality of the call that succeeds.
