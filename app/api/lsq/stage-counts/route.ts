// GET /api/lsq/stage-counts
//
// Live contact-count per LSQ stage, for the inbox stage-filter strip.
// Scoped to the caller's allowed numbers (owner sees everything) so a
// teammate's funnel reflects only what they can open. Paginates past
// the PostgREST 1000-row cap so the totals are real.

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getCurrentEffectivePermissions } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ctx = await getCurrentEffectivePermissions();
  let allowedBpids: string[] | null = null;
  if (ctx && ctx.member.role !== "owner") {
    allowedBpids = ctx.perms.allowed_number_ids;
  }
  // Empty allow-list = explicit deny.
  if (allowedBpids !== null && allowedBpids.length === 0) {
    return NextResponse.json(
      { counts: {}, total: 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Numbers the operator has toggled off in the UserMenu — the strip
  // must mirror the inbox, so a hidden number's leads don't count.
  const hiddenIds = ctx?.member.hidden_number_ids ?? [];

  // One GROUP BY via the get_stage_counts RPC (0081) instead of paginating
  // the whole contacts table in JS — at 135k+ rows the old loop was ~136
  // sequential round-trips every 30s. allowed_bpids null = owner.
  const { data, error } = await supabase.rpc("get_stage_counts", {
    allowed_bpids: allowedBpids,
    hidden_bpids: hiddenIds,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of (data ?? []) as Array<{
    lsq_stage: string | null;
    cnt: number;
  }>) {
    const n = Number(row.cnt) || 0;
    total += n;
    const s = (row.lsq_stage ?? "").trim();
    if (s) counts[s] = n;
  }

  return NextResponse.json(
    { counts, total },
    { headers: { "Cache-Control": "no-store" } },
  );
}
