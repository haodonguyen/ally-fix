import { createLogger, loggerOptionsFromEnv } from "@ally-fix/shared/logger";
import { traceLogFields } from "@ally-fix/telemetry";

/**
 * The web app's root logger. Vercel captures stdout per invocation, so lines
 * land in the function log with `service: "web"` to keep them separable from the
 * worker's once both reach the same collector.
 *
 * Inside a request span, each line also carries `trace.id` and `span.id` — the
 * fields New Relic uses to open a log line onto its trace.
 */
export const logger = createLogger({
  ...loggerOptionsFromEnv(),
  base: { service: "web" },
  context: traceLogFields,
});
