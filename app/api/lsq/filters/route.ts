// GET /api/lsq/filters?business_phone_number_id=...
//
// Surface distinct lsq_stage values, owner names, and the contact-count
// per stage so the campaign-create UI can render a multi-select with
// counts ("Prospect · 412", "Photo Received · 87") instead of a free
// text field. Cheap aggregate over public.contacts; no LSQ API hit.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface ContactRow {
  lsq_stage: string | null;
  lsq_owner_name: string | null;
  created_at: string | null;
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const bpid = request.nextUrl.searchParams.get("business_phone_number_id")?.trim();
  const admin = createServiceRoleClient();
  let q = admin
    .from("contacts")
    .select("lsq_stage, lsq_owner_name, created_at")
    .limit(20000);
  if (bpid) q = q.eq("business_phone_number_id", bpid);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stageCounts = new Map<string, number>();
  const ownerCounts = new Map<string, number>();
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const r of (data ?? []) as ContactRow[]) {
    if (r.lsq_stage) stageCounts.set(r.lsq_stage, (stageCounts.get(r.lsq_stage) ?? 0) + 1);
    if (r.lsq_owner_name) ownerCounts.set(r.lsq_owner_name, (ownerCounts.get(r.lsq_owner_name) ?? 0) + 1);
    if (r.created_at) {
      if (!oldest || r.created_at < oldest) oldest = r.created_at;
      if (!newest || r.created_at > newest) newest = r.created_at;
    }
  }

  // Sort by count desc — most-populous stages render first.
  const stages = Array.from(stageCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([stage, count]) => ({ stage, count }));
  const owners = Array.from(ownerCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([owner, count]) => ({ owner, count }));

  return NextResponse.json({
    total_contacts: data?.length ?? 0,
    stages,
    owners,
    created_at_range: { oldest, newest },
  });
}
