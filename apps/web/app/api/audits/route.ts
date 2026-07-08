import { createAudit } from "@ally-fix/db";
import { createAuditRequestSchema } from "@ally-fix/shared";
import { NextResponse } from "next/server";
import { assertUrlIsSafe } from "@ally-fix/shared/ssrf";
import { getDb } from "@/lib/db";
import { enqueueAudit } from "@/lib/queue";
import { checkAndConsume, clientIp } from "@/lib/rate-limit";

/** Per-IP daily audit cap for the hosted demo. 0 = unlimited (self-host default). */
const DAILY_LIMIT = Number(process.env.DAILY_AUDIT_LIMIT_PER_IP ?? 0);

// This route touches Postgres, Redis, and node:dns — force the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/audits — validate a URL, create an audit, and queue the scan. */
export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  const parsed = createAuditRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid URL is required." }, { status: 400 });
  }

  const safe = await assertUrlIsSafe(parsed.data.url);
  if (!safe.ok) {
    return NextResponse.json({ error: safe.reason }, { status: 400 });
  }

  // Rate-limit valid requests only, so the shared LLM key can't be drained.
  const rate = await checkAndConsume(clientIp(request), DAILY_LIMIT);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: `Daily scan limit reached (${rate.limit}/day per IP). Try again tomorrow, or self-host for unlimited scans.`,
      },
      { status: 429 },
    );
  }

  const db = getDb();
  const audit = await createAudit(db, safe.url);
  await enqueueAudit({ auditId: audit.id, url: safe.url });

  return NextResponse.json({ auditId: audit.id }, { status: 201 });
}
