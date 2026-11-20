// Seed Task 2 Leak 3 pilot as ONE multi-stage drip on AHL Messaging.
//
//   GET /api/admin/seed-task2-leak3-drip
//   GET /api/admin/seed-task2-leak3-drip?mode=text
//   GET /api/admin/seed-task2-leak3-drip?enabled=0
//
// Creates/updates a single drip that enrolls Warm / Cold1 / Cold2 / Deferred
// with Day 1 → Day 3 → Day 7 → Day 14. Deletes older per-stage pilot clones.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { AHL_MESSAGING_BPID } from "@/lib/ahl-messaging-contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta approved Leak3 Day-1 as en_US (not en) — wrong lang → (#132001). */
const TEMPLATE_LANG = "en_US";

const STAGES = [
  "Warm Lead",
  "Cold Lead 1",
  "Cold Lead 2",
  "Deferred Lead",
] as const;

const DRIP_NAME = "AHL Task2 Leak3 Pilot";

/** delay_minutes = gap from previous step (Day offsets: 1 → 3 → 7 → 14). */
const STEPS = [
  {
    step_order: 1,
    delay_minutes: 0,
    template_name: "ahl_leak3_d1_a_book",
    text_body:
      "Hi {{1}}, based on our discussion you are a good fit. Shall we book your consultation? Please share 2 preferred slots with day and time.",
  },
  {
    step_order: 2,
    delay_minutes: 2 * 24 * 60, // Day 3 = +2 days after Day 1
    template_name: "ahl_leak3_d3_b_reminder",
    text_body:
      "{{1}}, consult slots fill up for in-person and online. Reply BOOK and {{2}} will confirm a time that works for you.",
  },
  {
    step_order: 3,
    delay_minutes: 4 * 24 * 60, // Day 7 = +4 days after Day 3
    template_name: "ahl_leak3_d7_b2_objection",
    text_body:
      "Hi {{1}}, if price, family approval or travel is holding the booking, tell us which one and we will help with options. Reply PRICE, FAMILY or TRAVEL.",
  },
  {
    step_order: 4,
    delay_minutes: 7 * 24 * 60, // Day 14 = +7 days after Day 7
    template_name: "ahl_leak3_d14_d_final",
    text_body:
      "{{1}}, last follow-up on your consultation. Reply YES to book, or LATER with a date and we will wait till then.",
  },
] as const;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = (url.searchParams.get("mode") || "template").trim().toLowerCase();
  const enabled = url.searchParams.get("enabled") !== "0";
  const bpid = (url.searchParams.get("bpid") || AHL_MESSAGING_BPID).trim();

  const admin = createServiceRoleClient();

  const { data: bn } = await admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name")
    .eq("phone_number_id", bpid)
    .maybeSingle();
  if (!bn) {
    return NextResponse.json(
      {
        error: `business_numbers missing phone_number_id=${bpid}. Connect AHL Messaging first.`,
      },
      { status: 400 },
    );
  }

  // Delete legacy per-stage clones (name pattern "AHL Task2 Leak3 Pilot — …").
  // Cascade removes their steps + runs. Keep only the multi-stage pilot below.
  const { data: legacy } = await admin
    .from("drip_campaigns")
    .select("id, name")
    .eq("business_phone_number_id", bpid)
    .like("name", "AHL Task2 Leak3 Pilot — %");
  const deletedLegacy: string[] = [];
  for (const row of legacy ?? []) {
    await admin.from("drip_campaigns").delete().eq("id", row.id);
    deletedLegacy.push(row.name as string);
  }

  const { data: existing } = await admin
    .from("drip_campaigns")
    .select("id, name, enabled")
    .eq("name", DRIP_NAME)
    .eq("business_phone_number_id", bpid)
    .maybeSingle();

  const stages = [...STAGES];
  const primary = stages[0]!;

  let dripId: string;
  let existed = false;

  if (existing) {
    existed = true;
    dripId = existing.id as string;
    await admin
      .from("drip_campaigns")
      .update({
        enabled,
        trigger_stage: primary,
        trigger_stages: stages,
      })
      .eq("id", dripId);
    await admin.from("drip_steps").delete().eq("drip_id", dripId);
  } else {
    const { data: drip, error } = await admin
      .from("drip_campaigns")
      .insert({
        name: DRIP_NAME,
        business_phone_number_id: bpid,
        trigger_stage: primary,
        trigger_stages: stages,
        trigger_source: null,
        enabled,
        quiet_hours_start: "21:00",
        quiet_hours_end: "09:00",
        created_by_email: "admin-seed-task2",
      })
      .select("id")
      .single();

    if (error || !drip) {
      return NextResponse.json(
        { error: `Failed creating drip: ${error?.message}` },
        { status: 500 },
      );
    }
    dripId = drip.id as string;
  }

  const useText = mode === "text";
  const stepRows = STEPS.map((s) => ({
    drip_id: dripId,
    step_order: s.step_order,
    step_type: useText ? "text" : "template",
    delay_minutes: s.delay_minutes,
    template_name: useText ? null : s.template_name,
    template_language: useText ? null : TEMPLATE_LANG,
    text_body: useText ? s.text_body : null,
  }));

  const { error: stepErr } = await admin.from("drip_steps").insert(stepRows);
  if (stepErr) {
    if (!existed) await admin.from("drip_campaigns").delete().eq("id", dripId);
    return NextResponse.json({ error: stepErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    bpid,
    business_number: bn,
    mode,
    enabled,
    pilot_owner: process.env.DRIP_PILOT_OWNER || "Mehjabeen",
    drip: {
      id: dripId,
      name: DRIP_NAME,
      trigger_stage: primary,
      trigger_stages: stages,
      existed,
      steps: STEPS.map((s) => ({
        order: s.step_order,
        delay_minutes: s.delay_minutes,
        template: s.template_name,
      })),
    },
    deleted_legacy: deletedLegacy,
    meta_templates_required: STEPS.map((s) => s.template_name),
    how_to_test: {
      sync: "POST /api/ahl-crm/sync with Bearer WEBHOOK_INTERNAL_TOKEN",
      body: {
        mobileNo: "91XXXXXXXXXX",
        leadUniqueId: "Lead ID - TEST",
        leadStatus: "Warm Lead",
        assignedTo: "Mehjabeen",
        clientName: "Test Client",
      },
      inbox_filter:
        'Use the "My leaks" chip — only YOUR assigned AHL Messaging chats with an active drip (other agents never appear).',
      note: useText
        ? "Text mode only delivers inside the 24h WhatsApp window. Prefer mode=template once all four ahl_leak3_* templates are approved on Meta."
        : "Requires Meta-approved templates: ahl_leak3_d1_a_book, ahl_leak3_d3_b_reminder, ahl_leak3_d7_b2_objection, ahl_leak3_d14_d_final on AHL Messaging.",
    },
  });
}
