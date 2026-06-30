// POST /api/campaigns/[id]/start
// Promote a draft to scheduled. The worker tick (instrumentation) will
// pick it up on the next pass — this endpoint never sends inline so a
// slow OpenAI / Cloud-API call doesn't tie up the operator's request.

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
    .select("id, status, total_recipients, schedule_at")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (campaign.status !== "draft") {
    return NextResponse.json(
      { error: `Cannot start a ${campaign.status} campaign.` },
      { status: 400 },
    );
  }
  if ((campaign.total_recipients ?? 0) === 0) {
    return NextResponse.json(
      { error: "Add recipients before starting." },
      { status: 400 },
    );
  }

  await admin
    .from("campaigns")
    .update({ status: "scheduled" })
    .eq("id", id);
  return NextResponse.json({ ok: true });
}
