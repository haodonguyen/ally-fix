import { createDb, type Database } from "@ally-fix/db";

/**
 * Lazily-created, process-wide Drizzle client.
 *
 * Cached on globalThis so Next's dev hot-reload doesn't open a new pool on every
 * change, and read from the environment at call time (not import time) so
 * `next build` doesn't fail when DATABASE_URL isn't set.
 */
const globalForDb = globalThis as unknown as { __allyfixDb?: Database };

export function getDb(): Database {
  if (!globalForDb.__allyfixDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing required environment variable: DATABASE_URL");
    globalForDb.__allyfixDb = createDb(url);
  }
  return globalForDb.__allyfixDb;
}
