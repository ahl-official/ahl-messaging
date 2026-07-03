// GET  /api/lsq/push-failures        → list failed/pending/pushed pushes
// POST /api/lsq/push-failures { retry: true } → retry all pending NOW (ignores
//                                              the 2-min schedule)
//
// Powers the "Failed lead pushes" panel in CRM settings. Admin-only.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { processPushRetries } from "@/lib/lsq-push-failures";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("lsq_push_failures")
    .select("lead_number, prospect_id, phone, first_chat_number, fields, status, attempts, last_error, source, next_retry_at, updated_at, pushed_at")
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const s = (r.status as string) ?? "pending";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({ rows, counts });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { retry?: boolean };
  if (!body.retry) return NextResponse.json({ error: "Nothing to do" }, { status: 400 });

  const summary = await processPushRetries({ ignoreSchedule: true, limit: 200 });
  return NextResponse.json({ ok: true, ...summary });
}
