/**
 * OpenTelemetry SDK bootstrap for a long-running Node process (the worker).
 *
 * Kept on its own subpath so library code, which only needs the API, never pulls
 * in the SDK and its exporters.
 *
 * What is instrumented, and what deliberately is not:
 *
 * - **Manual spans** around the audit pipeline and every LLM attempt carry the
 *   attributes that answer real questions (which rule, which model, how many
 *   tokens, retryable or not). Auto-instrumentation cannot know any of that.
 * - **undici** (`fetch`) gives each LLM provider call an HTTP span. It hooks
 *   Node's diagnostics channels rather than patching modules, so it works under
 *   ESM and tsx with no `--import` loader flag.
 * - **Node runtime** metrics (event-loop delay, heap) — the signal that a
 *   Chromium-heavy scan is starving the process.
 * - **Not ioredis.** BullMQ holds a blocking poll open on Redis permanently;
 *   instrumenting it buries the pipeline spans under a stream of idle polls.
 * - **Not Postgres.** postgres.js has no OpenTelemetry instrumentation; the DB
 *   writes show up as time inside the pipeline spans, not as spans of their own.
 */
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { TelemetryConfig } from "./config";
import { createOtlpMetricReader, otlpExporterOptions } from "./exporters";

export interface NodeTelemetry {
  /** Flushes everything buffered and stops exporting. Never rejects. */
  shutdown(): Promise<void>;
}

const noopTelemetry: NodeTelemetry = { shutdown: async () => undefined };

export interface StartNodeTelemetryOptions {
  /**
   * How often metrics are exported. A minute is the SDK default and New Relic's
   * own; tests shorten it.
   */
  metricExportIntervalMs?: number;
  /**
   * Upper bound on the final flush. An unreachable collector makes the exporters
   * retry until their own timeout, and the worker's exit must not wait on that:
   * SIGKILL follows SIGTERM on a fixed timer whether telemetry flushed or not.
   */
  shutdownTimeoutMs?: number;
}

/**
 * Starts the SDK when `config` is enabled; otherwise returns a no-op handle so
 * the caller's shutdown path is the same either way.
 *
 * Must run before anything creates a meter: unlike tracers, the metrics API has
 * no proxy, so an instrument created against the default no-op provider stays a
 * no-op for good.
 */
export function startNodeTelemetry(
  config: TelemetryConfig,
  options: StartNodeTelemetryOptions = {},
): NodeTelemetry {
  if (!config.enabled) return noopTelemetry;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      "deployment.environment.name": config.environment,
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter(otlpExporterOptions(config, "traces"))),
    ],
    metricReaders: [createOtlpMetricReader(config, options.metricExportIntervalMs)],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter(otlpExporterOptions(config, "logs")),
      }),
    ],
    spanLimits: { attributeValueLengthLimit: config.attributeValueLengthLimit },
    instrumentations: [
      // Only calls made inside a pipeline span; a stray fetch outside any audit
      // would otherwise become a root trace of its own.
      new UndiciInstrumentation({ requireParentforSpans: true }),
      new RuntimeNodeInstrumentation(),
    ],
  });

  sdk.start();

  return {
    async shutdown() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.shutdownTimeoutMs ?? 5_000);
      });
      try {
        await Promise.race([sdk.shutdown(), deadline]);
      } catch {
        // An unreachable collector at exit must not turn a clean shutdown into
        // a failed one. What was lost is lost either way.
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
