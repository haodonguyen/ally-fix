import { captureMetrics } from "@ally-fix/telemetry/testing";
import { describe, expect, it } from "vitest";
import { createAuditMetrics } from "./telemetry";

describe("createAuditMetrics", () => {
  it("splits analysed groups into generated and cache hits, skipping zero counts", async () => {
    const { meter, points } = captureMetrics();
    const metrics = createAuditMetrics(meter);

    metrics.analysed({ analyzed: 5, cacheHits: 3, failed: 1, skipped: 0 });

    const byOutcome = Object.fromEntries(
      (await points("allyfix.llm.rule_groups")).map((p) => [
        p.attributes["allyfix.llm.outcome"],
        p.value,
      ]),
    );
    expect(byOutcome).toEqual({ generated: 2, cache_hit: 3, failed: 1 });
  });

  it("counts the circuit's skipped groups, the signal that a provider is down", async () => {
    const { meter, points } = captureMetrics();
    createAuditMetrics(meter).analysed({ analyzed: 0, cacheHits: 0, failed: 0, skipped: 7 });
    expect(await points("allyfix.llm.rule_groups")).toEqual([
      { attributes: { "allyfix.llm.outcome": "skipped" }, value: 7 },
    ]);
  });

  it("records scan duration and issue count together", async () => {
    const { meter, points } = captureMetrics();
    createAuditMetrics(meter).scanned(4.2, 67);
    expect((await points("allyfix.scan.duration"))[0]?.value).toEqual({ count: 1, sum: 4.2 });
    expect((await points("allyfix.scan.issues"))[0]?.value).toEqual({ count: 1, sum: 67 });
  });

  it("counts recovered audits, and records nothing for an empty sweep", async () => {
    const { meter, points } = captureMetrics();
    const metrics = createAuditMetrics(meter);
    metrics.recovered(0);
    expect(await points("allyfix.audit.recovered")).toEqual([]);
    metrics.recovered(2);
    expect((await points("allyfix.audit.recovered"))[0]?.value).toBe(2);
  });

  it("falls back to the global meter, which is a no-op without the SDK", () => {
    expect(() => createAuditMetrics().finished("completed", 1)).not.toThrow();
  });
});
