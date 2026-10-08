/**
 * OTLP exporter wiring shared by every runtime: the worker's Node SDK and the
 * web app's `@vercel/otel` setup build their metric reader from the same place,
 * so both send what New Relic expects (delta counters, gzip, per-signal paths).
 */
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { AggregationTemporality, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { TelemetryConfig } from "./config";

type EnabledConfig = Extract<TelemetryConfig, { enabled: true }>;

/** URL, headers and compression for one signal's OTLP/HTTP exporter. */
export function otlpExporterOptions(config: EnabledConfig, signal: "traces" | "metrics" | "logs") {
  return {
    url: `${config.endpoint}/v1/${signal}`,
    headers: config.headers,
    // New Relic bills ingest by volume; OTLP protobuf compresses well.
    compression: CompressionAlgorithm.GZIP,
  };
}

/**
 * A metric reader that exports on an interval. A minute is the SDK default and
 * New Relic's own; a serverless function, which may never live that long, also
 * flushes it at the end of each request (see http-metrics.ts).
 */
export function createOtlpMetricReader(
  config: EnabledConfig,
  exportIntervalMs = 60_000,
): PeriodicExportingMetricReader {
  return new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      ...otlpExporterOptions(config, "metrics"),
      temporalityPreference:
        config.metricTemporality === "delta"
          ? AggregationTemporality.DELTA
          : AggregationTemporality.CUMULATIVE,
    }),
    exportIntervalMillis: exportIntervalMs,
  });
}
