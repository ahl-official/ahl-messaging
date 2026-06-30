// GET    /api/triggers/[id]  — flow + ordered steps
// PATCH  /api/triggers/[id]  — update flow fields + replace steps
// DELETE /api/triggers/[id]

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { insertSteps, saveGraph, type GraphInput } from "@/lib/trigger-store";

export const runtime = "nodejs";

async function adminGuard() {
  const me = await getCurrentMember();
  if (!me) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!isAtLeast(me.role, "admin"))
    return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { me };
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const g = await adminGuard();
  if (g.error) return g.error;
  const admin = createServiceRoleClient();
  const { data: flow } = await admin.from("trigger_flows").select("*").eq("id", params.id).maybeSingle();
  if (!flow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: nodes } = await admin
    .from("trigger_nodes")
    .select("id, node_type, config, position, sort_order")
    .eq("flow_id", params.id)
    .order("sort_order", { ascending: true });
  const { data: edges } = await admin
    .from("trigger_edges")
    .select("id, from_node_id, to_node_id, branch_label")
    .eq("flow_id", params.id);
  return NextResponse.json({ flow, steps: nodes ?? [], nodes: nodes ?? [], edges: edges ?? [] });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const g = await adminGuard();
  if (g.error) return g.error;

  let body: {
    name?: string;
    enabled?: boolean;
    trigger_type?: string;
    trigger_config?: Record<string, unknown>;
    priority?: number;
    steps?: Array<{ node_type: string; config?: Record<string, unknown> }>;
    graph?: GraphInput;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.trigger_type === "string") patch.trigger_type = body.trigger_type;
  if (body.trigger_config && typeof body.trigger_config === "object") patch.trigger_config = body.trigger_config;
  if (typeof body.priority === "number") patch.priority = body.priority;
  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from("trigger_flows").update(patch).eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Replace-all graph (canvas) takes precedence; else linear steps.
  if (body.graph) {
    await saveGraph(admin, params.id, body.graph);
  } else if (Array.isArray(body.steps)) {
    await admin.from("trigger_nodes").delete().eq("flow_id", params.id);
    await insertSteps(admin, params.id, body.steps);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const g = await adminGuard();
  if (g.error) return g.error;
  const admin = createServiceRoleClient();
  const { error } = await admin.from("trigger_flows").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
