/** Reads and validates the environment the worker needs to run. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  REDIS_URL: required("REDIS_URL"),
  /** Max time to wait for a page to load before giving up, in milliseconds. */
  SCAN_TIMEOUT_MS: Number(process.env.SCAN_TIMEOUT_MS ?? 30_000),
};
