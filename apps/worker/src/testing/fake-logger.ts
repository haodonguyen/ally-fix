import { createLogger, type LogFields, type Logger } from "@ally-fix/shared/logger";

/**
 * A real logger writing into an array instead of stdout.
 *
 * Using the actual implementation rather than a stub means `child()` correlation
 * and error serialization are genuinely exercised by every test that logs, and
 * assertions can be made about what the logs would say in production — which is
 * the only way to know the logs are worth anything.
 */
export interface CapturedLogger {
  logger: Logger;
  records: LogFields[];
  /** Every record whose `msg` matches exactly. */
  find(message: string): LogFields[];
  /** The first such record, or undefined. */
  first(message: string): LogFields | undefined;
}

export function createFakeLogger(): CapturedLogger {
  const records: LogFields[] = [];
  const logger = createLogger({
    level: "debug",
    format: "json",
    sink: (line) => records.push(JSON.parse(line) as LogFields),
  });
  const find = (message: string) => records.filter((r) => r.msg === message);
  return { logger, records, find, first: (message) => find(message)[0] };
}
