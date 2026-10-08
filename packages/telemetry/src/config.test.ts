import { describe, expect, it } from "vitest";
import {
  NEW_RELIC_OTLP_ENDPOINTS,
  describeDestination,
  parseOtlpHeaders,
  resolveTelemetryConfig,
} from "./config";

const opts = { defaultServiceName: "ally-fix-worker" };

describe("resolveTelemetryConfig", () => {
  it("is off when nothing says where to send telemetry", () => {
    const config = resolveTelemetryConfig({}, opts);
    expect(config.enabled).toBe(false);
  });

  it("sends to New Relic US with the license key as the api-key header", () => {
    const config = resolveTelemetryConfig(
      { NEW_RELIC_LICENSE_KEY: "abc123NRAL", NODE_ENV: "production" },
      opts,
    );
    expect(config).toMatchObject({
      enabled: true,
      backend: "newrelic",
      endpoint: NEW_RELIC_OTLP_ENDPOINTS.us,
      headers: { "api-key": "abc123NRAL" },
      serviceName: "ally-fix-worker",
      environment: "production",
      // New Relic converts cumulative counters at a cost; it wants delta.
      metricTemporality: "delta",
      attributeValueLengthLimit: 4095,
    });
  });

  it("uses the EU endpoint when the region says so, in any case", () => {
    const config = resolveTelemetryConfig(
      { NEW_RELIC_LICENSE_KEY: "k", NEW_RELIC_REGION: " EU " },
      opts,
    );
    expect(config.enabled && config.endpoint).toBe(NEW_RELIC_OTLP_ENDPOINTS.eu);
  });

  it("falls back to US for an unknown region rather than silently disabling", () => {
    const config = resolveTelemetryConfig(
      { NEW_RELIC_LICENSE_KEY: "k", NEW_RELIC_REGION: "ap" },
      opts,
    );
    expect(config.enabled && config.endpoint).toBe(NEW_RELIC_OTLP_ENDPOINTS.us);
  });

  it("treats a blank license key as absent", () => {
    expect(resolveTelemetryConfig({ NEW_RELIC_LICENSE_KEY: "  " }, opts).enabled).toBe(false);
  });

  it("lets OTEL_SERVICE_NAME override the default service name", () => {
    const config = resolveTelemetryConfig(
      { NEW_RELIC_LICENSE_KEY: "k", OTEL_SERVICE_NAME: "allyfix-worker-laptop" },
      opts,
    );
    expect(config.enabled && config.serviceName).toBe("allyfix-worker-laptop");
  });

  it("sends to a generic OTLP collector with cumulative metrics and no length cap", () => {
    const config = resolveTelemetryConfig(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/",
        OTEL_EXPORTER_OTLP_HEADERS: "x-tenant=dev",
      },
      opts,
    );
    expect(config).toMatchObject({
      enabled: true,
      backend: "otlp",
      endpoint: "http://localhost:4318",
      headers: { "x-tenant": "dev" },
      metricTemporality: "cumulative",
      attributeValueLengthLimit: undefined,
    });
  });

  it("prefers New Relic when both are configured", () => {
    const config = resolveTelemetryConfig(
      { NEW_RELIC_LICENSE_KEY: "k", OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      opts,
    );
    expect(config.enabled && config.backend).toBe("newrelic");
  });

  it("honours OTEL_SDK_DISABLED even with a key present", () => {
    const config = resolveTelemetryConfig(
      { NEW_RELIC_LICENSE_KEY: "k", OTEL_SDK_DISABLED: "TRUE" },
      opts,
    );
    expect(config).toEqual({ enabled: false, reason: "OTEL_SDK_DISABLED is set" });
  });
});

describe("parseOtlpHeaders", () => {
  it("parses comma-separated pairs and URL-decodes values", () => {
    expect(parseOtlpHeaders("api-key=a%3Db, x-scope = team ")).toEqual({
      "api-key": "a=b",
      "x-scope": "team",
    });
  });

  it("skips malformed pairs instead of throwing", () => {
    expect(parseOtlpHeaders("novalue,=orphan,ok=1,bad=%E0%A4%A")).toEqual({
      ok: "1",
      bad: "%E0%A4%A",
    });
  });

  it("returns nothing for an absent value", () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });
});

describe("describeDestination", () => {
  it("names the backend and host, never the key", () => {
    const config = resolveTelemetryConfig({ NEW_RELIC_LICENSE_KEY: "secret-key" }, opts);
    const description = describeDestination(config);
    expect(description).toBe("newrelic via otlp.nr-data.net:4318");
    expect(description).not.toContain("secret-key");
  });

  it("says why telemetry is off", () => {
    expect(describeDestination(resolveTelemetryConfig({}, opts))).toMatch(/^disabled \(/);
  });

  it("survives an endpoint that is not a URL", () => {
    const config = resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }, opts);
    expect(describeDestination(config)).toBe("otlp");
  });
});
