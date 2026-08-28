/**
 * Structured logging.
 *
 * `console.log(\`[worker] audit ${id} failed: ${message}\`)` is readable by a
 * person watching a terminal and useless to anything else: you cannot filter it
 * by audit, count failures by rule, or find every line belonging to one scan.
 * Once the worker runs somewhere you cannot watch, that is the only question
 * that matters — "what happened to *this* audit?" — and a prose line cannot
 * answer it.
 *
 * So every line is an object with a level, a message, and fields; `child()`
 * carries correlation fields (an audit id) onto every line written downstream.
 * Rendered as JSON for a log collector, or aligned text when a human is
 * watching.
 *
 * Node-only subpath (`@ally-fix/shared/logger`), never exported from the package
 * index, so it stays out of the browser bundle.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that attaches `fields` to every line it and its children write. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Lines below this level are dropped. Default "info". */
  level?: LogLevel;
  /** "json" for a collector, "pretty" for a terminal. Default "json". */
  format?: "json" | "pretty";
  /** Fields attached to every line. */
  base?: LogFields;
  /** Injectable for tests. Defaults to stdout. */
  sink?: (line: string) => void;
  now?: () => Date;
}

/**
 * Field names whose values are never printed. Matched case-insensitively as a
 * substring, so `GROQ_API_KEY`, `apiKey` and `authorization` are all covered.
 */
const SECRET_KEY_PATTERN = /(key|token|secret|password|passwd|auth|credential)/i;

/** Credentials embedded in a connection string, e.g. redis://user:pass@host. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^/\s@]*@/gi;

const REDACTED = "[redacted]";

/** An Error survives JSON.stringify as `{}`, which silently loses every failure. */
function serializeError(error: Error): LogFields {
  return {
    name: error.name,
    message: scrubText(error.message),
    ...(error.stack ? { stack: scrubText(error.stack) } : {}),
    ...(error.cause !== undefined ? { cause: serializeValue(error.cause) } : {}),
  };
}

function scrubText(value: string): string {
  return value.replace(URL_CREDENTIALS, "$1" + REDACTED + "@");
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Drops secret-looking values and scrubs credentials out of the rest. */
function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : serializeValue(value);
  }
  return out;
}

/** JSON.stringify throws on a circular value; a log line must never do that. */
function safeStringify(record: LogFields): string {
  try {
    return JSON.stringify(record);
  } catch {
    const seen = new WeakSet<object>();
    return JSON.stringify(record, (_key, value: unknown) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      }
      return value;
    });
  }
}

function renderPretty(record: LogFields): string {
  const { ts, level, msg, ...rest } = record as {
    ts: string;
    level: string;
    msg: string;
  } & LogFields;
  const time = ts.slice(11, 23);
  const pairs = Object.entries(rest)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : safeStringify({ v: value }).slice(5, -1)}`,
    )
    .join(" ");
  return `${time} ${level.toUpperCase().padEnd(5)} ${msg}${pairs ? "  " + pairs : ""}`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const format = options.format ?? "json";
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = options.now ?? (() => new Date());

  function build(base: LogFields): Logger {
    function write(level: LogLevel, message: string, fields?: LogFields): void {
      if (LEVEL_ORDER[level] < minimum) return;
      const record: LogFields = {
        ts: now().toISOString(),
        level,
        msg: message,
        ...sanitize({ ...base, ...fields }),
      };
      sink(format === "pretty" ? renderPretty(record) : safeStringify(record));
    }

    return {
      debug: (message, fields) => write("debug", message, fields),
      info: (message, fields) => write("info", message, fields),
      warn: (message, fields) => write("warn", message, fields),
      error: (message, fields) => write("error", message, fields),
      // Merged at creation, so a child costs nothing per line and cannot lose
      // its parent's correlation fields.
      child: (fields) => build({ ...base, ...sanitize(fields) }),
    };
  }

  return build(options.base ?? {});
}

/** Reads level and format from the environment, with sane per-environment defaults. */
export function loggerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  const level = env.LOG_LEVEL?.trim().toLowerCase();
  const format = env.LOG_FORMAT?.trim().toLowerCase();
  const isProduction = env.NODE_ENV === "production";

  return {
    level: level && level in LEVEL_ORDER ? (level as LogLevel) : isProduction ? "info" : "debug",
    // A person is watching in development; a collector is watching in production.
    format: format === "pretty" || format === "json" ? format : isProduction ? "json" : "pretty",
  };
}
