// GET /api/lead-distribution/lsq-assignment?from=&to=
//   → per-owner assignment from the WEBHOOK leads (lead_distribution_pending),
//     with a per-stage breakdown + the lead list (click-to-expand). Optional
//     [from, to) on the webhook event time (created_at). Only leads that
//     actually came through the distribution webhook are counted.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { lsqGetUsers } from "@/lib/lsq";

export const runtime = "nodejs";

interface LeadLite {
  name: string | null;
  stage: string | null;
  lead_number: string | null;
  mobile: string | null;
}

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();

  const from = request.nextUrl.searchParams.get("from")?.trim();
  const to = request.nextUrl.searchParams.get("to")?.trim();

  let q = admin
    .from("lead_distribution_pending")
    .select("created_at, mobile, prospect_id, stage, lead_name, owner_email, lead_number")
    .order("created_at", { ascending: false })
    .limit(10000);
  if (from) q = q.gte("created_at", from);
  if (to) q = q.lt("created_at", to);

  const [{ data: rows, error }, { data: agentRows }, usersRes] = await Promise.all([
    q,
    admin.from("haridwar_sales_agents").select("agent_email, agent_name"),
    lsqGetUsers().catch(() => ({ users: [] as { email: string | null; name: string }[] })),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve owner display names: our pool first, then every LSQ user.
  const nameByEmail = new Map<string, string>();
  const poolByEmail = new Set<string>();
  for (const u of usersRes.users ?? []) {
    const e = (u.email ?? "").trim().toLowerCase();
    if (e && u.name) nameByEmail.set(e, u.name);
  }
  for (const a of agentRows ?? []) {
    const e = (a.agent_email as string | null)?.trim().toLowerCase();
    if (e) {
      poolByEmail.add(e);
      if (a.agent_name) nameByEmail.set(e, a.agent_name as string);
    }
  }

  interface OwnerAgg {
    email: string;
    name: string;
    count: number;
    byStage: Record<string, number>;
    leads: LeadLite[];
    seen: Set<string>;
  }
  const byOwner = new Map<string, OwnerAgg>();
  let total = 0;
  let noOwner = 0;
  for (const r of rows ?? []) {
    const email = (r.owner_email as string | null)?.trim().toLowerCase() || null;
    const prospect = (r.prospect_id as string | null)?.trim() || (r.mobile as string | null)?.trim() || "";
    if (!email) {
      noOwner += 1;
      continue;
    }
    const row =
      byOwner.get(email) ??
      ({ email, name: nameByEmail.get(email) ?? email, count: 0, byStage: {}, leads: [], seen: new Set() } as OwnerAgg);
    // One row per lead per owner (latest event wins; rows come newest-first).
    if (prospect && row.seen.has(prospect)) {
      byOwner.set(email, row);
      continue;
    }
    if (prospect) row.seen.add(prospect);
    const stage = (r.stage as string | null)?.trim() || "Unknown";
    total += 1;
    row.count += 1;
    row.byStage[stage] = (row.byStage[stage] ?? 0) + 1;
    if (row.leads.length < 300) {
      row.leads.push({
        name: r.lead_name as string | null,
        stage,
        lead_number: r.lead_number as string | null,
        mobile: r.mobile as string | null,
      });
    }
    byOwner.set(email, row);
  }

  const owners = Array.from(byOwner.values())
    .map((o) => ({ email: o.email, name: o.name, count: o.count, byStage: o.byStage, leads: o.leads, in_pool: poolByEmail.has(o.email) }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    owners,
    total,
    no_owner: noOwner,
    distinct_owners: owners.length,
    in_pool_count: owners.filter((o) => o.in_pool).length,
  });
}
