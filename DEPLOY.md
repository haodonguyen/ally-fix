# Deploying AllyFix

This walks through a hosted demo on **Render** (web + worker), with **Neon**
(Postgres), **Upstash** (Redis), and **Groq** (LLM). It maps directly to
[`render.yaml`](./render.yaml).

## Architecture recap

```
Render Web Service (Next.js)  ──►  Upstash Redis (BullMQ queue)
        │                                  │
        │                                  ▼
        │                      Render Worker (Playwright + axe-core)
        ▼                                  │
   Neon Postgres  ◄──────────────── issues + LLM analysis
```

The worker is a **separate, always-on container** because Playwright ships a
heavy Chromium binary that can't run on serverless.

## 💸 Cost reality (read first)

- **Web**, **Neon**, **Upstash**, **Groq** all have durable **free** tiers.
- The **worker is the one paid piece**. Render background workers aren't free
  (~$7/mo starter), because Chromium must stay running with enough RAM.
  Alternatives if you want ~$0:
  - **Fly.io** — a small always-on machine is a few $/mo; free allowance is tight
    for Chromium but may work for light use.
  - **Run the worker on demand** — deploy only web + DB + Redis, and run the
    worker locally (`pnpm --filter @ally-fix/worker start`) when you want to
    process a scan. Good enough to show recruiters a live scan during a call.
  - **Record a demo GIF/video** in the README and keep the stack local.

## Prerequisites

Accounts (all free to create): [Neon](https://neon.tech),
[Upstash](https://upstash.com), [Groq](https://console.groq.com),
[Render](https://render.com), and this GitHub repo.

## 1. Postgres (Neon)

1. Create a project → copy the **pooled** connection string.
2. It becomes `DATABASE_URL`, e.g.
   `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`.

## 2. Redis (Upstash)

1. Create a Redis database (pick a region near your Render region).
2. Copy the connection string (starts with `rediss://`) → `REDIS_URL`.
   BullMQ needs a normal Redis connection, so use the `rediss://...` URL, not the
   REST API.

## 3. Groq key

1. Create an API key at the Groq console → `GROQ_API_KEY`.
2. Model default is `llama-3.3-70b-versatile` (already set in `render.yaml`).

## 4. Deploy on Render (Blueprint)

1. Render Dashboard → **New → Blueprint** → connect this repo. Render reads
   `render.yaml` and proposes the two services.
2. Fill in the `sync: false` env vars when prompted:
   - Both services: `DATABASE_URL`, `REDIS_URL`.
   - `allyfix-worker`: `GROQ_API_KEY`.
   - `allyfix-web`: `NEXT_PUBLIC_APP_URL` (set to the web service URL Render
     gives you, e.g. `https://allyfix-web.onrender.com`).
3. Apply. Render builds both Docker images and starts them.

## 5. Run database migrations (once)

The worker image includes `drizzle-kit`. After the first deploy, open the
**allyfix-worker → Shell** in Render and run:

```bash
pnpm --filter @ally-fix/db db:migrate
```

This creates the `audits` and `issues` tables. (Re-run only after adding new
migrations.)

## 6. Verify

- `https://<web-url>/api/health` → `{"status":"ok"}`.
- Open the web URL, submit a public URL (e.g. `https://www.w3.org`), and watch
  the report populate. First request may be slow if the free web service was
  spun down (cold start).

## Environment variables

| Variable                   | Where        | Notes                                                 |
| -------------------------- | ------------ | ----------------------------------------------------- |
| `DATABASE_URL`             | web + worker | Neon pooled connection string                         |
| `REDIS_URL`                | web + worker | Upstash `rediss://` URL                               |
| `LLM_PROVIDER`             | worker       | `groq` (default in blueprint)                         |
| `GROQ_API_KEY`             | worker       | Bring-your-own-key; never committed                   |
| `GROQ_MODEL`               | worker       | `llama-3.3-70b-versatile`                             |
| `DAILY_AUDIT_LIMIT_PER_IP` | web          | `10` for the shared demo; `0` = unlimited (self-host) |
| `NEXT_PUBLIC_APP_URL`      | web          | Public URL, used for shareable links                  |
| `SCAN_TIMEOUT_MS`          | worker       | Optional, default `30000`                             |

## Troubleshooting

- **Worker OOM / crashes**: bump the worker plan — Chromium needs more than
  512 MB. This is the usual cause of failed scans on a too-small instance.
- **Scans stay "queued"**: the worker isn't running or can't reach Redis. Check
  the worker logs and that `REDIS_URL` matches on both services.
- **No LLM explanations**: check `GROQ_API_KEY` on the worker; analysis is
  best-effort, so raw issues still appear without it.
- **429 "Daily scan limit reached"**: expected once an IP passes
  `DAILY_AUDIT_LIMIT_PER_IP`. Raise it or set `0` to disable.
