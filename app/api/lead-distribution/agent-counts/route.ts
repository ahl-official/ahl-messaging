// GET /api/lead-distribution/agent-counts
//   → per-agent (owner email) lead counts bucketed by IST day, so the Sales
//     agents table can filter counts by day / month / year. The client picks
//     a period and sums the matching days.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Kolkata",
});

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();

  const { data, error } = await admin
    .from("lead_distribution_pending")
    .select("lead, created_at")
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // email → day ("YYYY-MM-DD") → stage → count
  const counts: Record<string, Record<string, Record<string, number>>> = {};
  const stages = new Set<string>();
  for (const r of data ?? []) {
    const payload = (r.lead ?? {}) as Record<string, unknown>;
    const ld = (payload.After ?? payload.body ?? payload) as Record<string, unknown>;
    const email = String(ld.OwnerIdEmailAddress ?? "").trim().toLowerCase();
    if (!email) continue;
    const day = IST_DAY.format(new Date(r.created_at as string));
    const stage = String(ld.ProspectStage ?? ld.Stage ?? "Unknown").trim() || "Unknown";
    stages.add(stage);
    const byDay = (counts[email] ??= {});
    const byStage = (byDay[day] ??= {});
    byStage[stage] = (byStage[stage] ?? 0) + 1;
  }

  return NextResponse.json({ counts, stages: Array.from(stages).sort() });
}
