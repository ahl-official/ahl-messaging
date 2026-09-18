// POST /api/recurring/tick
// Internal endpoint called by the in-process scheduler. Runs the daily
// recurring-campaign job (each campaign runs at most once per IST day).
// Auth via WEBHOOK_INTERNAL_TOKEN.

import { NextResponse, type NextRequest } from "next/server";
import { getCredential } from "@/lib/credentials";
import { runRecurringDaily } from "@/lib/recurring";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json({ error: "WEBHOOK_INTERNAL_TOKEN not set" }, { status: 500 });
  }
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (auth !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const result = await runRecurringDaily();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "tick failed" }, { status: 500 });
  }
}
