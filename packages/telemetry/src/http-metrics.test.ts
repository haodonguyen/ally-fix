import { SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { HttpServerMetricsProcessor } from "./http-metrics";
import { captureMetrics } from "./testing";

/** Ends one span through a real tracer, the way Next.js would. */
function serve(
  processor: HttpServerMetricsProcessor,
  attributes: Attributes,
  options: { kind?: SpanKind; error?: boolean } = {},
) {
  const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("next.js");
  const span = tracer.startSpan("request", { kind: options.kind ?? SpanKind.SERVER, attributes });
  if (options.error) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

function setup() {
  const capture = captureMetrics();
  const processor = new HttpServerMetricsProcessor({ meter: () => capture.meter });
  return { processor, points: () => capture.points("http.server.request.duration") };
}

describe("HttpServerMetricsProcessor", () => {
  it("records Next's server spans under the current HTTP conventions", async () => {
    const { processor, points } = setup();

    serve(processor, {
      "http.method": "POST",
      "http.route": "/api/audits",
      "http.status_code": 201,
    });

    const [point] = await points();
    expect(point?.attributes).toEqual({
      "http.request.method": "POST",
      "http.route": "/api/audits",
      "http.response.status_code": 201,
    });
    expect(point?.value).toMatchObject({ count: 1 });
  });

  it("accepts spans already written in the current conventions", async () => {
    const { processor, points } = setup();
    serve(processor, { "http.request.method": "GET", "http.response.status_code": "200" });
    expect((await points())[0]?.attributes).toEqual({
      "http.request.method": "GET",
      "http.response.status_code": 200,
    });
  });

  it("marks a 5xx as an error, which is what New Relic counts", async () => {
    const { processor, points } = setup();
    serve(processor, {
      "http.method": "POST",
      "http.route": "/api/audits",
      "http.status_code": 503,
    });
    expect((await points())[0]?.attributes["error.type"]).toBe("503");
  });

  it("does not count a 4xx as an error — a refused URL is the API working", async () => {
    const { processor, points } = setup();
    serve(processor, {
      "http.method": "POST",
      "http.route": "/api/audits",
      "http.status_code": 429,
    });
    expect((await points())[0]?.attributes).not.toHaveProperty("error.type");
  });

  it("counts a failed span with no status code as an error", async () => {
    const { processor, points } = setup();
    serve(processor, { "http.method": "GET", "error.type": "TypeError" }, { error: true });
    serve(processor, { "http.method": "PUT" }, { error: true });
    const types = (await points()).map((p) => p.attributes["error.type"]).sort();
    expect(types).toEqual(["TypeError", "_OTHER"]);
  });

  it("ignores spans that are not HTTP server requests", async () => {
    const { processor, points } = setup();
    serve(processor, { "http.method": "POST" }, { kind: SpanKind.CLIENT });
    serve(processor, { "next.span_type": "render" });
    expect(await points()).toEqual([]);
  });

  it("flushes metrics when the span pipeline is flushed, and never throws doing it", async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error("collector down"));
    const processor = new HttpServerMetricsProcessor({ flush });
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await processor.shutdown();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("flushes the global meter provider by default, tolerating the no-op one", async () => {
    await expect(new HttpServerMetricsProcessor().forceFlush()).resolves.toBeUndefined();
  });
});
