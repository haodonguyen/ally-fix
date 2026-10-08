/**
 * Ships structured log records over OTLP, alongside the stdout line.
 *
 * The worker runs on demand from a laptop, where nothing tails stdout into a
 * collector — so its logs leave the process the same way its spans do. Each
 * record is emitted inside the caller's async context, which is what lets the
 * SDK stamp it with the active trace and span ids: in New Relic, a log line
 * opens straight onto the trace it was written from.
 *
 * Records arrive here *after* the logger has redacted secrets, so the export
 * path cannot leak what the stdout path would not.
 */
import { logs, SeverityNumber, type AnyValueMap } from "@opentelemetry/api-logs";

type Primitive = string | number | boolean;
type AttributeValue = Primitive | Primitive[];

const SEVERITY: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/** Fields the log record already carries natively, so are not repeated as attributes. */
const NATIVE_FIELDS = new Set(["ts", "level", "msg", "trace.id", "span.id"]);

/** Nested deeper than this is stringified rather than flattened further. */
const MAX_DEPTH = 4;

function truncate(value: string, limit: number | undefined): string {
  return limit !== undefined && value.length > limit ? value.slice(0, limit) : value;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Flattens a log record's fields into OTLP attributes: `err: { message }`
 * becomes `err.message`, which is how New Relic indexes it for querying.
 *
 * `null` and `undefined` are dropped, not coerced. A null `costUsd` means "no
 * price configured" (ADR-0008); exporting it as 0 or "null" would turn an
 * honest unknown into a number someone sums.
 */
export function toLogAttributes(
  fields: Record<string, unknown>,
  valueLengthLimit?: number,
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};

  function visit(prefix: string, value: unknown, depth: number): void {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      out[prefix] = truncate(value, valueLengthLimit);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[prefix] = value;
    } else if (typeof value === "bigint") {
      out[prefix] = value.toString();
    } else if (Array.isArray(value)) {
      const primitives = value.every(
        (item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      );
      out[prefix] = primitives
        ? (value as Primitive[]).map((item) =>
            typeof item === "string" ? truncate(item, valueLengthLimit) : item,
          )
        : truncate(stringify(value), valueLengthLimit);
    } else if (typeof value === "object" && depth < MAX_DEPTH) {
      for (const [key, nested] of Object.entries(value)) {
        visit(`${prefix}.${key}`, nested, depth + 1);
      }
    } else {
      out[prefix] = truncate(stringify(value), valueLengthLimit);
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    if (!NATIVE_FIELDS.has(key)) visit(key, value, 0);
  }
  return out;
}

export interface LogTapOptions {
  /** Instrumentation scope name the records are emitted under. */
  name?: string;
  valueLengthLimit?: number;
}

/**
 * A logger `tap` that re-emits each record through the OpenTelemetry logs API.
 * A no-op until a logger provider is registered, so it is safe to install
 * unconditionally.
 */
export function createOtelLogTap(options: LogTapOptions = {}) {
  return (record: { ts: string; level: string; msg: string } & Record<string, unknown>): void => {
    logs.getLogger(options.name ?? "ally-fix").emit({
      timestamp: new Date(record.ts),
      severityNumber: SEVERITY[record.level] ?? SeverityNumber.UNSPECIFIED,
      severityText: record.level.toUpperCase(),
      body: record.msg,
      attributes: toLogAttributes(record, options.valueLengthLimit) as AnyValueMap,
    });
  };
}
