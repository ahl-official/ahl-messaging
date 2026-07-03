// GET /api/lsq/webhook-events?form=1&webhook_id=&limit=
//   Recent CRM webhook events with their FULL payloads. `form=1` filters to
//   form-submission events. Admin/owner only.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const formOnly = sp.get("form") === "1";
  const webhookId = sp.get("webhook_id")?.trim() || null;
  const limit = Math.min(Number(sp.get("limit")) || 100, 300);

  const admin = createServiceRoleClient();
  let q = admin
    .from("lsq_webhook_events")
    .select("id, webhook_name, received_at, notable_event, activity, prospect_id, prospect_auto_id, phone, stage, source, payload")
    .order("received_at", { ascending: false })
    .limit(limit);
  if (webhookId) q = q.eq("webhook_id", webhookId);
  if (formOnly) q = q.or("notable_event.ilike.%form submission%,activity.ilike.%form submission%");

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message, rows: [] }, { status: 200 });
  return NextResponse.json({ rows: data ?? [] });
}
