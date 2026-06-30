// GET /api/lsq/lookup?q=<phone | lead number>
//
// Cross-CRM lead lookup for the inbox search. Resolves the query to a
// phone number — either it already is one, or it's a lead number we
// map back to a contact's WhatsApp number via the cached
// `lsq_lead_number` — then probes BOTH LeadSquared accounts and returns
// each one's lead (or a miss). Powers the "CRM Lookup" modal.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  getLsqConfig,
  getLsqConfig2,
  lsqGetLeadByLeadNumber,
  lsqGetLeadByMobile,
} from "@/lib/lsq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function lookupOne(
  waId: string,
  cfg: ReturnType<typeof getLsqConfig>,
) {
  if (!cfg.configured) {
    return { label: cfg.label, configured: false, found: false, lead: null };
  }
  const res = await lsqGetLeadByMobile(waId, cfg);
  return {
    label: cfg.label,
    configured: true,
    found: res.found,
    lead: res.lead,
    error: res.ok ? null : res.error,
  };
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

  const digits = q.replace(/\D/g, "");
  if (digits.length < 4) {
    return NextResponse.json({ resolved: false, query: q });
  }

  // ≥10 digits → treat as a phone number directly. Shorter → treat as
  // a lead number and try to resolve it to a wa_id, in this order:
  //   1. our local `contacts.lsq_lead_number` cache (fast path)
  //   2. LSQ direct search by ProspectAutoId (covers leads that the
  //      operator never chatted with — without this the modal told them
  //      "search a lead number that exists in a synced contact", which
  //      defeats the point of pulling phone-less leads INTO chat)
  let waId: string | null = null;
  let resolvedFrom: "phone" | "lead_number" = "phone";
  if (digits.length >= 10) {
    waId = digits;
  } else {
    resolvedFrom = "lead_number";
    const admin = createServiceRoleClient();
    const { data } = await admin
      .from("contacts")
      .select("wa_id")
      .eq("lsq_lead_number", digits)
      .limit(1)
      .maybeSingle();
    waId = (data?.wa_id as string | undefined) ?? null;

    // Fall back to a direct LSQ lookup if we don't have a cached row.
    // Probes both CRMs in parallel; first match wins.
    if (!waId) {
      const [p, s] = await Promise.all([
        lsqGetLeadByLeadNumber(digits, getLsqConfig()),
        lsqGetLeadByLeadNumber(digits, getLsqConfig2()),
      ]);
      const hit = (p.found && p.lead) || (s.found && s.lead) || null;
      const phone = hit?.phone?.replace(/\D/g, "") ?? null;
      if (phone) waId = phone;
    }
  }

  if (!waId) {
    return NextResponse.json({ resolved: false, query: q, resolvedFrom });
  }

  const [primary, secondary] = await Promise.all([
    lookupOne(waId, getLsqConfig()),
    lookupOne(waId, getLsqConfig2()),
  ]);

  return NextResponse.json(
    { resolved: true, query: q, resolvedFrom, wa_id: waId, primary, secondary },
    { headers: { "Cache-Control": "no-store" } },
  );
}
