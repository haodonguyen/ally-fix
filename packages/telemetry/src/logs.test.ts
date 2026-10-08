import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { context, trace } from "@opentelemetry/api";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createOtelLogTap, toLogAttributes } from "./logs";
import { captureSpans } from "./testing";
import { withSpan } from "./trace";

describe("toLogAttributes", () => {
  it("flattens nested fields into dotted keys", () => {
    const attributes = toLogAttributes({
      auditId: "a-1",
      err: { name: "Error", message: "down", cause: { message: "ECONNREFUSED" } },
    });
    expect(attributes).toEqual({
      auditId: "a-1",
      "err.name": "Error",
      "err.message": "down",
      "err.cause.message": "ECONNREFUSED",
    });
  });

  it("drops null rather than exporting an unknown cost as a number", () => {
    expect(toLogAttributes({ costUsd: null, inputTokens: 0, gone: undefined })).toEqual({
      inputTokens: 0,
    });
  });

  it("leaves out fields the log record carries natively", () => {
    const attributes = toLogAttributes({
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      msg: "scan finished",
      "trace.id": "t",
      "span.id": "s",
      issues: 3,
    });
    expect(attributes).toEqual({ issues: 3 });
  });

  it("keeps arrays of primitives and stringifies anything else", () => {
    expect(toLogAttributes({ failed: ["redis", "postgres"], mixed: [{ a: 1 }] })).toEqual({
      failed: ["redis", "postgres"],
      mixed: '[{"a":1}]',
    });
  });

  it("stringifies bigints and what lies past the depth limit", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(toLogAttributes({ n: 10n, deep })).toEqual({ n: "10", "deep.a.b.c.d": '{"e":1}' });
  });

  it("survives a circular value past the depth limit", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const attributes = toLogAttributes({ loop });
    expect(attributes["loop.self.self.self.self"]).toBe("[object Object]");
  });

  it("truncates long strings to the backend's limit", () => {
    const attributes = toLogAttributes(
      { stack: "x".repeat(10), tags: ["y".repeat(10)], obj: [{ k: "z".repeat(10) }] },
      4,
    );
    expect(attributes).toEqual({ stack: "xxxx", tags: ["yyyy"], obj: '[{"k' });
  });
});

describe("createOtelLogTap", () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
  logs.setGlobalLoggerProvider(provider);
  const spans = captureSpans();

  beforeEach(() => exporter.reset());
  afterAll(async () => {
    await provider.shutdown();
    logs.disable();
    await spans.stop();
  });

  const record = {
    ts: "2026-10-08T12:00:00.000Z",
    level: "warn",
    msg: "rule analysis failed",
    ruleId: "image-alt",
  };

  it("emits the record with severity, body, timestamp and flattened attributes", () => {
    createOtelLogTap({ name: "worker" })(record);

    const [emitted] = exporter.getFinishedLogRecords();
    expect(emitted?.body).toBe("rule analysis failed");
    expect(emitted?.severityNumber).toBe(SeverityNumber.WARN);
    expect(emitted?.severityText).toBe("WARN");
    expect(emitted?.attributes).toEqual({ ruleId: "image-alt" });
    expect(emitted?.instrumentationScope.name).toBe("worker");
    expect(emitted?.hrTime[0]).toBe(Date.parse(record.ts) / 1000);
  });

  it("maps an unknown level to UNSPECIFIED rather than dropping the record", () => {
    createOtelLogTap()({ ...record, level: "trace" });
    expect(exporter.getFinishedLogRecords()[0]?.severityNumber).toBe(SeverityNumber.UNSPECIFIED);
  });

  it("stamps the active trace onto the record, which is what links a log to its trace", async () => {
    await withSpan("process audits", {}, async () => createOtelLogTap()(record));

    const span = spans.span("process audits");
    const [emitted] = exporter.getFinishedLogRecords();
    expect(emitted?.spanContext?.traceId).toBe(span.spanContext().traceId);
    expect(emitted?.spanContext?.spanId).toBe(span.spanContext().spanId);
    expect(trace.getSpan(context.active())).toBeUndefined();
  });
});
