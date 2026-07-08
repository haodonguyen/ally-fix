# Deploying AllyFix

This deploys a **$0 portfolio demo**: the web app is always online on **Vercel**,
with **Neon** (Postgres) and **Upstash** (Redis) on their free tiers. The scanner
worker is **run on demand from your machine** when you want to process scans —
because a Playwright + Chromium worker can't run for free always-on anywhere.

## How the on-demand model works

```
Recruiter ──► Vercel (Next.js, always on)
                   │  enqueues job
                   ▼
              Upstash Redis  ◄────────┐
                   │                  │ your laptop, only while demoing:
                   ▼                  │   pnpm --filter @ally-fix/worker start:demo
        (job waits until a worker runs)
                   │                  │
                   └──────────────────┘
                          │ scans with Playwright + axe, writes results
                          ▼
                    Neon Postgres ──► Vercel shows the report
```

- The **web link is always live** — recruiters can open it any time and see the
  UI, past reports, and the shareable links.
- A **new scan only completes while your local worker is running**. If nobody's
  running the worker, a submitted audit sits in `queued` until you start it (then
  it processes immediately). Start the worker before/during a demo.

Everything here is free: Vercel Hobby, Neon free, Upstash free, Groq free.

## Prerequisites

Accounts (all free): [Neon](https://neon.tech), [Upstash](https://upstash.com),
[Groq](https://console.groq.com), [Vercel](https://vercel.com), plus this GitHub repo.

## 1. Postgres (Neon)

1. Create a project → copy the **pooled** connection string → this is `DATABASE_URL`,
   e.g. `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`.

## 2. Redis (Upstash)

1. Create a Redis database.
2. Copy the **`rediss://...` TCP connection string** (not the REST API) → `REDIS_URL`.
   BullMQ needs a real Redis connection.

## 3. Groq key (for LLM explanations)

1. Create an API key at the Groq console → `GROQ_API_KEY`. Model default is
   `openai/gpt-oss-20b`. Only the worker uses this, so it stays on your
   machine — never deployed.

## 4. Create the tables (once)

Run the migration against Neon from your machine:

```bash
DATABASE_URL="<your-neon-url>" pnpm --filter @ally-fix/db db:migrate
```

## 5. Deploy the web app to Vercel

1. Vercel → **New Project** → import this repo.
2. **Root Directory**: `apps/web` (Vercel detects the pnpm workspace and installs
   from the repo root automatically).
3. Set environment variables (Production):
   - `DATABASE_URL` — the Neon URL
   - `REDIS_URL` — the Upstash `rediss://` URL
   - `DAILY_AUDIT_LIMIT_PER_IP` — e.g. `10` (per-IP daily cap for the shared demo)
   - `NEXT_PUBLIC_APP_URL` — your Vercel URL, e.g. `https://ally-fix.vercel.app`
     (used for shareable report links)
   > The web app does **not** need `GROQ_API_KEY` — only the worker does.
4. Deploy. Visit `/api/health` → `{"status":"ok"}`.

## 6. Demo: run the worker on demand

Create a local `.env` at the repo root (it's gitignored) pointing at the **cloud**
services, so your worker drains the same queue the deployed web fills:

```bash
# .env  (repo root)
DATABASE_URL=postgresql://...neon...
REDIS_URL=rediss://...upstash...
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=openai/gpt-oss-20b
```

Then, whenever you want scans to process:

```bash
pnpm --filter @ally-fix/worker start:demo
```

`start:demo` loads that `.env` automatically. Leave it running during a recruiter
call; stop it (Ctrl-C) when done. Submitted audits process the moment it's up.

## Environment variables

| Variable                   | Web (Vercel) | Worker (local) | Notes                                 |
| -------------------------- | :----------: | :------------: | ------------------------------------- |
| `DATABASE_URL`             |      ✅      |       ✅       | Neon pooled connection string         |
| `REDIS_URL`                |      ✅      |       ✅       | Upstash `rediss://` URL               |
| `NEXT_PUBLIC_APP_URL`      |      ✅      |                | Public web URL, for shareable links   |
| `DAILY_AUDIT_LIMIT_PER_IP` |      ✅      |                | `10` for shared demo; `0` = unlimited |
| `LLM_PROVIDER`             |              |       ✅       | `groq`                                |
| `GROQ_API_KEY`             |              |       ✅       | Bring-your-own-key; stays local       |
| `GROQ_MODEL`               |              |       ✅       | `openai/gpt-oss-20b`                  |
| `SCAN_TIMEOUT_MS`          |              |       ✅       | Optional, default `30000`             |

## Want it fully hosted instead?

If you'd rather not run the worker by hand, host it as an always-on container
(e.g. Render/Fly/Railway) using [`apps/worker/Dockerfile`](./apps/worker/Dockerfile),
with the same env vars. That's a small monthly cost because Chromium needs an
always-on instance with enough RAM. The whole stack also runs locally with
`docker compose up` (see [`docker-compose.yml`](./docker-compose.yml)).

## Troubleshooting

- **Scans stay "queued"**: no worker is running, or it can't reach Redis. Start
  `start:demo` and confirm `REDIS_URL` matches the web app's.
- **No LLM explanations**: check `GROQ_API_KEY` in your local `.env`; analysis is
  best-effort, so raw issues still appear without it.
- **429 "Daily scan limit reached"**: expected past `DAILY_AUDIT_LIMIT_PER_IP`.
  Raise it or set `0` to disable.
