/**
 * Test seams: real SDK pipelines that record into memory.
 *
 * Asserting on a mocked `startActiveSpan` proves only that a function was
 * called. These run the actual tracer and meter, so a test sees what an exporter
 * would — including parentage across `await`, which needs the async-hooks
 * context manager that `NodeTracerProvider.register()` installs.
 */
import { context, propagation, trace, type Meter } from "@opentelemetry/api";
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type DataPoint,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface SpanCapture {
  spans(): ReadableSpan[];
  /** The one finished span with this name; throws if there are none or several. */
  span(name: string): ReadableSpan;
  reset(): void;
  /** Unregisters the global provider, so the next suite starts clean. */
  stop(): Promise<void>;
}

export function captureSpans(): SpanCapture {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();

  return {
    spans: () => exporter.getFinishedSpans(),
    span(name) {
      const matches = exporter.getFinishedSpans().filter((s) => s.name === name);
      if (matches.length !== 1) {
        throw new Error(`expected one span named "${name}", found ${matches.length}`);
      }
      return matches[0]!;
    },
    reset: () => exporter.reset(),
    async stop() {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

class CollectingReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

export interface RecordedPoint {
  attributes: Record<string, unknown>;
  /** A counter's sum, or a histogram's `{ count, sum }`. */
  value: number | { count: number; sum: number | undefined };
}

export interface MetricCapture {
  /** Pass to the code under test; it is not registered globally. */
  meter: Meter;
  /** Every point recorded so far for `name`, cumulatively. */
  points(name: string): Promise<RecordedPoint[]>;
}

export function captureMetrics(): MetricCapture {
  const reader = new CollectingReader();
  const provider = new MeterProvider({ readers: [reader] });

  return {
    meter: provider.getMeter("test"),
    async points(name) {
      const { resourceMetrics } = await reader.collect();
      const metric = resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .find((m) => m.descriptor.name === name);
      if (!metric) return [];
      return (metric.dataPoints as DataPoint<unknown>[]).map((point) => ({
        attributes: point.attributes,
        value:
          typeof point.value === "number"
            ? point.value
            : {
                count: (point.value as { count: number }).count,
                sum: (point.value as { sum?: number }).sum,
              },
      }));
    },
  };
}
