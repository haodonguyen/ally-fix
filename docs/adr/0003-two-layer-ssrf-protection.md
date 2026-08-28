# ADR-0003: Enforce SSRF protection at scan time, not only at the API

## Status

Accepted — 2026-06

## Context

AllyFix accepts an arbitrary URL from an anonymous user and fetches it from our
own infrastructure. That is the definition of a Server-Side Request Forgery
primitive: the attacker chooses the destination, and the request originates from
inside our network with whatever access that implies — private subnets, internal
admin panels, and the cloud metadata endpoint at `169.254.169.254`, which on many
providers hands out credentials to anyone who asks.

The obvious defence is to validate the URL when it is submitted: reject
`localhost`, private ranges, and known metadata hosts. `POST /api/audits` does
exactly that.

It is not enough, for three reasons:

1. **Redirects.** `https://evil.example.com` passes validation, then answers the
   scan with `302 → http://169.254.169.254/`. The browser follows it.
2. **DNS rebinding.** The hostname resolves to a public IP when the API checks it,
   and to `10.0.0.5` seconds later when the worker resolves it again. Nothing was
   lied about at check time.
3. **Sub-resources.** A validated public page can embed `<img src="http://10.0.0.5/...">`.
   The page is fine; the requests it triggers are not.

All three share one shape: **the check and the request are separated in time and
place**, and only the request matters.

## Decision

Validate in both places, with the scan-time check being the authoritative one.

- `assertUrlIsSafe` (in `@ally-fix/shared/ssrf`) resolves the hostname and rejects
  if **any** resolved address is loopback, private, link-local, carrier-grade NAT,
  or an IPv6 equivalent. Unknown or malformed input fails closed.
- The API calls it at enqueue time, so an obviously bad URL is rejected with a
  clear message instead of being queued.
- The worker calls it again on the entry URL, and additionally installs a
  Playwright route handler on `**/*` that runs the same check against **every**
  request the page makes — redirects and sub-resources included — aborting any
  that resolves internally. Results are memoised per host for the scan's duration.

The module lives in a Node-only subpath and is deliberately not re-exported from
the package index, so it can never be pulled into a browser bundle.

## Alternatives considered

**API-time validation only.** Rejected: closes none of the three gaps above.

**An allowlist of scannable domains.** Rejected: the product is "scan any public
page". An allowlist makes it a different product.

**Network-level egress rules instead of application checks.** Better in principle,
and complementary — but it is not portable across the deployment targets this
project supports (laptop, Docker Compose, Render, a future AWS setup), so it
cannot be the only line of defence.

## Consequences

**Good**

- Redirect-to-internal, DNS rebinding, and internal sub-resources are all blocked
  at the point where the request is actually made.
- One shared implementation means the API and the worker cannot disagree about
  what "safe" means.

**Bad**

- **The duplication looks redundant.** Two calls to the same function for what
  appears to be the same URL is exactly the kind of thing a later cleanup deletes.
  It must not be removed: the API check is a courtesy for error messages, the
  worker check is the actual control. This ADR exists largely to say so.
- Every request in a scan pays a DNS lookup on first sight of a host. Memoisation
  bounds it, but a page pulling from many CDNs is measurably slower.
- Legitimate targets are occasionally refused — a site behind carrier-grade NAT,
  or one whose DNS briefly returns something odd. Failing closed means these are
  false positives we accept.
