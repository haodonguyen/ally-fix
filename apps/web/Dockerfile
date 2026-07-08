# AllyFix web app (Next.js). Build context is the repo root.
# Multi-stage: install + build, then run Next's minimal standalone server.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
# Manifests first for layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/llm/package.json ./packages/llm/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @ally-fix/web...
COPY . .
RUN pnpm --filter @ally-fix/web build

FROM base AS runtime
ENV NODE_ENV=production
# Bind all interfaces so container hosts (Render, etc.) can reach it; they inject PORT.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Next standalone output bundles the server and only the deps it needs.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
