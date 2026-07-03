// GET    /api/lead-distribution/agents          — list agents (haridwar_sales_agents)
// POST   /api/lead-distribution/agents          — add an agent
// PATCH  /api/lead-distribution/agents?id=<lsq_id>  — edit an agent
// DELETE /api/lead-distribution/agents?id=<lsq_id>  — remove an agent

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

const TABLE = "haridwar_sales_agents";

type AgentInput = {
  agent_name?: string;
  agent_email?: string;
  priority?: string | number;
  daily_cap?: number;
  week_off?: string | null;
  is_active?: boolean;
  international_lead?: string | null;
  lsq_id?: string;
};

function clean(body: AgentInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.agent_name !== undefined) out.agent_name = String(body.agent_name).trim();
  if (body.agent_email !== undefined) out.agent_email = String(body.agent_email).trim();
  if (body.priority !== undefined) out.priority = String(body.priority).trim();
  if (body.daily_cap !== undefined) out.daily_cap = Math.max(0, Math.round(Number(body.daily_cap) || 0));
  if (body.week_off !== undefined) out.week_off = body.week_off ? String(body.week_off).trim() : null;
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  if (body.international_lead !== undefined) {
    out.international_lead = body.international_lead ? String(body.international_lead).trim() : null;
  }
  return out;
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const [{ data, error }, { data: pending }] = await Promise.all([
    admin.from(TABLE).select("*").limit(500),
    admin.from("lead_distribution_pending").select("lead").limit(5000),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // All-time leads per agent = webhook leads whose current LSQ owner email
  // matches the agent. (leads_today is the daily counter; this is the total.)
  const totalByEmail = new Map<string, number>();
  for (const r of pending ?? []) {
    const payload = (r.lead ?? {}) as Record<string, unknown>;
    const ld = (payload.After ?? payload.body ?? payload) as Record<string, unknown>;
    const email = String(ld.OwnerIdEmailAddress ?? "").trim().toLowerCase();
    if (email) totalByEmail.set(email, (totalByEmail.get(email) ?? 0) + 1);
  }

  // Sort by numeric priority then name (priority is stored as text).
  const agents = (data ?? [])
    .map((a) => ({ ...a, assigned_total: totalByEmail.get(String(a.agent_email ?? "").trim().toLowerCase()) ?? 0 }))
    .sort((a, b) => {
      const pa = parseInt(String(a.priority ?? "999"), 10) || 999;
      const pb = parseInt(String(b.priority ?? "999"), 10) || 999;
      if (pa !== pb) return pa - pb;
      return String(a.agent_name ?? "").localeCompare(String(b.agent_name ?? ""));
    });
  return NextResponse.json({ agents });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  let body: AgentInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const fields = clean(body);
  if (!fields.agent_name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (!fields.agent_email) return NextResponse.json({ error: "Email required" }, { status: 400 });
  // lsq_id is the PK. Use the supplied CRM user id, else a placeholder uuid
  // (operator can paste the real LSQ id later).
  fields.lsq_id = (body.lsq_id ?? "").trim() || randomUUID();
  const admin = createServiceRoleClient();
  const { data, error } = await admin.from(TABLE).insert(fields).select("*").single();
  if (error) {
    const msg = error.code === "23505" ? "Is email / id ka agent already hai" : error.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ agent: data });
}

export async function PATCH(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id (lsq_id) required" }, { status: 400 });
  let body: AgentInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  const { data, error } = await admin.from(TABLE).update(clean(body)).eq("lsq_id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ agent: data });
}

export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id (lsq_id) required" }, { status: 400 });
  const admin = createServiceRoleClient();
  const { error } = await admin.from(TABLE).delete().eq("lsq_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
