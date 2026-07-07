import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Creates a Drizzle client bound to a Postgres connection.
 *
 * Connection is explicit (passed in), not read from a global at import time,
 * so the web app and worker each own their own pool and tests can inject a URL.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
