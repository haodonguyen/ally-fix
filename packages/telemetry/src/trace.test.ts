import { SpanStatusCode, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { captureSpans } from "./testing";
import {
  SpanKind,
  extractTraceContext,
  injectTraceContext,
  recordError,
  traceLogFields,
  withSpan,
} from "./trace";

const capture = captureSpans();
beforeEach(() => capture.reset());
afterAll(() => capture.stop());

describe("withSpan", () => {
  it("returns the callback's value and ends the span", async () => {
    const result = await withSpan(
      "work",
      { attributes: { "allyfix.rule": "image-alt" } },
      async () => 42,
    );

    expect(result).toBe(42);
    const span = capture.span("work");
    expect(span.attributes["allyfix.rule"]).toBe("image-alt");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records a failure on the span and rethrows the same error", async () => {
    const boom = new TypeError("boom");
    await expect(withSpan("work", {}, async () => Promise.reject(boom))).rejects.toBe(boom);

    const span = capture.span("work");
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "boom" });
    expect(span.attributes["error.type"]).toBe("TypeError");
    expect(span.events.map((e) => e.name)).toContain("exception");
  });

  it("parents spans opened inside the callback, across an await", async () => {
    await withSpan("outer", {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await withSpan("inner", {}, async () => undefined);
    });

    const outer = capture.span("outer");
    const inner = capture.span("inner");
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it("passes the span kind through", async () => {
    await withSpan("consume", { kind: SpanKind.CONSUMER }, async () => undefined);
    expect(capture.span("consume").kind).toBe(SpanKind.CONSUMER);
  });
});

describe("recordError", () => {
  it("handles a thrown value that is not an Error", async () => {
    await withSpan("work", {}, async (span) => recordError(span, "a string"));
    const span = capture.span("work");
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "a string" });
    expect(span.attributes["error.type"]).toBe("_OTHER");
  });
});

describe("traceLogFields", () => {
  it("is undefined outside a span", () => {
    expect(traceLogFields()).toBeUndefined();
  });

  it("names the active trace and span the way New Relic links logs to traces", async () => {
    let fields: Record<string, string> | undefined;
    await withSpan("work", {}, async () => {
      fields = traceLogFields();
    });
    const span = capture.span("work");
    expect(fields).toEqual({
      "trace.id": span.spanContext().traceId,
      "span.id": span.spanContext().spanId,
    });
  });
});

describe("trace context propagation", () => {
  it("round-trips through a plain carrier, joining the consumer to the producer's trace", async () => {
    let carrier: Record<string, string> = {};
    await withSpan("publish", { kind: SpanKind.PRODUCER }, async () => {
      carrier = injectTraceContext();
    });
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await withSpan("process", { parent: extractTraceContext(carrier) }, async () => undefined);

    const publish = capture.span("publish");
    const process = capture.span("process");
    expect(process.spanContext().traceId).toBe(publish.spanContext().traceId);
    expect(process.parentSpanContext?.spanId).toBe(publish.spanContext().spanId);
  });

  it("injects nothing outside a span", () => {
    expect(injectTraceContext()).toEqual({});
  });

  it("starts a fresh root when the carrier is missing or garbled", async () => {
    await withSpan("a", { parent: extractTraceContext(undefined) }, async () => undefined);
    await withSpan(
      "b",
      { parent: extractTraceContext({ traceparent: "nonsense" }) },
      async () => undefined,
    );
    expect(capture.span("a").parentSpanContext).toBeUndefined();
    expect(capture.span("b").parentSpanContext).toBeUndefined();
  });

  it("ignores the active span when given an explicit parent", async () => {
    await withSpan("unrelated", {}, async () => {
      await withSpan("root", { parent: extractTraceContext(undefined) }, async () => undefined);
    });
    expect(capture.span("root").spanContext().traceId).not.toBe(
      capture.span("unrelated").spanContext().traceId,
    );
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});
