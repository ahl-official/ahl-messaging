// GET    /api/lead-distribution/automations          — list tracked automations
// POST   /api/lead-distribution/automations          — add one { name, trigger_type, note? }
// DELETE /api/lead-distribution/automations?id=<id>   — remove one
//
// A local registry of the LSQ automations wired to the distribution
// webhook. LSQ doesn't expose its automation list, so the operator tracks
// them here (mirrors LSQ's Automation screen in the Lead automations tab).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

const TABLE = "lead_distribution_automations";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from(TABLE)
    .select("id, name, trigger_type, scope, status, note, config, created_by, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ automations: data ?? [] });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  let body: { name?: string; trigger_type?: string; note?: string; status?: string; scope?: string; config?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from(TABLE)
    .insert({
      name,
      trigger_type: String(body.trigger_type ?? "New Lead").trim() || "New Lead",
      scope: String(body.scope ?? "Global").trim() || "Global",
      status: String(body.status ?? "Draft").trim() || "Draft",
      note: body.note ? String(body.note).trim() : null,
      config: body.config && typeof body.config === "object" ? body.config : {},
      created_by: me.email ?? null,
    })
    .select("id, name, trigger_type, scope, status, note, config, created_by, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ automation: data });
}

export async function PATCH(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  let body: { name?: string; status?: string; scope?: string; config?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.status === "string" && body.status.trim()) patch.status = body.status.trim();
  if (typeof body.scope === "string" && body.scope.trim()) patch.scope = body.scope.trim();
  if (body.config && typeof body.config === "object") patch.config = body.config;
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .select("id, name, trigger_type, scope, status, note, config, created_by, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ automation: data });
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
