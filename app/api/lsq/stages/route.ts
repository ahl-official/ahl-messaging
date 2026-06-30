// GET /api/lsq/stages
//
// Returns every LSQ stage that actually has at least one contact in
// our local DB — derived from contacts.lsq_stage which is cached at
// per-contact LSQ-lookup time. This is more reliable than calling
// LSQ's ProspectStages.Get master endpoint (some tenants return 404)
// and only surfaces stages that operators are actively using.
//
// Falls back to a hardcoded list when the DB has no cached stages yet
// (fresh install). Server-cached (5 min) so the dashboard doesn't run
// a DISTINCT every tab open.

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ALL_LEAD_STAGES } from "@/lib/lead-stages";

export const runtime = "nodejs";
// 5-minute cache. Stages don't churn often.
export const revalidate = 300;

/** The full canonical funnel — every stage shows in the strip even when no
 *  contact currently sits in it. Any LSQ-only stage that DOES have contacts
 *  but isn't here gets appended below. */
const FALLBACK_STAGES = ALL_LEAD_STAGES;

export async function GET() {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createServiceRoleClient();

  // Pull every distinct lsq_stage cached on contacts. We also include
  // the count per stage so we can sort by usage (busiest stage first)
  // when the operator hasn't pinned an explicit funnel order.
  //
  // Supabase JS doesn't support GROUP BY directly — fall back to RPC
  // or a window-function rpc. Here we just SELECT the column and
  // count in JS; the contacts table has < 100k rows in practice so
  // the scan is fine. (Switch to a Postgres view / RPC if it grows.)
  const { data, error } = await admin
    .from("contacts")
    .select("lsq_stage")
    .not("lsq_stage", "is", null);

  if (error) {
    return NextResponse.json({
      stages: FALLBACK_STAGES,
      source: "fallback",
      reason: `db_error: ${error.message}`,
    });
  }

  // Counts → sort hot stages first. Operators usually want the most-
  // populated buckets up front. Ties broken alphabetically so the
  // order is stable across renders.
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ lsq_stage: string | null }>) {
    const s = (row.lsq_stage ?? "").toString().trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return NextResponse.json({
      stages: FALLBACK_STAGES,
      source: "fallback",
      reason: "no_cached_stages_yet",
    });
  }

  // EVERY canonical stage shows, in funnel order, even with zero contacts —
  // operators want the whole funnel visible, not just the populated buckets.
  // Any LSQ-only stage that has contacts but isn't canonical is appended,
  // sorted by contact count (busiest first), then alphabetically.
  const known = new Set<string>(FALLBACK_STAGES);
  const inOrder: string[] = [...FALLBACK_STAGES];
  const extras = Array.from(counts.keys())
    .filter((s) => !known.has(s))
    .sort((a, b) => {
      const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
      return diff !== 0 ? diff : a.localeCompare(b);
    });
  const stages = [...inOrder, ...extras];

  return NextResponse.json({
    stages,
    source: "db",
    counts: Object.fromEntries(counts),
  });
}
