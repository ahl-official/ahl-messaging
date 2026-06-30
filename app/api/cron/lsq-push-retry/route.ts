// POST /api/cron/lsq-push-retry
//
// Background job: re-attempt every due `pending` row in lsq_push_failures
// (failed Source/Sub-source pushes, almost always LSQ rate limits). Fired by
// the instrumentation heartbeat every 2 minutes. Internal-token auth.

import { NextResponse, type NextRequest } from "next/server";
import { getCredential } from "@/lib/credentials";
import { processPushRetries } from "@/lib/lsq-push-failures";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || (auth !== expected && body.token !== expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const summary = await processPushRetries();
  return NextResponse.json({ ok: true, ...summary });
}
