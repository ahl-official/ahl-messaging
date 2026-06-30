// GET    /api/drips/[id]   — drip + its steps (for the editor)
// PATCH  /api/drips/[id]   — enable/disable, OR full edit (fields + steps)
// DELETE /api/drips/[id]   — delete the drip (steps + runs cascade)

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

interface StepInput {
  step_type?: "template" | "magic" | "text";
  delay_minutes?: number;
  template_name?: string | null;
  template_language?: string | null;
  magic_prompt?: string | null;
  magic_tone?: string | null;
  text_body?: string | null;
}

interface PatchBody {
  enabled?: boolean;
  name?: string;
  business_phone_number_id?: string;
  trigger_stage?: string;
  trigger_conditions?: Array<{ field?: string; value?: string | null }>;
  rate_limit_per_minute?: number;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  steps?: StepInput[];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const admin = createServiceRoleClient();
  const [{ data: drip }, { data: steps }] = await Promise.all([
    admin.from("drip_campaigns").select("*").eq("id", id).maybeSingle(),
    admin.from("drip_steps").select("*").eq("drip_id", id).order("step_order", { ascending: true }),
  ]);
  if (!drip) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ drip, steps: steps ?? [] });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.business_phone_number_id !== undefined) patch.business_phone_number_id = body.business_phone_number_id.trim();
  if (body.trigger_stage !== undefined) patch.trigger_stage = body.trigger_stage.trim();
  if (body.trigger_conditions !== undefined) {
    patch.trigger_conditions = body.trigger_conditions
      .map((c) => ({ field: (c.field ?? "").trim(), value: (c.value ?? "").toString().trim() }))
      .filter((c) => c.field.length > 0);
  }
  if (body.rate_limit_per_minute !== undefined) {
    patch.rate_limit_per_minute = Math.max(1, Math.min(120, body.rate_limit_per_minute));
  }
  if (body.quiet_hours_start !== undefined) patch.quiet_hours_start = body.quiet_hours_start?.trim() || null;
  if (body.quiet_hours_end !== undefined) patch.quiet_hours_end = body.quiet_hours_end?.trim() || null;

  const admin = createServiceRoleClient();

  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from("drip_campaigns").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Replace steps wholesale when provided.
  if (body.steps !== undefined) {
    const steps = body.steps.filter(Boolean);
    if (steps.length === 0) {
      return NextResponse.json({ error: "At least one step is required" }, { status: 400 });
    }
    await admin.from("drip_steps").delete().eq("drip_id", id);
    const rows = steps.map((s, i) => ({
      drip_id: id,
      step_order: i + 1,
      step_type: s.step_type ?? "template",
      delay_minutes: i === 0 ? 0 : Math.max(0, Math.round(s.delay_minutes ?? 0)),
      template_name: s.template_name?.trim() || null,
      template_language: s.template_language?.trim() || null,
      magic_prompt: s.magic_prompt ?? null,
      magic_tone: s.magic_tone ?? null,
      text_body: s.text_body ?? null,
    }));
    const { error: stepErr } = await admin.from("drip_steps").insert(rows);
    if (stepErr) return NextResponse.json({ error: stepErr.message }, { status: 500 });
  }

  const { data } = await admin.from("drip_campaigns").select("*").eq("id", id).maybeSingle();
  return NextResponse.json({ drip: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { id } = await params;
  const admin = createServiceRoleClient();
  // drip_steps + drip_runs cascade via FK ON DELETE CASCADE.
  const { error } = await admin.from("drip_campaigns").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
