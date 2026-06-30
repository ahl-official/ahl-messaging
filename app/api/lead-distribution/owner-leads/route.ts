// GET /api/lead-distribution/owner-leads?email=<owner>&stage=<stage>
//   → the actual contacts owned by an LSQ owner (optionally filtered to one
//     stage) — backs the click-to-expand lead list on the LSQ assignment tab.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const email = request.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const stage = request.nextUrl.searchParams.get("stage")?.trim();

  const from = request.nextUrl.searchParams.get("from")?.trim();
  const to = request.nextUrl.searchParams.get("to")?.trim();

  const admin = createServiceRoleClient();
  let q = admin
    .from("contacts")
    .select("name, profile_name, wa_id, lsq_stage, lsq_lead_number")
    .ilike("lsq_owner_email", email)
    .order("last_message_at", { ascending: false })
    .limit(300);
  if (stage) q = q.eq("lsq_stage", stage);
  if (from) q = q.gte("created_at", from);
  if (to) q = q.lt("created_at", to);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const leads = (data ?? []).map((c) => ({
    name: (c.name as string | null) || (c.profile_name as string | null) || null,
    stage: (c.lsq_stage as string | null) ?? null,
    mobile: (c.wa_id as string | null) ?? null,
    lead_number: (c.lsq_lead_number as string | null) ?? null,
  }));
  return NextResponse.json({ leads });
}
