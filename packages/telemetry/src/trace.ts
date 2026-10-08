/**
 * Tracing helpers that depend only on `@opentelemetry/api`.
 *
 * The API is a no-op until an SDK registers itself, so everything here is safe
 * to call from library code, tests, and the eval harness: with telemetry off, a
 * span costs a function call and records nothing.
 */
import {
  context,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";

export { SpanKind, type Attributes, type Span };

const TRACER_NAME = "ally-fix";

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Parent context; defaults to the active one. */
  parent?: Context;
  links?: Link[];
}

/**
 * Runs `fn` inside a new active span and ends it however `fn` settles.
 *
 * A throw is recorded on the span — exception event plus ERROR status — and
 * then rethrown untouched: tracing observes failures, it never changes them.
 * The tracer is looked up per call rather than cached at import, so a span
 * started after the SDK registers is real even if this module loaded first.
 */
export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const parent = options.parent ?? context.active();
  return tracer.startActiveSpan(
    name,
    { kind: options.kind, attributes: options.attributes, links: options.links },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Marks a span failed, in the shape New Relic's errors inbox reads. */
export function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.setAttribute("error.type", error.name);
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
    span.setAttribute("error.type", "_OTHER");
  }
}

/**
 * The active trace and span ids, under the attribute names New Relic uses to
 * link a log line to its trace ("logs in context"). Undefined outside a real
 * span, so a log line written with telemetry off carries no empty ids.
 */
export function traceLogFields(): Record<string, string> | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
  return { "trace.id": spanContext.traceId, "span.id": spanContext.spanId };
}

/**
 * The active context as W3C `traceparent` / `tracestate` headers, for carrying a
 * trace across something that is not an HTTP call — here, a BullMQ job.
 * Empty when there is nothing to propagate.
 */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * The inverse: a parent context from a carrier. A missing or garbled carrier
 * yields a fresh root, so the consumer still gets a trace of its own — just not
 * one joined to the producer's.
 */
export function extractTraceContext(carrier: Record<string, string> | undefined): Context {
  if (!carrier) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, carrier);
}
