# Architecture Decision Records

Each file here records **one** decision: the situation that forced it, what was
chosen, what was rejected, and what it cost. Code shows what the system does and
`git log` shows when it changed; neither preserves why an alternative was turned
down. That is what these are for.

**They are append-only.** An ADR is never edited to match a later change of mind —
a new one is written and the old one is marked `Superseded by ADR-NNNN`. The
sequence of decisions is the point; a tidied-up ADR is just documentation.

| ADR                                                      | Decision                                                                 | Status   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | -------- |
| [0001](./0001-schema-validated-llm-output.md)            | Validate LLM output against a schema instead of accepting free-form text | Accepted |
| [0002](./0002-worker-is-a-separate-service.md)           | Run the scanner as a separate long-lived service, not in the web app     | Accepted |
| [0003](./0003-two-layer-ssrf-protection.md)              | Enforce SSRF protection at scan time, not only at the API                | Accepted |
| [0004](./0004-llm-analysis-is-best-effort.md)            | LLM analysis is best-effort and must never fail a scan                   | Accepted |
| [0005](./0005-two-axis-llm-error-taxonomy.md)            | Classify LLM failures on two independent axes                            | Accepted |
| [0006](./0006-structured-logging.md)                     | Log structured records, with a hand-written logger                       | Accepted |
| [0007](./0007-ground-prompts-in-wcag.md)                 | Ground prompts in the standard, at criterion level only                  | Accepted |
| [0008](./0008-tokens-are-measured-cost-is-configured.md) | Report tokens as measurement and cost as configuration                   | Accepted |

## Format

Adapted from Michael Nygard's original: **Status**, **Context**, **Decision**,
**Alternatives considered**, **Consequences**.

Consequences carry both the good and the bad. An ADR listing only benefits has not
finished thinking.
