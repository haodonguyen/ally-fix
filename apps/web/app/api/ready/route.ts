import { NextResponse } from "next/server";
import { pingDatabase } from "@ally-fix/db";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ready — readiness, as opposed to the liveness probe at /api/health.
 *
 * The distinction matters: liveness answers "is this process alive?" and must
 * stay dependency-free, because a probe that fails during a transient Postgres
 * blip would have the platform restart a perfectly healthy app. Readiness
 * answers "can it actually serve a request?", which does require its
 * dependencies — so it belongs on a separate endpoint that no restart policy
 * watches.
 *
 * Each dependency is reported individually, so a failure says which one.
 */
async function check(name: string, probe: () => Promise<unknown>) {
  const startedAt = Date.now();
  try {
    await probe();
    return { name, ok: true as const, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name,
      ok: false as const,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(): Promise<Response> {
  const checks = await Promise.all([
    check("postgres", () => pingDatabase(getDb())),
    check("redis", () => getRedis().ping()),
  ]);

  const ok = checks.every((c) => c.ok);
  if (!ok) {
    logger.warn("readiness check failed", {
      failed: checks.filter((c) => !c.ok).map((c) => c.name),
    });
  }

  return NextResponse.json(
    { status: ok ? "ready" : "degraded", checks },
    { status: ok ? 200 : 503 },
  );
}
