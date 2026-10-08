import { resolveTelemetryConfig } from "@ally-fix/telemetry";

/**
 * Next.js calls this once per server instance, before serving any request.
 *
 * `@vercel/otel` rather than the Node SDK the worker uses, because this runs as
 * serverless functions on Vercel: a function is frozen the moment its response
 * is sent, so a batch exporter on a timer would lose whatever it had not yet
 * flushed. `@vercel/otel` exports with `fetch` and flushes before the function
 * suspends. With an SDK registered, Next emits its own spans for every request
 * and route, and the spans below join them.
 *
 * Traces, plus one metric derived from them: `http.server.request.duration`,
 * which is what New Relic builds the service's Summary page from (see
 * http-metrics.ts). The web app's logs already carry `trace.id`
 * (lib/logger.ts), and on Vercel they reach New Relic through the platform's
 * log drain rather than from inside a function that is about to be frozen.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const config = resolveTelemetryConfig(process.env, { defaultServiceName: "ally-fix-web" });
  if (!config.enabled) return;

  const [{ registerOTel, OTLPHttpProtoTraceExporter }, { createOtlpMetricReader }, httpMetrics] =
    await Promise.all([
      import("@vercel/otel"),
      import("@ally-fix/telemetry/exporters"),
      import("@ally-fix/telemetry/http-metrics"),
    ]);
  registerOTel({
    serviceName: config.serviceName,
    attributes: { "deployment.environment.name": config.environment },
    traceExporter: new OTLPHttpProtoTraceExporter({
      url: `${config.endpoint}/v1/traces`,
      headers: config.headers,
    }),
    // "auto" keeps the default batch processor for the exporter above.
    spanProcessors: ["auto", new httpMetrics.HttpServerMetricsProcessor()],
    metricReaders: [createOtlpMetricReader(config)],
    spanLimits: { attributeValueLengthLimit: config.attributeValueLengthLimit },
  });
}
