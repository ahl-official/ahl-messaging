// GET /api/lsq/lead?mobile=<wa_id>[&crm=secondary]
//
// Looks up a LeadSquared lead by the contact's WhatsApp number and
// returns the dashboard-relevant fields. The contact-details panel
// calls this when a chat is opened, so the agent sees CRM context
// alongside the conversation.
//
// `crm=secondary` reads the second LSQ account (LSQ2_* env vars) —
// read-only: no mirroring, so the secondary CRM never overwrites the
// primary-sourced cache. Default / `crm=primary` hits the main account.
//
// Side effect (primary only): when a lead is found, we mirror the
// stage / lead number / owner / name into the local `contacts` row so
// the inbox renders without per-row API calls.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getLsqConfig, getLsqConfig2, lsqGetLeadByMobile } from "@/lib/lsq";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const mobile = request.nextUrl.searchParams.get("mobile")?.trim();
  if (!mobile) {
    return NextResponse.json({ error: "mobile is required" }, { status: 400 });
  }

  const crm = request.nextUrl.searchParams.get("crm")?.trim();
  const isSecondary = crm === "secondary" || crm === "2";
  const cfg = isSecondary ? getLsqConfig2() : getLsqConfig();

  if (!cfg.configured) {
    return NextResponse.json({
      configured: false,
      found: false,
      lead: null,
      crm: isSecondary ? "secondary" : "primary",
      label: cfg.label,
    });
  }

  const result = await lsqGetLeadByMobile(mobile, cfg);

  // Mirror the lead snapshot onto the local contact row so the inbox
  // can render the stage badge without per-row API calls. PRIMARY ONLY
  // — the secondary CRM is read-only and must not clobber the cache.
  if (!isSecondary && result.found && result.lead) {
    try {
      const admin = createServiceRoleClient();
      const update: Record<string, unknown> = {
        lsq_stage: result.lead.status,
        lsq_lead_number: result.lead.lead_number,
        lsq_owner_name: result.lead.owner_name,
        lsq_owner_email: result.lead.owner_email,
        lsq_prospect_id: result.lead.prospect_id,
        // Source fields for the CRM-style lead table (Lead Source / Sub
        // source / Source Medium). Read straight from the LSQ lead so the
        // table mirrors LeadSquared instead of showing blanks.
        lsq_source: result.lead.source,
        lsq_sub_source: result.lead.sub_source,
        utm_source: result.lead.source_medium,
        lsq_synced_at: new Date().toISOString(),
      };
      // Mirror LSQ.FirstName → contacts.name on every refresh so the
      // operator's manual rename in LSQ flows back to the inbox label
      // without a round-trip through the dashboard. We only write
      // when LSQ has a non-empty first_name and it differs from the
      // current local name (avoids redundant writes on every refetch).
      const lsqFirst = (result.lead.first_name ?? "").trim();
      if (lsqFirst) {
        const { data: existing } = await admin
          .from("contacts")
          .select("name")
          .eq("wa_id", mobile)
          .maybeSingle();
        if (!existing || (existing.name ?? "").trim() !== lsqFirst) {
          update.name = lsqFirst;
        }
      }
      await admin.from("contacts").update(update).eq("wa_id", mobile);
    } catch {
      // Non-fatal — column might not exist yet on a freshly migrated DB.
    }
  }

  return NextResponse.json({
    configured: true,
    ok: result.ok,
    found: result.found,
    lead: result.lead,
    error: result.error,
    matched_variant: result.matched_variant,
    crm: isSecondary ? "secondary" : "primary",
    label: cfg.label,
  });
}
