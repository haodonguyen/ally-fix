import { createLogger, loggerOptionsFromEnv } from "@ally-fix/shared/logger";

/**
 * The web app's root logger. Vercel captures stdout per invocation, so lines
 * land in the function log with `service: "web"` to keep them separable from the
 * worker's once both reach the same collector.
 */
export const logger = createLogger({
  ...loggerOptionsFromEnv(),
  base: { service: "web" },
});
