// POST /api/triggers/tick
//
// Periodic worker — resumes trigger-flow runs whose timeout has elapsed:
//   • Wait-for-reply nodes where the patient never replied in time → fire
//     the node's "timeout" branch (or end the run if it isn't wired).
//   • Delay nodes whose wait has passed → continue down the default edge.
//
// Auth: shared WEBHOOK_INTERNAL_TOKEN, same handshake as the other internal
// workers. Called every ~60s from instrumentation.ts (worker 0 only).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { resumeDueWaits } from "@/lib/trigger-engine";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json({ error: "WEBHOOK_INTERNAL_TOKEN not set" }, { status: 500 });
  }
  let token: string | null = null;
  try {
    token = ((await request.json()) as { token?: string })?.token ?? null;
  } catch {
    /* no body — fall through to header check */
  }
  if (!token) {
    token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  }
  if (token !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { resumed } = await resumeDueWaits(createServiceRoleClient());
    return NextResponse.json({ ok: true, resumed });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "tick failed" },
      { status: 500 },
    );
  }
}
