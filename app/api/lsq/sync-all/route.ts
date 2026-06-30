// POST /api/lsq/sync-all
//
// One-shot backfill: walks every contact, fetches the matching LSQ lead,
// mirrors stage / lead number / owner onto the contact row. Used the
// first time after the LSQ integration is wired up so the contact list
// gets stage badges populated immediately, without waiting for each
// chat to be opened individually.
//
// Owner-only. Sequential (not parallel) to stay polite with LSQ rate
// limits — a few hundred contacts run in well under a minute and this
// is a manual one-off operation, not a hot path.

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getLsqConfig, lsqGetLeadByMobile } from "@/lib/lsq";

export const runtime = "nodejs";
// LSQ probes can take a few seconds each; allow a longer window than the
// default 10s for the full walk.
export const maxDuration = 300;

export async function POST() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "LSQ not configured" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("contacts")
    .select("id, wa_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<{ id: string; wa_id: string }>;
  const now = new Date().toISOString();
  let matched = 0;
  let unmatched = 0;
  const errors: Array<{ wa_id: string; error: string }> = [];

  for (const row of rows) {
    const result = await lsqGetLeadByMobile(row.wa_id);
    if (!result.ok) {
      errors.push({ wa_id: row.wa_id, error: result.error ?? "unknown" });
      continue;
    }
    if (!result.found || !result.lead) {
      unmatched++;
      // Stamp synced_at even on misses so the operator knows the row
      // was checked — distinguishes "not synced yet" from "synced, no
      // CRM match" downstream.
      await admin
        .from("contacts")
        .update({ lsq_synced_at: now })
        .eq("id", row.id);
      continue;
    }
    matched++;
    await admin
      .from("contacts")
      .update({
        lsq_stage: result.lead.status,
        lsq_lead_number: result.lead.lead_number,
        lsq_owner_name: result.lead.owner_name,
        lsq_owner_email: result.lead.owner_email,
        lsq_prospect_id: result.lead.prospect_id,
        lsq_source: result.lead.source,
        lsq_sub_source: result.lead.sub_source,
        utm_source: result.lead.source_medium,
        lsq_synced_at: now,
      })
      .eq("id", row.id);
  }

  return NextResponse.json({
    ok: true,
    total: rows.length,
    matched,
    unmatched,
    errors: errors.slice(0, 20),
  });
}
