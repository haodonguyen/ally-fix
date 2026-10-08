import { createLogger, loggerOptionsFromEnv } from "@ally-fix/shared/logger";
import { createOtelLogTap, traceLogFields } from "@ally-fix/telemetry";
import { telemetryConfig } from "./telemetry";

/**
 * The worker's root logger. Every line carries `service`, so worker and web logs
 * stay separable once they land in the same collector.
 *
 * Inside a span, each line also carries `trace.id` and `span.id`. When telemetry
 * is on, records are shipped over OTLP as well as written to stdout: the worker
 * runs on a laptop where nothing collects stdout, and a log line that never
 * leaves the machine cannot be linked to its trace.
 */
export const logger = createLogger({
  ...loggerOptionsFromEnv(),
  base: { service: "worker" },
  context: traceLogFields,
  tap: telemetryConfig.enabled
    ? createOtelLogTap({
        name: "ally-fix-worker",
        valueLengthLimit: telemetryConfig.attributeValueLengthLimit,
      })
    : undefined,
});
