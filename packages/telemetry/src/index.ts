/**
 * Public surface of @ally-fix/telemetry: config resolution and API-only helpers.
 * The SDK bootstrap lives on the `./node` subpath and test pipelines on
 * `./testing`, so code that only creates spans never loads an exporter.
 */
export {
  resolveTelemetryConfig,
  describeDestination,
  parseOtlpHeaders,
  NEW_RELIC_OTLP_ENDPOINTS,
  NEW_RELIC_ATTRIBUTE_LIMIT,
} from "./config";
export type { TelemetryConfig, MetricTemporality, ResolveTelemetryOptions } from "./config";
export {
  withSpan,
  recordError,
  traceLogFields,
  injectTraceContext,
  extractTraceContext,
  SpanKind,
} from "./trace";
export type { SpanOptions, Attributes, Span } from "./trace";
export { createOtelLogTap, toLogAttributes } from "./logs";
export type { LogTapOptions } from "./logs";
