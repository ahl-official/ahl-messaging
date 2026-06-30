// GET /api/lead-distribution/report
//   → per-agent assigned-lead counts, broken down by LSQ stage.
//
// Source: lead_distribution_pending — every webhook lead lands there with
// its assigned_agent (once the engine assigns it) and the raw lead payload
// (stage). We aggregate in-process: rows = agents, columns = stages.

import { NextResponse, type NextRequest } from "next/server";
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

// Region/language classification (same country-code lists as the engine).
const HINDI_PT = ["977", "880", "971", "966", "968", "94", "95", "98", "93", "62", "60", "7"];
const ENGLISH_PT = ["61", "64", "34", "39", "41", "44", "90", "46", "45", "47", "63", "65", "81", "66", "27", "55", "1"];
function regionOf(raw: string): "National" | "Hindi International" | "English International" {
  const d = (raw || "").replace(/\D/g, "");
  if (!d || d.length <= 10 || d.startsWith("91")) return "National";
  for (const c of HINDI_PT) if (d.startsWith(c)) return "Hindi International";
  for (const c of ENGLISH_PT) if (d.startsWith(c)) return "English International";
  return "National";
}

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();

  const brandFilter = request.nextUrl.searchParams.get("brand")?.trim().toLowerCase() || null;

  let q = admin
    .from("lead_distribution_pending")
    .select("assigned_agent, status, mobile, brand, lead")
    .order("created_at", { ascending: false })
    .limit(8000);
  if (brandFilter) q = q.ilike("brand", brandFilter);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stageSet = new Set<string>();
  // agent → { total, byStage, byRegion }
  const byAgent = new Map<string, { agent: string; total: number; byStage: Record<string, number>; byRegion: Record<string, number> }>();
  // Pending counted PER STAGE — we only report pending for the stages that are
  // actually being distributed (those that have assignments), so unrelated
  // stages' pending leads don't inflate the number.
  const pendingByStage: Record<string, number> = {};
  const byRegion = { National: 0, "Hindi International": 0, "English International": 0 };

  for (const r of data ?? []) {
    const payload = (r.lead ?? {}) as Record<string, unknown>;
    const lead = (payload.After ?? payload.body ?? payload) as Record<string, unknown>;
    const stage = pick(lead, ["ProspectStage", "Stage"]) ?? "Unknown";
    const agent = (r.assigned_agent as string | null)?.trim();

    if (!agent || r.status !== "assigned") {
      if (r.status !== "assigned") pendingByStage[stage] = (pendingByStage[stage] ?? 0) + 1;
      continue;
    }
    const region = regionOf(String(r.mobile ?? pick(lead, ["Phone", "Mobile"]) ?? ""));
    byRegion[region] += 1;
    stageSet.add(stage);
    const row = byAgent.get(agent) ?? { agent, total: 0, byStage: {}, byRegion: {} };
    row.total += 1;
    row.byStage[stage] = (row.byStage[stage] ?? 0) + 1;
    row.byRegion[region] = (row.byRegion[region] ?? 0) + 1;
    byAgent.set(agent, row);
  }

  const stages = Array.from(stageSet).sort();
  const agents = Array.from(byAgent.values()).sort((a, b) => b.total - a.total);
  const grandTotal = agents.reduce((s, a) => s + a.total, 0);
  // Only pending of the distributed stages (e.g. Photos Received), not every
  // other stage sitting in the queue.
  const pending = stages.reduce((s, st) => s + (pendingByStage[st] ?? 0), 0);

  return NextResponse.json({ stages, agents, grandTotal, pending, byRegion });
}
