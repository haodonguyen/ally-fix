import { describe, expect, it } from "vitest";
import { createLogger, loggerOptionsFromEnv, type LogFields } from "./logger";

/** Collects emitted lines and parses them back out of JSON. */
function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    now: () => new Date("2026-08-29T12:34:56.789Z"),
    sink: (line) => lines.push(line),
    ...options,
  });
  return { logger, lines, records: () => lines.map((l) => JSON.parse(l) as LogFields) };
}

describe("record shape", () => {
  it("writes one self-describing JSON object per line", () => {
    const { logger, records } = capture();

    logger.info("scan finished", { auditId: "a-1", issues: 42 });

    expect(records()[0]).toEqual({
      ts: "2026-08-29T12:34:56.789Z",
      level: "info",
      msg: "scan finished",
      auditId: "a-1",
      issues: 42,
    });
  });

  it("emits exactly one line per call, so a log collector can split on newlines", () => {
    const { logger, lines } = capture();

    logger.info("a", { multi: "line\nvalue" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });
});

describe("levels", () => {
  it("drops anything below the configured level", () => {
    const { logger, records } = capture({ level: "warn" });

    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");
    logger.error("kept");

    expect(records().map((r) => r.level)).toEqual(["warn", "error"]);
  });
});

describe("child loggers", () => {
  it("carries correlation fields onto every later line", () => {
    // This is the point of the whole exercise: "what happened to THIS audit?"
    const { logger, records } = capture();
    const auditLog = logger.child({ auditId: "a-1" });

    auditLog.info("scan started");
    auditLog.error("scan failed");

    expect(records().every((r) => r.auditId === "a-1")).toBe(true);
  });

  it("inherits through more than one level", () => {
    const { logger, records } = capture();

    logger.child({ auditId: "a-1" }).child({ ruleId: "image-alt" }).info("analysing");

    expect(records()[0]).toMatchObject({ auditId: "a-1", ruleId: "image-alt" });
  });

  it("does not leak a child's fields back to its parent", () => {
    const { logger, records } = capture();

    logger.child({ auditId: "a-1" }).info("child line");
    logger.info("parent line");

    expect(records()[1]).not.toHaveProperty("auditId");
  });

  it("lets a per-call field override an inherited one", () => {
    const { logger, records } = capture();

    logger.child({ stage: "scan" }).info("done", { stage: "analyze" });

    expect(records()[0]?.stage).toBe("analyze");
  });
});

describe("error serialization", () => {
  it("does not let an Error collapse into an empty object", () => {
    // JSON.stringify(new Error("boom")) is "{}" — the failure vanishes silently.
    const { logger, records } = capture();

    logger.error("scan failed", { err: new Error("boom") });

    expect(records()[0]?.err).toMatchObject({ name: "Error", message: "boom" });
    expect(JSON.stringify(records()[0]?.err)).not.toBe("{}");
  });

  it("keeps the stack and the cause chain", () => {
    const { logger, records } = capture();
    const cause = new Error("connection refused");

    logger.error("failed", { err: new Error("wrapped", { cause }) });

    const err = records()[0]?.err as LogFields;
    expect(err.stack).toContain("Error");
    expect(err.cause).toMatchObject({ message: "connection refused" });
  });
});

describe("secrets", () => {
  it("never prints a value under a secret-looking key", () => {
    const { logger, records } = capture();

    logger.info("configured", {
      provider: "groq",
      apiKey: "gsk_realkey",
      GROQ_API_KEY: "gsk_realkey",
      authorization: "Bearer abc",
      sessionToken: "t",
    });

    const line = JSON.stringify(records()[0]);
    expect(line).not.toContain("gsk_realkey");
    expect(line).not.toContain("Bearer abc");
    expect(records()[0]?.provider).toBe("groq"); // non-secrets survive
  });

  it("scrubs credentials out of connection strings anywhere in the line", () => {
    const { logger, records } = capture();

    logger.error("cache unreachable", {
      url: "redis://admin:hunter2@cache.internal:6379",
      err: new Error("getaddrinfo EAI_AGAIN postgres://u:p@db.internal:5432/x"),
    });

    const line = JSON.stringify(records()[0]);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("u:p@");
    // The host is still there — enough to debug without the password.
    expect(line).toContain("cache.internal");
  });

  it("redacts a secret field inherited from a child logger too", () => {
    const { logger, records } = capture();

    logger.child({ apiKey: "gsk_realkey" }).info("hello");

    expect(JSON.stringify(records()[0])).not.toContain("gsk_realkey");
  });
});

describe("robustness", () => {
  it("survives a circular value instead of throwing inside the logger", () => {
    // A logger that can crash the process it is meant to explain is worse than none.
    const { logger, records } = capture();
    const circular: Record<string, unknown> = { name: "job" };
    circular.self = circular;

    expect(() => logger.info("odd payload", { circular })).not.toThrow();
    expect(records()[0]?.msg).toBe("odd payload");
  });
});

describe("pretty format", () => {
  it("renders an aligned human-readable line instead of JSON", () => {
    const { logger, lines } = capture({ format: "pretty" });

    logger.info("scan finished", { auditId: "a-1" });

    expect(lines[0]).toContain("12:34:56.789");
    expect(lines[0]).toContain("INFO");
    expect(lines[0]).toContain("scan finished");
    expect(lines[0]).toContain("auditId=a-1");
    expect(lines[0]?.startsWith("{")).toBe(false);
  });
});

describe("loggerOptionsFromEnv", () => {
  it("defaults to readable and verbose in development", () => {
    expect(loggerOptionsFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      level: "debug",
      format: "pretty",
    });
  });

  it("defaults to machine-readable and quieter in production", () => {
    expect(loggerOptionsFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual({
      level: "info",
      format: "json",
    });
  });

  it("lets the environment override both", () => {
    expect(
      loggerOptionsFromEnv({
        NODE_ENV: "production",
        LOG_LEVEL: "DEBUG",
        LOG_FORMAT: "pretty",
      } as NodeJS.ProcessEnv),
    ).toEqual({ level: "debug", format: "pretty" });
  });

  it("ignores a nonsense value rather than silencing the logs", () => {
    // LOG_LEVEL=verbose must not resolve to a level that drops everything.
    const options = loggerOptionsFromEnv({
      NODE_ENV: "production",
      LOG_LEVEL: "verbose",
    } as NodeJS.ProcessEnv);

    expect(options.level).toBe("info");
  });
});
