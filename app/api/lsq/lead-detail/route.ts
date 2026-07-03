// GET /api/lsq/lead-detail?lead=<ProspectAutoId>  (or ?prospect=<ProspectID>)
//   → the full CRM lead for the side panel: all fields + the activity
//     timeline (calls, notes, source changes, WhatsApp …). Mirrors the
//     CRM lead page (Leads Details + Activity History tabs). Notes
//     and Call tabs are derived from the same activity list on the client.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getLsqConfig, lsqGetLeadById, lsqGetLeadByLeadNumber, lsqGetLeadActivities } from "@/lib/lsq";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cfg = getLsqConfig();
  if (!cfg.configured) return NextResponse.json({ error: "CRM not configured" }, { status: 400 });

  const lead = request.nextUrl.searchParams.get("lead")?.trim();
  let prospectId = request.nextUrl.searchParams.get("prospect")?.trim() || "";

  if (!prospectId && lead) {
    const found = await lsqGetLeadByLeadNumber(lead, cfg);
    if (!found.ok) return NextResponse.json({ error: found.error ?? "LSQ lookup failed" }, { status: 502 });
    if (!found.found || !found.lead?.prospect_id) return NextResponse.json({ error: "Lead not found in LSQ" }, { status: 404 });
    prospectId = found.lead.prospect_id;
  }
  if (!prospectId) return NextResponse.json({ error: "lead or prospect required" }, { status: 400 });

  // Preferred language comes from OUR DB (set by the bot), not LSQ — it's the
  // source of truth for which language the bot replies in.
  const admin = createServiceRoleClient();
  let q = admin.from("contacts").select("preferred_language").limit(1);
  q = lead ? q.eq("lsq_lead_number", lead) : q.eq("lsq_prospect_id", prospectId);
  const { data: contactRow } = await q.maybeSingle();

  const [byId, acts] = await Promise.all([
    lsqGetLeadById(prospectId, cfg),
    lsqGetLeadActivities(prospectId, 100, cfg),
  ]);

  return NextResponse.json({
    prospect_id: prospectId,
    fields: byId.ok ? byId.fields : {},
    fields_error: byId.ok ? null : byId.error,
    activities: acts.ok ? acts.activities : [],
    activities_error: acts.ok ? null : acts.error,
    preferred_language: contactRow?.preferred_language ?? null,
  });
}
