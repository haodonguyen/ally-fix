# AllyFix scanner worker.
# Uses Microsoft's Playwright image which already bundles Chromium + its OS deps,
# so the worker can drive a real browser. Build context is the repo root.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Enable pnpm via the Node that ships with the Playwright image.
RUN corepack enable

# Copy workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/llm/package.json ./packages/llm/
COPY apps/worker/package.json ./apps/worker/

# Install only what the worker needs.
RUN pnpm install --frozen-lockfile --filter @ally-fix/worker...

# Copy the rest of the source.
COPY . .

# Run the worker directly from TypeScript with tsx (no separate build step).
CMD ["pnpm", "--filter", "@ally-fix/worker", "start"]
