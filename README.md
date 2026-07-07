# AllyFix

Open-source accessibility auditor. It scans a web page for WCAG issues, then uses
an LLM to explain **why** each issue matters and generate a concrete **code fix** —
not just _what_ is broken, but _how_ to fix it, right in your code.

> ⚠️ Automated scans (axe-core) catch roughly 30–40% of WCAG success criteria and
> cannot replace manual testing with assistive technology. AllyFix reports are not a
> legal certification of compliance.

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
binary that cannot run on Vercel's serverless runtime.

## Tech stack

- **TypeScript** everywhere, **pnpm** workspaces monorepo.
- **Next.js** — web frontend and API routes.
- **Playwright** + **@axe-core/playwright** — the scanner.
- **BullMQ** + **Redis** — job queue and result cache.
- **PostgreSQL** + **Drizzle ORM** — storage (JSONB for raw axe output).
- **Vercel AI SDK** — provider-agnostic LLM layer (Ollama / Groq / Gemini),
  structured output validated with **Zod**.
- **Docker Compose** — run the whole stack with one command.
- **GitHub Actions** — CI (lint, typecheck, test) on every PR.

## Monorepo layout

```
ally-fix/
  apps/
    web/         Next.js: frontend + API routes
    worker/      Playwright + axe-core scanner (separate service)
  packages/
    db/          Drizzle schema + Postgres client
    llm/         Provider-agnostic LLM layer
    shared/      Shared Zod schemas, types, and constants
  docker-compose.yml
  .env.example
```

## Getting started

Requires Node 20+ and pnpm.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env    # then fill in values as needed

# 3. Start Postgres + Redis + worker + web
docker compose up
```

Common scripts:

```bash
pnpm dev          # run web + worker in watch mode
pnpm lint         # ESLint across the monorepo
pnpm typecheck    # TypeScript, all packages
pnpm test         # tests, all packages
pnpm db:generate  # generate Drizzle migrations from the schema
```

## Bring your own key

AllyFix never hardcodes or stores API keys. Ollama runs locally for free by default.
If you supply a Groq or Gemini key, it lives only for the duration of your session —
it is never written to the database, logged, or sent anywhere but the provider itself.

## Status

Built in phases (see [`CLAUDE.md`](./CLAUDE.md)): **Phase 1** core scan pipeline →
**Phase 2** LLM explanations + fixes → **Phase 3** report dashboard → **Phase 4** polish.
This commit is the project scaffold — structure, config, and shared types only.

## License

MIT
