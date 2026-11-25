// Seed all 12 Task 2 drip campaigns on AHL Messaging (DISABLED by default).
// One drip per template / day. Cadence from enrollment:
//   D1 = 0, D3 = +2d, D7 = +6d, D14 = +13d
//
//   GET /api/admin/seed-task2-all-drips
//   GET /api/admin/seed-task2-all-drips?enabled=1
//
// Submit Meta templates first: GET /api/admin/seed-task2-templates

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { AHL_MESSAGING_BPID } from "@/lib/ahl-messaging-contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEMPLATE_LANG = "en_US";
const DAY = 24 * 60;

type DripDef = {
  name: string;
  stage: string;
  delay_minutes: number;
  template_name: string;
};

const DRIPS: DripDef[] = [
  { name: "AHL Task2 Qualified D1", stage: "Warm Lead", delay_minutes: 0, template_name: "ahl_leak3_d1_a_book" },
  { name: "AHL Task2 Qualified D3", stage: "Warm Lead", delay_minutes: 2 * DAY, template_name: "ahl_leak3_d3_b_reminder" },
  { name: "AHL Task2 Qualified D7", stage: "Warm Lead", delay_minutes: 6 * DAY, template_name: "ahl_leak3_d7_b2_objection" },
  { name: "AHL Task2 Qualified D14", stage: "Warm Lead", delay_minutes: 13 * DAY, template_name: "ahl_leak3_d14_d_final" },
  { name: "AHL Task2 Noshow D1", stage: "Consultation Booked", delay_minutes: 0, template_name: "ahl_noshow_d1_a_reschedule" },
  { name: "AHL Task2 Noshow D3", stage: "Consultation Booked", delay_minutes: 2 * DAY, template_name: "ahl_noshow_d3_b_reminder" },
  { name: "AHL Task2 Noshow D7", stage: "Consultation Booked", delay_minutes: 6 * DAY, template_name: "ahl_noshow_d7_b2_urgency" },
  { name: "AHL Task2 Noshow D14", stage: "Consultation Booked", delay_minutes: 13 * DAY, template_name: "ahl_noshow_d14_d_final" },
  { name: "AHL Task2 Visited D1", stage: "Consultation Visited", delay_minutes: 0, template_name: "ahl_visited_d1_a_followup" },
  { name: "AHL Task2 Visited D3", stage: "Consultation Visited", delay_minutes: 2 * DAY, template_name: "ahl_visited_d3_b_reminder" },
  { name: "AHL Task2 Visited D7", stage: "Consultation Visited", delay_minutes: 6 * DAY, template_name: "ahl_visited_d7_b2_objection" },
  { name: "AHL Task2 Visited D14", stage: "Consultation Visited", delay_minutes: 13 * DAY, template_name: "ahl_visited_d14_d_final" },
];

async function upsertDrip(
  admin: ReturnType<typeof createServiceRoleClient>,
  bpid: string,
  def: DripDef,
  enabled: boolean,
) {
  const { data: existing } = await admin
    .from("drip_campaigns")
    .select("id")
    .eq("name", def.name)
    .eq("business_phone_number_id", bpid)
    .maybeSingle();

  const row = {
    enabled,
    trigger_stage: def.stage,
    trigger_source: null,
    quiet_hours_start: "21:00",
    quiet_hours_end: "09:00",
  };

  let dripId: string;
  let existed = false;

  if (existing) {
    existed = true;
    dripId = existing.id as string;
    await admin.from("drip_campaigns").update(row).eq("id", dripId);
    await admin.from("drip_steps").delete().eq("drip_id", dripId);
  } else {
    const { data: drip, error } = await admin
      .from("drip_campaigns")
      .insert({
        name: def.name,
        business_phone_number_id: bpid,
        created_by_email: "admin-seed-task2",
        ...row,
      })
      .select("id")
      .single();
    if (error || !drip) throw new Error(`Create "${def.name}": ${error?.message}`);
    dripId = drip.id as string;
  }

  const { error: stepErr } = await admin.from("drip_steps").insert({
    drip_id: dripId,
    step_order: 1,
    step_type: "template",
    delay_minutes: def.delay_minutes,
    template_name: def.template_name,
    template_language: TEMPLATE_LANG,
    text_body: null,
  });
  if (stepErr) throw new Error(`Step "${def.name}": ${stepErr.message}`);

  return {
    id: dripId,
    name: def.name,
    existed,
    enabled,
    trigger_stage: def.stage,
    template: def.template_name,
    delay_minutes: def.delay_minutes,
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const enabled = url.searchParams.get("enabled") === "1";
  const bpid = (url.searchParams.get("bpid") || AHL_MESSAGING_BPID).trim();

  const admin = createServiceRoleClient();
  const { data: bn } = await admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name")
    .eq("phone_number_id", bpid)
    .maybeSingle();
  if (!bn) {
    return NextResponse.json(
      { error: `business_numbers missing phone_number_id=${bpid}` },
      { status: 400 },
    );
  }

  const { data: legacy } = await admin
    .from("drip_campaigns")
    .select("id, name")
    .eq("business_phone_number_id", bpid)
    .or(
      [
        "name.eq.AHL Task2 Leak3 Pilot",
        "name.like.AHL Task2 Leak3 Pilot — %",
        "name.eq.AHL Task2 — Qualified (no book)",
        "name.eq.AHL Task2 — Booked no-show",
        "name.eq.AHL Task2 — Visited no order",
      ].join(","),
    );
  const deletedLegacy: string[] = [];
  for (const row of legacy ?? []) {
    await admin.from("drip_campaigns").delete().eq("id", row.id);
    deletedLegacy.push(row.name as string);
  }

  const results = [];
  for (const def of DRIPS) {
    results.push(await upsertDrip(admin, bpid, def, enabled));
  }

  return NextResponse.json({
    ok: true,
    bpid,
    business_number: bn,
    enabled,
    drip_count: results.length,
    drips: results,
    deleted_legacy: deletedLegacy,
    note: "12 drips created DISABLED. Approve Meta templates first, then ?enabled=1 when ready to pilot.",
  });
}
