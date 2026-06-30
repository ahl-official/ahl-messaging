// GET  /api/triggers[?phone_number_id=]  — list trigger flows (+ node count)
// POST /api/triggers                      — create a flow with linear steps
//
// Phase 1: flows are a keyword trigger + an ordered list of action steps.
// Branching (condition edges / canvas) comes in Phase 2 over the same tables.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { insertSteps, saveGraph, type GraphInput, type StepInput } from "@/lib/trigger-store";

export const runtime = "nodejs";

interface FlowInput {
  business_phone_number_id?: string;
  name?: string;
  enabled?: boolean;
  trigger_type?: "keyword" | "template_reply" | "new_contact" | "first_message" | "schedule" | "webhook";
  trigger_config?: Record<string, unknown>;
  priority?: number;
  steps?: StepInput[];
  graph?: GraphInput;
}

async function adminGuard() {
  const me = await getCurrentMember();
  if (!me) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!isAtLeast(me.role, "admin"))
    return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { me };
}

export async function GET(request: NextRequest) {
  const g = await adminGuard();
  if (g.error) return g.error;

  const bpid = request.nextUrl.searchParams.get("phone_number_id")?.trim() || null;
  const admin = createServiceRoleClient();
  let q = admin
    .from("trigger_flows")
    .select("id, business_phone_number_id, name, enabled, trigger_type, trigger_config, priority, created_at")
    .order("priority", { ascending: true });
  if (bpid) q = q.eq("business_phone_number_id", bpid);
  const { data: flows, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Node count per flow for the list summary.
  const ids = (flows ?? []).map((f) => f.id);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: nodes } = await admin.from("trigger_nodes").select("flow_id").in("flow_id", ids);
    for (const n of nodes ?? []) counts.set(n.flow_id as string, (counts.get(n.flow_id as string) ?? 0) + 1);
  }
  return NextResponse.json({
    flows: (flows ?? []).map((f) => ({ ...f, step_count: counts.get(f.id) ?? 0 })),
  });
}

export async function POST(request: NextRequest) {
  const g = await adminGuard();
  if (g.error) return g.error;

  let body: FlowInput;
  try {
    body = (await request.json()) as FlowInput;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const bpid = body.business_phone_number_id?.trim();
  const name = body.name?.trim();
  if (!bpid) return NextResponse.json({ error: "business_phone_number_id required" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: flow, error: flowErr } = await admin
    .from("trigger_flows")
    .insert({
      business_phone_number_id: bpid,
      name,
      enabled: body.enabled ?? false,
      trigger_type: body.trigger_type ?? "keyword",
      trigger_config: body.trigger_config ?? {},
      priority: body.priority ?? 100,
      created_by: g.me!.user_id,
    })
    .select("id")
    .single();
  if (flowErr || !flow) {
    return NextResponse.json({ error: flowErr?.message ?? "create failed" }, { status: 500 });
  }

  if (body.graph) await saveGraph(admin, flow.id, body.graph);
  else await insertSteps(admin, flow.id, body.steps ?? []);
  return NextResponse.json({ ok: true, id: flow.id });
}
