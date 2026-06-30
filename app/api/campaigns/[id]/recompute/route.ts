// POST /api/campaigns/[id]/recompute
//
// Force-refresh the campaign-level aggregate counters (sent/delivered/
// read/replied/failed/unsubscribed) by re-aggregating campaign_recipients
// row statuses. Useful when:
//   • Webhook events landed on individual recipients but the campaign
//     aggregate was never updated (e.g. campaign already "completed" so
//     the worker tick stopped recomputing).
//   • Operator wants to manually sync after manually editing rows.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { recomputeCounters } from "@/lib/campaigns";
import { createServiceRoleClient } from "@/lib/supabase/server";

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
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await recomputeCounters(id);
  return NextResponse.json({ ok: true });
}
