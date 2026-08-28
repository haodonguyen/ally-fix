# ADR-0002: Run the scanner as a separate long-lived service, not in the web app

## Status

Accepted — 2026-06

## Context

Scanning a page means driving a real browser: Playwright launches headless
Chromium, loads the URL, waits for the network to settle, and runs axe-core
against the live DOM. There is no way to do this without a browser — axe evaluates
computed styles and the accessibility tree, neither of which exists in a static
HTML parse.

The web app is a Next.js deployment. Putting the scan inside an API route would be
the simplest thing that could work, and it is what a first draft would do.

It cannot work here:

- Chromium is a ~250 MB binary. Vercel's serverless bundle limits are far below
  that, and the runtime has no persistent filesystem to install it into.
- A scan takes seconds to tens of seconds. Serverless functions have execution
  time limits, and a slow page would be killed mid-scan.
- Chromium needs hundreds of MB of RAM while running. That is the wrong shape for
  a function sized for request handling.

## Decision

Split the system into two deployables that share Postgres and Redis:

- **web** (`apps/web`) — Next.js. Validates the URL, creates the audit row,
  enqueues a BullMQ job, and serves the report. Never launches a browser.
- **worker** (`apps/worker`) — a long-running process with its own Dockerfile.
  Consumes the queue, scans with Playwright + axe-core, writes issues, and runs
  the LLM analysis.

The queue is the boundary. The web app's only knowledge of scanning is the shape
of the job payload (`auditJobPayloadSchema`).

## Alternatives considered

**A hosted scanning API instead of our own Playwright.** Rejected: the scan is the
core of the product. Outsourcing it would make the project a thin client over
someone else's service, and it would put a per-scan cost on a free demo.

**Run everything in one container on a VPS.** Viable, and it is what
`docker compose up` does locally. Rejected for the hosted demo because it gives up
the free always-on web tier — see Consequences.

## Consequences

**Good**

- The two halves scale on their own axes. The web app is cheap and always on; the
  worker is expensive and needed only while a scan runs.
- The queue absorbs bursts. Ten simultaneous submissions become a backlog, not ten
  concurrent Chromium instances competing for RAM.
- A crashed scan takes down one job, not the site.

**Bad**

- **The demo has a split-brain deployment.** The web app is always online on
  Vercel, but the worker runs on demand from a laptop, because a Playwright worker
  cannot run for free always-on anywhere. A brand-new scan therefore only finishes
  while the worker is awake.
- That leaks into the product: the report page has to detect a scan sitting in
  `queued` too long and offer pre-computed sample reports instead of spinning
  forever (`SLOW_SCAN_MS` in `audit-report.tsx`). A UI affordance exists purely
  because of a deployment constraint.
- Two services means two sets of environment variables and two failure modes to
  document (see `DEPLOY.md`).
- Local development needs Postgres and Redis running, so `docker compose` is
  effectively mandatory rather than a convenience.
