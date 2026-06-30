// POST /api/lead-distribution/tick
// Internal endpoint called by the in-process scheduler. Drains the pending
// lead-distribution queue (off-hours leads) and assigns them once the
// working window is open. Auth via WEBHOOK_INTERNAL_TOKEN.

import { NextResponse, type NextRequest } from "next/server";
import { getCredential } from "@/lib/credentials";
import { drainPendingAssignments } from "@/lib/lead-distribution";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  if (!expected) return NextResponse.json({ error: "WEBHOOK_INTERNAL_TOKEN not set" }, { status: 500 });
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (auth !== expected) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const result = await drainPendingAssignments();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "tick failed" }, { status: 500 });
  }
}
