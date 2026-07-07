import { getAuditById, getIssuesByAudit } from "@ally-fix/db";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/audits/:id — return the audit and its issues (polled by the report UI). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();

  const audit = await getAuditById(db, id);
  if (!audit) {
    return NextResponse.json({ error: "Audit not found." }, { status: 404 });
  }

  const issues = await getIssuesByAudit(db, id);
  return NextResponse.json({ audit, issues });
}
