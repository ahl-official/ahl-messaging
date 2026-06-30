// POST /api/campaigns/[id]/retry-failed
// Requeue this campaign's failed recipients: reset them to 'pending' (clearing
// the prior error) and flip the campaign back to 'sending' so the worker tick
// re-dispatches them. Used after a fix (e.g. Interakt routing) so previously
// failed sends can go out without rebuilding the campaign.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  const admin = createServiceRoleClient();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Requeue both failed AND skipped rows. A genuine send-once skip (the
  // person already RECEIVED this template) gets re-skipped on the next tick,
  // so resetting it is safe — only rows that can actually send will send.
  const { data: reset, error } = await admin
    .from("campaign_recipients")
    .update({ status: "pending", failed_reason: null, error_code: null })
    .eq("campaign_id", id)
    .in("status", ["failed", "skipped"])
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const count = reset?.length ?? 0;
  // Re-open the campaign so the tick picks the requeued rows up.
  if (count > 0 && campaign.status !== "sending") {
    await admin.from("campaigns").update({ status: "sending" }).eq("id", id);
  }
  return NextResponse.json({ ok: true, requeued: count });
}
