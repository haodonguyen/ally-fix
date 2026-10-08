/**
 * Where telemetry goes, decided once from the environment.
 *
 * Off unless something says where to send it. A self-hoster, the test suite,
 * and CI must never start exporting — or start failing because an exporter
 * can't reach a collector — just because this package is installed.
 *
 * New Relic is the configured backend, but it is reached over plain OTLP, so
 * any OTLP endpoint works the same way (ADR-0009). That is what keeps the
 * instrumentation in the code vendor-neutral: switching backends is an
 * environment change, not a code change.
 */

export type MetricTemporality = "delta" | "cumulative";

export type TelemetryConfig =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      /** Which backend this resolved to — logged at startup, never the key. */
      backend: "newrelic" | "otlp";
      /** OTLP/HTTP base URL; the per-signal path (`/v1/traces`, …) is appended. */
      endpoint: string;
      /** Sent on every export. Holds the ingest key, so it is never logged. */
      headers: Record<string, string>;
      serviceName: string;
      environment: string;
      /**
       * New Relic wants delta counters and converts cumulative ones at a cost;
       * Prometheus-style backends want cumulative. The backend decides, not us.
       */
      metricTemporality: MetricTemporality;
      /**
       * New Relic rejects attribute values over 4095 characters, and a stack
       * trace in a log attribute easily exceeds that. Truncating client-side
       * keeps the record instead of losing it.
       */
      attributeValueLengthLimit: number | undefined;
    };

/** New Relic's OTLP ingest endpoints. The license key only works in its own region. */
export const NEW_RELIC_OTLP_ENDPOINTS = {
  us: "https://otlp.nr-data.net:4318",
  eu: "https://otlp.eu01.nr-data.net:4318",
} as const;

export const NEW_RELIC_ATTRIBUTE_LIMIT = 4095;

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Parses the standard `OTEL_EXPORTER_OTLP_HEADERS` format: `k1=v1,k2=v2`, with
 * values URL-encoded. A malformed pair is skipped rather than fatal — telemetry
 * must never be the reason a process does not start.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}

export interface ResolveTelemetryOptions {
  /** `service.name` when OTEL_SERVICE_NAME does not override it. */
  defaultServiceName: string;
}

/**
 * Resolves the telemetry destination. In order:
 *
 * 1. `OTEL_SDK_DISABLED=true` turns everything off — the standard kill switch,
 *    honoured even when a key is present, so an operator can silence a noisy
 *    deploy without deleting its secret.
 * 2. `NEW_RELIC_LICENSE_KEY` sends to New Relic, in `NEW_RELIC_REGION` (us/eu).
 * 3. `OTEL_EXPORTER_OTLP_ENDPOINT` sends to any OTLP collector, with headers
 *    from `OTEL_EXPORTER_OTLP_HEADERS` — a local collector, Jaeger, Grafana.
 * 4. Otherwise off.
 */
export function resolveTelemetryConfig(
  env: NodeJS.ProcessEnv,
  options: ResolveTelemetryOptions,
): TelemetryConfig {
  if (read(env, "OTEL_SDK_DISABLED")?.toLowerCase() === "true") {
    return { enabled: false, reason: "OTEL_SDK_DISABLED is set" };
  }

  const serviceName = read(env, "OTEL_SERVICE_NAME") ?? options.defaultServiceName;
  const environment = read(env, "NODE_ENV") ?? "development";

  const licenseKey = read(env, "NEW_RELIC_LICENSE_KEY");
  if (licenseKey) {
    const region = read(env, "NEW_RELIC_REGION")?.toLowerCase();
    // An unrecognised region falls back to US rather than disabling: the key
    // will be rejected loudly by the wrong region, which is easier to diagnose
    // than telemetry that silently never started.
    const endpoint = region === "eu" ? NEW_RELIC_OTLP_ENDPOINTS.eu : NEW_RELIC_OTLP_ENDPOINTS.us;
    return {
      enabled: true,
      backend: "newrelic",
      endpoint,
      headers: { "api-key": licenseKey },
      serviceName,
      environment,
      metricTemporality: "delta",
      attributeValueLengthLimit: NEW_RELIC_ATTRIBUTE_LIMIT,
    };
  }

  const endpoint = read(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  if (endpoint) {
    return {
      enabled: true,
      backend: "otlp",
      endpoint: endpoint.replace(/\/+$/, ""),
      headers: parseOtlpHeaders(read(env, "OTEL_EXPORTER_OTLP_HEADERS")),
      serviceName,
      environment,
      metricTemporality: "cumulative",
      attributeValueLengthLimit: undefined,
    };
  }

  return {
    enabled: false,
    reason: "neither NEW_RELIC_LICENSE_KEY nor OTEL_EXPORTER_OTLP_ENDPOINT is set",
  };
}

/** The endpoint's host, for a startup log line. The path and headers stay out of it. */
export function describeDestination(config: TelemetryConfig): string {
  if (!config.enabled) return `disabled (${config.reason})`;
  try {
    return `${config.backend} via ${new URL(config.endpoint).host}`;
  } catch {
    return config.backend;
  }
}
