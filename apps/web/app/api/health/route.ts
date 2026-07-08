import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — lightweight liveness probe for the host's health checks. */
export async function GET(): Promise<Response> {
  return NextResponse.json({ status: "ok" });
}
