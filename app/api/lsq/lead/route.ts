// GET /api/lsq/lead?mobile=<wa_id>[&crm=secondary]
//
// Looks up a CRM lead by the contact's WhatsApp number and
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

  // Mirror stage + owner (+ assigned_to) onto matching contact rows so
  // the inbox doesn't stay Unassigned until a manual refresh. PRIMARY
  // ONLY — secondary CRM must not clobber the cache.
  if (!isSecondary && result.found && result.lead) {
    try {
      const admin = createServiceRoleClient();
      const { data: rows } = await admin
        .from("contacts")
        .select("id")
        .eq("wa_id", mobile);
      const { mirrorLsqLeadOntoContact } = await import(
        "@/lib/lsq-contact-mirror"
      );
      for (const row of rows ?? []) {
        await mirrorLsqLeadOntoContact(admin, row.id as string, result.lead!, {
          fillNameIfEmpty: false,
        });
        // Keep FirstName sync even when local name already set (panel open).
        const lsqFirst = (result.lead.first_name ?? "").trim();
        if (lsqFirst) {
          await admin
            .from("contacts")
            .update({ name: lsqFirst })
            .eq("id", row.id as string)
            .neq("name", lsqFirst);
        }
      }
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
