/**
 * AllyFix scanner worker — entrypoint.
 *
 * Runs as a standalone process (not on serverless) because Playwright ships a
 * heavy Chromium binary. In Phase 1 this will:
 *   1. Consume audit jobs from the BullMQ queue on Redis.
 *   2. Open the target URL with Playwright and run axe-core.
 *   3. Persist raw issues to Postgres via @ally-fix/db.
 * In Phase 2 it will hand grouped issues to @ally-fix/llm for explanation + fixes.
 *
 * For now this is just a health-check stub so the service boots in docker-compose.
 */

function main(): void {
  // The worker has no UI; stdout is its log.
  console.log("[worker] AllyFix scanner worker started. Scan pipeline lands in Phase 1.");
}

main();
