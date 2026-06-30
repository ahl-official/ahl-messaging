// GET /api/lead-distribution/events — recent webhook events (executions log).
// Reads lead_distribution_pending (every webhook lead lands there) and pulls
// out name / stage from the raw payload for display.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  // Denormalised columns only — never the heavy `lead` jsonb (kept the list
  // fast). The click-to-expand detail fetches full LSQ fields on demand.
  const { data, error } = await admin
    .from("lead_distribution_pending")
    .select("id, created_at, mobile, region, status, assigned_agent, prospect_id, brand, stage, lead_name, owner_email, lead_number")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const events = (data ?? []).map((r) => ({
    id: r.id as string,
    created_at: r.created_at as string,
    mobile: r.mobile as string | null,
    region: r.region as string | null,
    status: r.status as string,
    assigned_agent: r.assigned_agent as string | null,
    name: r.lead_name as string | null,
    stage: r.stage as string | null,
    lead_number: r.lead_number as string | null,
    owner_email: r.owner_email as string | null,
    owner_name: null as string | null,
    prospect_id: r.prospect_id as string | null,
    brand: (r.brand as string | null) ?? null,
  }));
  return NextResponse.json({ events });
}
