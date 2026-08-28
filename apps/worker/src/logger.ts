import { createLogger, loggerOptionsFromEnv } from "@ally-fix/shared/logger";

/**
 * The worker's root logger. Every line carries `service`, so worker and web logs
 * stay separable once they land in the same collector.
 */
export const logger = createLogger({
  ...loggerOptionsFromEnv(),
  base: { service: "worker" },
});
