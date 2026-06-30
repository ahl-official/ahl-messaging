// POST /api/cron/lsq-refresh
//
// Background job: incrementally refresh each LSQ-linked contact's cached lead
// data (lead number, stage, owner) from LeadSquared so the local cache — which
// powers lead-id / name search — stays current. Processes the STALEST batch
// each run (oldest lsq_synced_at first), then re-stamps lsq_synced_at so the
// cursor rolls forward across runs. Fired by the instrumentation heartbeat.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { getLsqConfig, getLsqConfig2, lsqGetLeadByMobile } from "@/lib/lsq";

export const runtime = "nodejs";
export const maxDuration = 120;

// Small batch — LSQ allows ~10 calls/5s and the lib rate-limits internally.
// Kept low so the background refresh barely competes with interactive lookups
// (which share the same per-account rate window).
const BATCH = 12;

export async function POST(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || (auth !== expected && body.token !== expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg1 = getLsqConfig();
  const cfg2 = getLsqConfig2();
  if (!cfg1.configured && !cfg2.configured) {
    return NextResponse.json({ ok: true, skipped: "lsq_not_configured" });
  }

  const admin = createServiceRoleClient();

  // Only contacts already linked to LSQ (have a prospect id). Brand-new
  // unsynced contacts are handled by the nightly ensure-lead pass. Stalest
  // first; never-refreshed (NULL) get priority.
  const { data: due } = await admin
    .from("contacts")
    .select("id, wa_id")
    .not("lsq_prospect_id", "is", null)
    .order("lsq_synced_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);

  const rows = due ?? [];
  let refreshed = 0;
  let missing = 0;
  let errors = 0;
  const now = new Date().toISOString();

  for (const c of rows) {
    const wa = (c.wa_id as string | null) ?? "";
    try {
      let r = await lsqGetLeadByMobile(wa, cfg1);
      if ((!r.ok || !r.found) && cfg2.configured) {
        const r2 = await lsqGetLeadByMobile(wa, cfg2);
        if (r2.found) r = r2;
      }
      const patch: Record<string, unknown> = { lsq_synced_at: now };
      if (r.found && r.lead) {
        patch.lsq_stage = r.lead.status;
        patch.lsq_lead_number = r.lead.lead_number;
        patch.lsq_owner_name = r.lead.owner_name;
        patch.lsq_owner_email = r.lead.owner_email?.trim().toLowerCase() ?? null;
        patch.lsq_prospect_id = r.lead.prospect_id;
        patch.lsq_source = r.lead.source;
        patch.lsq_sub_source = r.lead.sub_source;
        refreshed++;
      } else {
        missing++; // lead gone / not found — still stamp so the cursor moves on
      }
      await admin.from("contacts").update(patch).eq("id", c.id as string);
    } catch {
      errors++;
      await admin.from("contacts").update({ lsq_synced_at: now }).eq("id", c.id as string);
    }
  }

  return NextResponse.json({ ok: true, processed: rows.length, refreshed, missing, errors });
}
