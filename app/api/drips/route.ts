// GET  /api/drips   — list drips (with step + run counts)
// POST /api/drips   — create a drip (definition + ordered steps)

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

interface PostBody {
  name?: string;
  business_phone_number_id?: string;
  trigger_stage?: string;
  trigger_source?: string | null;
  trigger_field?: string | null;
  trigger_value?: string | null;
  trigger_conditions?: Array<{ field?: string; value?: string | null }>;
  rate_limit_per_minute?: number;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  steps?: StepInput[];
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();

  const { data: drips, error } = await admin
    .from("drip_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (drips ?? []).map((d) => d.id as string);
  const stepCount = new Map<string, number>();
  const runStats = new Map<string, { active: number; completed: number; total: number }>();
  if (ids.length > 0) {
    const [{ data: steps }, { data: runs }] = await Promise.all([
      admin.from("drip_steps").select("drip_id").in("drip_id", ids),
      admin.from("drip_runs").select("drip_id, status").in("drip_id", ids),
    ]);
    for (const s of steps ?? []) {
      const k = s.drip_id as string;
      stepCount.set(k, (stepCount.get(k) ?? 0) + 1);
    }
    for (const r of runs ?? []) {
      const k = r.drip_id as string;
      const st = runStats.get(k) ?? { active: 0, completed: 0, total: 0 };
      st.total++;
      if (r.status === "active") st.active++;
      if (r.status === "completed") st.completed++;
      runStats.set(k, st);
    }
  }

  return NextResponse.json({
    drips: (drips ?? []).map((d) => ({
      ...d,
      step_count: stepCount.get(d.id as string) ?? 0,
      runs: runStats.get(d.id as string) ?? { active: 0, completed: 0, total: 0 },
    })),
  });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const bpid = (body.business_phone_number_id ?? "").trim();
  const stage = (body.trigger_stage ?? "").trim();
  const steps = (body.steps ?? []).filter(Boolean);
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!bpid) return NextResponse.json({ error: "Send-from number is required" }, { status: 400 });
  if (!stage) return NextResponse.json({ error: "Trigger stage is required" }, { status: 400 });
  if (steps.length === 0) return NextResponse.json({ error: "At least one step is required" }, { status: 400 });
  for (const [i, s] of steps.entries()) {
    if ((s.step_type ?? "template") === "template" && !s.template_name?.trim()) {
      return NextResponse.json({ error: `Step ${i + 1}: template name required` }, { status: 400 });
    }
  }

  const admin = createServiceRoleClient();
  const { data: drip, error } = await admin
    .from("drip_campaigns")
    .insert({
      name,
      business_phone_number_id: bpid,
      trigger_stage: stage,
      trigger_source: (body.trigger_source ?? "").trim() || null,
      trigger_field: (body.trigger_field ?? "").trim() || null,
      trigger_value: (body.trigger_value ?? "").trim() || null,
      trigger_conditions: (body.trigger_conditions ?? [])
        .map((c) => ({ field: (c.field ?? "").trim(), value: (c.value ?? "").toString().trim() }))
        .filter((c) => c.field.length > 0),
      rate_limit_per_minute: Math.max(1, Math.min(120, body.rate_limit_per_minute ?? 30)),
      quiet_hours_start: body.quiet_hours_start?.trim() || null,
      quiet_hours_end: body.quiet_hours_end?.trim() || null,
      created_by_email: me.email ?? null,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stepRows = steps.map((s, i) => ({
    drip_id: drip.id as string,
    step_order: i + 1,
    step_type: s.step_type ?? "template",
    delay_minutes: i === 0 ? 0 : Math.max(0, Math.round(s.delay_minutes ?? 0)),
    template_name: s.template_name?.trim() || null,
    template_language: s.template_language?.trim() || null,
    magic_prompt: s.magic_prompt ?? null,
    magic_tone: s.magic_tone ?? null,
    text_body: s.text_body ?? null,
  }));
  const { error: stepErr } = await admin.from("drip_steps").insert(stepRows);
  if (stepErr) {
    await admin.from("drip_campaigns").delete().eq("id", drip.id);
    return NextResponse.json({ error: stepErr.message }, { status: 500 });
  }

  return NextResponse.json({ drip, steps: stepRows });
}
