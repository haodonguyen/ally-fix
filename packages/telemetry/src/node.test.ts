import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTelemetryConfig, type TelemetryConfig } from "./config";
import { createOtelLogTap } from "./logs";
import { startNodeTelemetry } from "./node";
import { withSpan } from "./trace";

/**
 * Drives the real SDK against a local HTTP server standing in for New Relic's
 * OTLP endpoint. What New Relic needs from the wire — the path per signal, the
 * `api-key` header, protobuf, gzip — is exactly what a misconfiguration breaks
 * silently, so it is asserted on the requests themselves.
 */
interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  bytes: number;
}

let server: Server;
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let bytes = 0;
    req.on("data", (chunk: Buffer) => (bytes += chunk.length));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, bytes });
      res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("startNodeTelemetry", () => {
  it("returns a no-op handle when telemetry is disabled", async () => {
    const telemetry = startNodeTelemetry({ enabled: false, reason: "test" });
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  it("exports traces, metrics and logs to the endpoint the way New Relic expects", async () => {
    const { port } = server.address() as AddressInfo;
    const resolved = resolveTelemetryConfig(
      { NEW_RELIC_LICENSE_KEY: "test-license-key" },
      { defaultServiceName: "ally-fix-test" },
    );
    // Same config New Relic would get, pointed at the local stand-in.
    const config = { ...resolved, endpoint: `http://127.0.0.1:${port}` } as TelemetryConfig;

    const telemetry = startNodeTelemetry(config, { metricExportIntervalMs: 60_000 });
    await withSpan("process audits", {}, async () => {
      createOtelLogTap()({ ts: new Date().toISOString(), level: "info", msg: "scan finished" });
    });
    metrics.getMeter("test").createCounter("allyfix.test").add(1);
    // Shutdown is what flushes, which is why the worker awaits it before exit.
    await telemetry.shutdown();

    const paths = received.map((r) => r.path).sort();
    expect(paths).toEqual(expect.arrayContaining(["/v1/logs", "/v1/metrics", "/v1/traces"]));
    for (const request of received) {
      expect(request.headers["api-key"]).toBe("test-license-key");
      expect(request.headers["content-type"]).toBe("application/x-protobuf");
      expect(request.headers["content-encoding"]).toBe("gzip");
      expect(request.bytes).toBeGreaterThan(0);
    }
  });

  it("bounds the final flush when the endpoint is unreachable", async () => {
    // The previous SDK still owns the globals; release them so this one's
    // registration is real and the span below actually tries to export.
    for (const api of [trace, metrics, logs, context, propagation]) api.disable();
    const telemetry = startNodeTelemetry(
      {
        enabled: true,
        backend: "otlp",
        // Port 9 (discard) on loopback: nothing listens, the connection is refused.
        endpoint: "http://127.0.0.1:9",
        headers: {},
        serviceName: "ally-fix-test",
        environment: "test",
        metricTemporality: "cumulative",
        attributeValueLengthLimit: undefined,
      },
      { shutdownTimeoutMs: 200 },
    );
    await withSpan("lost", {}, async () => undefined);

    const startedAt = Date.now();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    // Unbounded, the exporter retries for its own 10s timeout.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
