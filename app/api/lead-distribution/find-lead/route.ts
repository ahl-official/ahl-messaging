// GET /api/lead-distribution/find-lead?q=<phone | lead number | name>
//   → find leads (contacts) by phone / LSQ lead number / name and show who
//     they're currently assigned to in LSQ. Backs the lead search on the
//     LSQ assignment tab.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 3) return NextResponse.json({ leads: [] });

  const admin = createServiceRoleClient();
  const digits = q.replace(/\D/g, "");
  const ors: string[] = [`lsq_lead_number.ilike.%${q}%`, `name.ilike.%${q}%`];
  if (digits.length >= 4) ors.push(`wa_id.ilike.%${digits}%`);

  const { data, error } = await admin
    .from("contacts")
    .select("name, profile_name, wa_id, lsq_stage, lsq_lead_number, lsq_owner_email, lsq_owner_name")
    .or(ors.join(","))
    .limit(25);
  if (error) return NextResponse.json({ error: error.message, leads: [] }, { status: 500 });

  const leads = (data ?? []).map((c) => ({
    name: (c.name as string | null) || (c.profile_name as string | null) || null,
    mobile: (c.wa_id as string | null) ?? null,
    lead_number: (c.lsq_lead_number as string | null) ?? null,
    stage: (c.lsq_stage as string | null) ?? null,
    owner_email: (c.lsq_owner_email as string | null) ?? null,
    owner_name: (c.lsq_owner_name as string | null) ?? null,
  }));
  return NextResponse.json({ leads });
}
