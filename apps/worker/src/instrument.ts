import { startNodeTelemetry } from "@ally-fix/telemetry/node";
import { telemetryConfig } from "./telemetry";

/**
 * Starts OpenTelemetry for the worker process. Imported first in `index.ts`, so
 * the SDK is registered before anything creates a meter or opens a span.
 *
 * No `--import` loader flag is needed: nothing here patches modules (see
 * `@ally-fix/telemetry/node`), so a plain side-effect import is early enough.
 */
export const telemetry = startNodeTelemetry(telemetryConfig);
