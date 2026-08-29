# AllyFix

**Open-source accessibility auditor that tells you _why_ each WCAG issue matters and _how_ to fix it — right in your code.**

[![CI](https://github.com/haodonguyen/ally-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/haodonguyen/ally-fix/actions/workflows/ci.yml)
[![Accessibility](https://github.com/haodonguyen/ally-fix/actions/workflows/a11y.yml/badge.svg)](https://github.com/haodonguyen/ally-fix/actions/workflows/a11y.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Automated scanners tell you _what_ is broken. AllyFix scans a page with axe-core,
then uses an LLM to explain each issue in plain language and generate a concrete,
copy-able code fix.

<p align="center">
  <img src="docs/report-fix.png" width="820"
       alt="An AllyFix report with an expanded image-alt issue: a plain-language explanation, the affected user groups, and a copy-able HTML code fix in a dark code block." />
</p>

## 🔗 Live demo

**[ally-fix-web.vercel.app](https://ally-fix-web.vercel.app)** — try it, or open a pre-run report:

| Site scanned                                                                                  | Score                   | Report                                                                              |
| --------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| [a11yproject.com](https://www.a11yproject.com) — built for accessibility                      | **100 / 100**           | [view](https://ally-fix-web.vercel.app/audits/117d1422-f8e6-4a87-a6ae-064e4cbcd058) |
| A large e-commerce homepage                                                                   | **5 / 100** (82 issues) | [view](https://ally-fix-web.vercel.app/audits/190fbd67-bc34-41b0-8c63-e72ae5557c75) |
| [W3C "before" demo](https://www.w3.org/WAI/demos/bad/before/home.html) — intentionally broken | **6 / 100** (67 issues) | [view](https://ally-fix-web.vercel.app/audits/14b757d5-86c6-4eb6-b376-60c4cd77e700) |

> The web app is always online. The scanner worker runs **on demand** (a Playwright +
> Chromium worker can't run for free always-on), so a _brand-new_ scan finishes only
> while the worker is running — the sample reports above are pre-computed and always
> viewable. See [`DEPLOY.md`](./DEPLOY.md) for the model.

> ⚠️ Automated scans (axe-core) catch roughly 30–40% of WCAG success criteria and
> cannot replace manual testing with assistive technology. AllyFix reports are not a
> legal certification of compliance.

## What it does

- **Scores** a page 0–100, severity-weighted (a few critical issues hurt far more than many minor ones).
- **Groups** issues by WCAG 2.2 success criterion, with A / AA levels.
- **Explains + fixes** each issue with an LLM: the problem in plain language, who it affects, and a copy-able code fix.
- **Shares** every report at a stable URL.

<p align="center">
  <img src="docs/report-top.png" width="820"
       alt="Top of an AllyFix report showing a 6-out-of-100 score labelled Poor, a breakdown of 34 critical / 10 serious / 23 moderate issues, and a WCAG 2.2 success-criterion table." />
</p>

The dashboard is itself built to **WCAG 2.2 AA** — semantic landmarks and headings,
visually-hidden labels, visible focus, and tint-plus-dark-text badges for contrast.
It's dogfooded with axe in CI and reports **zero** WCAG A/AA violations.

## Architecture

```
Next.js (web)  ──►  API route  ──►  BullMQ queue (Redis)
                                          │
                                          ▼
                              Worker: Playwright + axe-core
                                          │
                          raw issues ─────┤────► LLM layer (explain + fix)
                                          ▼
                                     PostgreSQL  ──►  Report dashboard
```

The **worker is a separate service** because Playwright needs a heavy Chromium
binary that cannot run on Vercel's serverless runtime. SSRF protection is enforced
both at the API and again at scan time, where every request the page makes —
redirects and sub-resources included — is checked against the same guard.

---

# Engineering notes

The interesting parts of this project are not the happy path. Everything below is
about what happens when something goes wrong.

## Talking to the LLM without trusting it

A third-party model is the least reliable thing in this pipeline: it can be slow,
rate-limited, down, or simply return the wrong shape. The LLM layer treats each of
those as a distinct failure with its own response, rather than one generic
`try/catch`:

| Failure                        | Response                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Request hangs                  | Per-attempt deadline aborts it in flight; a race backstops a callee that ignores the signal                          |
| Free-tier quota                | Token-bucket rate limit **before** the call, so we don't learn the cap by being 429'd                                |
| Transient 429 / 5xx            | Retry with exponential backoff and **full jitter**, so concurrent workers don't retry in lockstep                    |
| Bad key, unknown model (4xx)   | Not retried — no amount of waiting fixes it                                                                          |
| Provider down                  | Circuit breaker opens after N consecutive failures and the rest of the audit fails fast, then one probe re-closes it |
| Malformed output               | Retried against the Zod schema, but **never** opens the circuit — a bad answer isn't an outage                       |
| Fenced JSON from a local model | Unwrapped once before validating, turning a guaranteed retry into a hit                                              |

Failures are classified on **two independent axes**, because the cases that matter
are the ones where they disagree:

|                 | Retry worth it?                        | Provider unhealthy?                         |
| --------------- | -------------------------------------- | ------------------------------------------- |
| Malformed JSON  | **Yes** — sampling is nondeterministic | **No** — it answered, the content was wrong |
| Invalid API key | **No** — waiting fixes nothing         | **Yes** — every later call fails alike      |

One boolean cannot express that. Collapsing the axes either takes a healthy
provider offline because a model is chatty, or pays the full retry budget on every
rule group to rediscover the same 401.

All of it is best-effort by design: the raw axe issues are in Postgres **before**
the first LLM call, so a total provider outage costs the explanations, not the scan.

## Making the answers good, not just well-formed

Everything above keeps a bad call from breaking the system. None of it says
whether the answer was _right_ — and for an accessibility tool, a confident wrong
fix is the worst output there is.

**The prompt carries the standard.** Each call ships the failing rule's WCAG
success criterion: what it requires, who a failure hurts, and the accepted ways to
satisfy it, with a link to the W3C source. The axe half of that reference is
**generated from the installed axe-core**, and a test fails the build if the two
drift — so the prompt can never describe a version of a rule the scanner no longer
runs. The WCAG half is hand-written at **criterion level only**: per-rule fix hints
for the eighteen rules the eval covers would raise the score without making the
system better at the other fifty-seven. ([ADR-0007](./docs/adr/0007-ground-prompts-in-wcag.md))

**The answers are scored against a deterministic oracle.** Evaluating generated
text usually means asking another model whether it liked the answer. This project
does not have to: every issue comes from an axe rule, and axe will re-run. So the
question is _"apply the model's own `fixCode` — does the rule still fire?"_ The
headline metric, `resolved`, is the share of 22 golden cases where it stops firing.

**And the oracle alone would lie.** "Make axe stop reporting `image-alt`" has a
trivial degenerate solution: delete the `<img>`. It passes and helps nobody, so a
fix only counts if it still contains the element the rule was about.

**Prompt changes are A/B'd, not asserted.** `eval:compare` runs the same set with
grounding on and off, holding everything else constant, and prints each repeat's
rate rather than one pooled number — the model is not deterministic, and a small
delta across noisy runs is unmeasured, not zero. It also names the cases that got
_worse_, because a change that fixes four rules and breaks three is not the same
change as one that only adds.

Two details make that measurable at all: the cache key includes a **fingerprint of
the prompt**, so a prompt change cannot be masked by 30 days of pre-change answers;
and the "don't delete the element" instruction sits in the **base** prompt, in both
arms, so grounding cannot take credit for it.

Three of the first twenty golden cases turned out not to violate the rules they
claimed to — axe accepts a `placeholder` as an accessible name, among other
surprises. The dataset re-checks itself on every run, and a rotted case is reported
as `broken-case` rather than counted against the model. See
[`apps/worker/eval/`](./apps/worker/eval/).

## When a process dies

The worker runs on demand, so being interrupted mid-scan is the normal ending, not
a rare one. Three things make that survivable:

- **Graceful shutdown.** SIGTERM stops the worker taking new jobs and lets the
  in-flight scan finish — bounded by a grace deadline, because platforms follow
  SIGTERM with SIGKILL on a fixed timer. Waiting forever only means being killed
  with less control.
- **A reaper.** An audit reaches `running` only when a worker picked it up, so a
  stale `running` row means the process holding it died. A sweep at startup and on
  an interval moves those to `failed`, instead of leaving the report page polling a
  scan that is never coming.
- **A guarded enqueue.** The audit row is created before the job exists, so a Redis
  blip in between would strand it. That path now marks the audit failed and answers
  503 rather than handing out an id for a scan that will never run.

`queued` audits are **never** swept: in the on-demand model they are legitimately
waiting, sometimes for hours. That distinction is the whole design, so the status
list is a named constant with a test that fails if it is widened.

## Knowing what happened

Logs are structured records, not sentences — because prose cannot answer the only
question anyone asks of production logs: _what happened to **this** audit?_

```
14:43:01.067 INFO  scan finished      auditId=3f1a9c22-… scanMs=4210 issues=67
14:43:01.067 INFO  analysis finished  auditId=3f1a9c22-… analysisMs=18400 provider=groq analyzed=12 failed=1
```

- `child({ auditId })` stamps the correlation field onto every line downstream, so
  one scan is traceable end to end by filtering a single field.
- Errors are serialized explicitly — name, message, stack, whole `cause` chain —
  because `JSON.stringify(error)` is `"{}"` and loses the failure entirely.
- **Secrets can't reach the logs.** Values under secret-looking keys are dropped,
  and credentials in connection strings are scrubbed from every string including
  stack traces: `redis://admin:hunter2@cache.internal` → `redis://[redacted]@cache.internal`.
  The host survives, so the failure stays diagnosable.

`GET /api/health` is liveness and stays dependency-free — a probe that fails during
a Postgres blip would have the platform restart a healthy app. `GET /api/ready` is
readiness, checks both dependencies, and names which one is down.

## How this is tested

**321 tests**, gated in CI at 90% statements / 88% branches / 88% functions / 90%
lines against measured 96.6 / 92.9 / 94.6 / 98.1. The thresholds are a **ratchet**
set at what the suite reaches, so a drop fails the build.

The tests aim at the paths that are hard to reach and easy to get wrong: the HTTP
boundary that accepts anonymous input, the pipeline orchestration that decides
whether an audit completes, the cache's corrupt and stale entries, and every branch
of the LLM failure policy against an injected fake provider.

Two habits are worth naming, because both came from being burned:

- **Tests are checked by mutating the implementation.** A test that cannot fail is
  worse than no test — it reports safety it does not provide. Every fix in this
  repo was confirmed to fail its test when reverted.
- **The logger's own test writes through the real implementation** into an array,
  so correlation and error serialization are genuinely exercised, and the suite
  asserts what a failing scan would actually say.

CI runs lint, typecheck, tests with coverage, a production build, and a format
check on every PR, plus a separate job that runs axe against the dashboard. `main`
is protected and requires both to pass.

## Why it's built this way

Seven [Architecture Decision Records](./docs/adr/) record the decisions above — each
with the alternatives that were rejected and **what the choice cost**, including
the costs already paid. Requiring schema-validated output, for example, ruled out a
Groq model that rejects the AI SDK's `json_schema` format.

---

## Tech stack

- **TypeScript** everywhere, **pnpm** workspaces monorepo.
- **Next.js** — web frontend and API routes.
- **Playwright** + **@axe-core/playwright** — the scanner.
- **BullMQ** + **Redis** — job queue and LLM result cache.
- **PostgreSQL** + **Drizzle ORM** — storage (JSONB for raw axe output).
- **Vercel AI SDK** — provider-agnostic LLM layer (Ollama / Groq / Gemini),
  structured output validated with **Zod**, behind the failure policy above.
- **Radix UI** — accessible accordion primitives.
- **Docker Compose** — run the whole stack with one command.
- **Vitest** + **GitHub Actions** — tests, coverage gate, and a dogfooded a11y job.

## Monorepo layout

```
ally-fix/
  apps/
    web/         Next.js: frontend, API routes, health + readiness probes
    worker/      Playwright + axe-core scanner (separate service)
                 scan → store → analyse, plus shutdown and stale-audit recovery
      eval/      Golden set + axe oracle: does the model's own fix work?
  packages/
    db/          Drizzle schema, queries, Postgres client
    llm/         Provider-agnostic LLM layer: errors, throttle, circuit breaker
      grounding/ WCAG criteria + axe rule facts injected into the prompt
    shared/      Zod schemas, types, scoring, SSRF guard, structured logger
  docs/adr/      Architecture Decision Records
  docker-compose.yml
  .env.example
```

## Run it locally

Requires **Node 22.13+**, **pnpm**, and **Docker**.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment (the defaults already match the Docker services below)
cp .env.example .env

# 3. Start Postgres + Redis + the worker + the web app
docker compose up -d

# 4. Create the database tables (run once)
pnpm db:migrate
```

Then open **http://localhost:3000**, paste a public URL — try
`https://www.w3.org/WAI/demos/bad/before/home.html` — and click **Scan**. In a few
seconds you'll get a report with the accessibility score, a WCAG breakdown, and each
issue's explanation and code fix.

To stop everything: `docker compose down`.

### AI explanations

The default LLM provider is **Ollama** (local, free). Install it and pull a model
(`ollama pull llama3.1`), **or** switch to a hosted key in `.env`:

```bash
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...            # from https://console.groq.com
GROQ_MODEL=openai/gpt-oss-20b
```

Without a provider, scans still work — issues just won't have AI explanations
(the analysis step is best-effort and never fails a scan).

### Useful scripts

```bash
pnpm lint           # ESLint across the monorepo
pnpm typecheck      # TypeScript, all packages
pnpm test           # Vitest, all packages
pnpm test:coverage  # ...with the coverage thresholds enforced
pnpm format         # Prettier, write
pnpm build          # production build
pnpm db:generate    # regenerate Drizzle migrations after a schema change

# Output quality — manual, needs a real provider (and Chromium for the first two)
pnpm --filter @ally-fix/worker eval           # score the model against the golden set
pnpm --filter @ally-fix/worker eval:compare   # score it with and without WCAG grounding
pnpm --filter @ally-fix/worker eval:validate  # check the golden set is still valid
pnpm --filter @ally-fix/llm grounding:generate  # refresh the axe rule facts after an axe upgrade
```

## Deployment

See [`DEPLOY.md`](./DEPLOY.md). The recommended $0 setup keeps the web app always
online on **Vercel** (with **Neon** Postgres and **Upstash** Redis on free tiers)
and runs the Playwright worker **on demand** from your machine
(`pnpm --filter @ally-fix/worker start:demo`). Per-IP daily rate limiting protects
the shared demo key. A fully hosted, always-on option (Docker worker on Render/Fly)
is documented too.

## Security

- **Bring your own key.** No API key is ever hardcoded or stored. Ollama runs
  locally for free by default. A Groq or Gemini key lives only in the worker's
  process memory — never written to the database, and never logged: the logger
  drops secret-looking fields and scrubs credentials out of strings and stack
  traces.
- **SSRF is enforced where the request is made.** Validating the submitted URL is
  not enough, because a redirect, a DNS rebind, or a sub-resource can each point
  somewhere the check never saw. The worker re-validates the entry URL and screens
  every request the page makes against the same guard: loopback, private ranges,
  link-local, carrier-grade NAT, and cloud metadata are all refused, failing closed
  on anything it cannot parse. See [ADR-0003](./docs/adr/0003-two-layer-ssrf-protection.md).
- **Public reports never carry internal detail.** Scan errors are mapped to generic
  user-facing sentences before being stored; the full error goes to the logs.

## What's deliberately not here

- **Multi-page and sitemap crawling, PDF export, an embeddable badge.** Product
  surface rather than engineering depth, and each multiplies scan cost.
- **An always-on hosted worker.** Chromium needs an always-on instance with real
  RAM, which is not free anywhere. The on-demand model is an explicit cost
  trade-off, not an oversight — with pre-computed sample reports so the demo is
  always viewable.
- **Distributed tracing.** The right answer once this is more than one worker;
  premature while it is one. Noted as the rejected alternative in
  [ADR-0006](./docs/adr/0006-structured-logging.md).

## License

[MIT](./LICENSE) © Hao Do Nguyen
