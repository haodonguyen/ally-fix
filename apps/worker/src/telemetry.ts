import { resolveTelemetryConfig } from "@ally-fix/telemetry";
import { metrics, type Meter } from "@opentelemetry/api";

/**
 * The worker's telemetry destination, resolved once. Pure — reading it starts
 * nothing; `instrument.ts` is what starts the SDK.
 */
export const telemetryConfig = resolveTelemetryConfig(process.env, {
  defaultServiceName: "ally-fix-worker",
});

/** What a finished analysis pass reports, narrowed to what the metrics read. */
export interface AnalysisCounts {
  analyzed: number;
  failed: number;
  skipped: number;
  cacheHits: number;
}

/**
 * Pipeline metrics. Spans answer "what happened to this audit?"; these answer
 * "how is the worker doing?" — and unlike spans they are never sampled, so a
 * p95 over them is a p95 over every audit.
 *
 * Durations are in seconds, the OpenTelemetry convention.
 */
export interface AuditMetrics {
  /** Time the job sat in Redis before a worker took it. */
  queueWait(seconds: number): void;
  scanned(seconds: number, issues: number): void;
  analysed(counts: AnalysisCounts): void;
  finished(outcome: "completed" | "failed", seconds: number): void;
  recovered(count: number): void;
}

/**
 * Created when the processor is built, not at import, because the metrics API
 * has no proxy: an instrument made before the SDK starts stays a no-op.
 */
export function createAuditMetrics(
  meter: Meter = metrics.getMeter("ally-fix-worker"),
): AuditMetrics {
  const queueWait = meter.createHistogram("allyfix.audit.queue_wait", {
    description:
      "Time from enqueue to pickup. In the on-demand model, how long nobody was running a worker",
    unit: "s",
  });
  const scanDuration = meter.createHistogram("allyfix.scan.duration", {
    description: "Page load plus axe run",
    unit: "s",
  });
  const scanIssues = meter.createHistogram("allyfix.scan.issues", {
    description: "Issues axe reported per scan",
    unit: "{issue}",
  });
  const ruleGroups = meter.createCounter("allyfix.llm.rule_groups", {
    description: "Rule groups by how their analysis ended",
    unit: "{group}",
  });
  const auditDuration = meter.createHistogram("allyfix.audit.duration", {
    description: "Pickup to completion or failure",
    unit: "s",
  });
  const recovered = meter.createCounter("allyfix.audit.recovered", {
    description: "Audits a dead worker abandoned, swept to failed by the reaper",
    unit: "{audit}",
  });

  return {
    queueWait: (seconds) => queueWait.record(seconds),
    scanned(seconds, issues) {
      scanDuration.record(seconds);
      scanIssues.record(issues);
    },
    analysed({ analyzed, failed, skipped, cacheHits }) {
      // `analyzed` includes cache hits; split them so "generated" is the
      // number that cost tokens.
      const outcomes = {
        generated: analyzed - cacheHits,
        cache_hit: cacheHits,
        failed,
        skipped,
      };
      for (const [outcome, count] of Object.entries(outcomes)) {
        if (count > 0) ruleGroups.add(count, { "allyfix.llm.outcome": outcome });
      }
    },
    finished: (outcome, seconds) =>
      auditDuration.record(seconds, { "allyfix.audit.outcome": outcome }),
    recovered(count) {
      if (count > 0) recovered.add(count);
    },
  };
}
