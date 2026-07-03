// GET    /api/lead-distribution/groups          — list stage groups
// POST   /api/lead-distribution/groups          — create a group
// PATCH  /api/lead-distribution/groups?id=<id>  — update a group
// DELETE /api/lead-distribution/groups?id=<id>  — delete a group
//
// A group maps CRM stages → agents (haridwar_sales_agents.lsq_id) so a
// stage's leads route only to that group's agents.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

const TABLE = "lead_distribution_groups";

type GroupInput = {
  name?: string;
  stages?: unknown;
  agent_ids?: unknown;
  brands?: unknown;
  enabled?: boolean;
  priority?: number;
  working_start?: string;
  working_end?: string;
};

function clean(body: GroupInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined) out.name = String(body.name).trim() || "Stage group";
  if (Array.isArray(body.stages)) out.stages = body.stages.map((s) => String(s).trim()).filter(Boolean);
  if (Array.isArray(body.agent_ids)) out.agent_ids = body.agent_ids.map((s) => String(s).trim()).filter(Boolean);
  if (Array.isArray(body.brands)) out.brands = body.brands.map((s) => String(s).trim()).filter(Boolean);
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  if (body.priority !== undefined) out.priority = Math.max(0, Math.round(Number(body.priority) || 0));
  if (typeof body.working_start === "string") out.working_start = body.working_start.trim() || "10:00";
  if (typeof body.working_end === "string") out.working_end = body.working_end.trim() || "18:30";
  return out;
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const { data, error } = await admin.from(TABLE).select("*").order("priority", { ascending: true }).limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ groups: data ?? [] });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  let body: GroupInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  const { data, error } = await admin.from(TABLE).insert(clean(body)).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ group: data });
}

export async function PATCH(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  let body: GroupInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from(TABLE)
    .update({ ...clean(body), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ group: data });
}

export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const admin = createServiceRoleClient();
  const { error } = await admin.from(TABLE).delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
