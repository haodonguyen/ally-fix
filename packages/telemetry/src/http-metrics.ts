/**
 * Derives the `http.server.request.duration` metric from server spans.
 *
 * New Relic's APM Summary page — throughput, response time, error rate — is
 * built from that metric, not from spans: a service that sends only traces gets
 * an empty Summary and a "Required metrics are missing" banner. Next.js already
 * opens a server span for every request, with the method, route and status on
 * it, so the metric is recorded from the span as it ends rather than by
 * wrapping every route handler by hand.
 *
 * Next labels those spans with the older HTTP conventions (`http.method`,
 * `http.status_code`); the metric is written in the current ones
 * (`http.request.method`, `http.response.status_code`, `error.type`), which is
 * what New Relic keys on.
 */
import { metrics, SpanKind, SpanStatusCode, type Context, type Meter } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export interface HttpServerMetricsOptions {
  /**
   * Where the metric goes. Read on first use rather than at construction,
   * because the processor is built before the SDK registers its meter provider.
   */
  meter?: () => Meter;
  /**
   * Called by `forceFlush`. On Vercel, `@vercel/otel` force-flushes every span
   * processor once a request's root span ends, inside `waitUntil` — so this is
   * how the metric leaves a serverless function before it is frozen, without a
   * timer that would never fire.
   */
  flush?: () => Promise<void>;
}

/** Flushes the global meter provider, when it is an SDK one that can. */
async function flushGlobalMeterProvider(): Promise<void> {
  const provider = metrics.getMeterProvider() as { forceFlush?: () => Promise<void> };
  await provider.forceFlush?.();
}

function durationSeconds(span: ReadableSpan): number {
  const [seconds, nanos] = span.duration;
  return seconds + nanos / 1e9;
}

function stringAttribute(span: ReadableSpan, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = span.attributes[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function numberAttribute(span: ReadableSpan, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = span.attributes[name];
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/**
 * Why a request failed, as `error.type` — which is the only thing New Relic
 * reads to count an error. Per the conventions a 5xx is a server error and a
 * 4xx is not: a rejected URL or a rate limit is the API working.
 */
function errorType(span: ReadableSpan, status: number | undefined): string | undefined {
  if (status !== undefined && status >= 500) return String(status);
  if (span.status.code === SpanStatusCode.ERROR) {
    return stringAttribute(span, "error.type") ?? "_OTHER";
  }
  return undefined;
}

export class HttpServerMetricsProcessor implements SpanProcessor {
  private histogram: ReturnType<Meter["createHistogram"]> | undefined;
  private readonly getMeter: () => Meter;
  private readonly flush: () => Promise<void>;

  constructor(options: HttpServerMetricsOptions = {}) {
    this.getMeter = options.meter ?? (() => metrics.getMeter("ally-fix-web"));
    this.flush = options.flush ?? flushGlobalMeterProvider;
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (span.kind !== SpanKind.SERVER) return;
    const method = stringAttribute(span, "http.request.method", "http.method");
    // Not an HTTP request span; New Relic would discard it without a method.
    if (!method) return;

    const status = numberAttribute(span, "http.response.status_code", "http.status_code");
    const route = stringAttribute(span, "http.route");
    const error = errorType(span, status);

    this.histogram ??= this.getMeter().createHistogram("http.server.request.duration", {
      description: "Duration of HTTP server requests",
      unit: "s",
    });
    this.histogram.record(durationSeconds(span), {
      "http.request.method": method,
      // Without a route New Relic names the transaction `GET unknown`; with the
      // raw path instead it would mint one transaction per audit id.
      ...(route && { "http.route": route }),
      ...(status !== undefined && { "http.response.status_code": status }),
      ...(error && { "error.type": error }),
    });
  }

  async forceFlush(): Promise<void> {
    try {
      await this.flush();
    } catch {
      // A failed metric export must not fail the span flush it rides along with.
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}
