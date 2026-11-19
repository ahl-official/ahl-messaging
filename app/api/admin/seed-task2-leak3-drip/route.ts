// Seed Task 2 Leak 3 pilot drips on AHL Messaging (Meta templates).
//
//   GET /api/admin/seed-task2-leak3-drip
//   GET /api/admin/seed-task2-leak3-drip?mode=text   — use text step (24h window only)
//   GET /api/admin/seed-task2-leak3-drip?enabled=0   — create but leave disabled
//
// Creates one drip per Leak-3 trigger stage (Warm / Cold1 / Cold2 / Deferred)
// with Day-1 step only for testing. Idempotent by drip name.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { AHL_MESSAGING_BPID } from "@/lib/ahl-messaging-contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEMPLATE_NAME = "ahl_leak3_d1_a_book";
const TEMPLATE_LANG = "en";

const STAGES = [
  "Warm Lead",
  "Cold Lead 1",
  "Cold Lead 2",
  "Deferred Lead",
] as const;

const DAY1_TEXT =
  "Hi {{1}}, based on our discussion you are a good fit. Shall we book your consultation? Please share 2 preferred slots with day and time.";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = (url.searchParams.get("mode") || "template").trim().toLowerCase();
  const enabled = url.searchParams.get("enabled") !== "0";
  const bpid = (url.searchParams.get("bpid") || AHL_MESSAGING_BPID).trim();

  const admin = createServiceRoleClient();

  // Confirm AHL Messaging number exists in business_numbers.
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

  const created: Array<{ stage: string; drip_id: string; name: string; existed: boolean }> =
    [];

  for (const stage of STAGES) {
    const name = `AHL Task2 Leak3 Pilot — ${stage}`;
    const { data: existing } = await admin
      .from("drip_campaigns")
      .select("id, name, enabled")
      .eq("name", name)
      .eq("business_phone_number_id", bpid)
      .maybeSingle();

    if (existing) {
      await admin
        .from("drip_campaigns")
        .update({ enabled, trigger_stage: stage })
        .eq("id", existing.id);
      // Refresh step 1
      await admin.from("drip_steps").delete().eq("drip_id", existing.id);
      await admin.from("drip_steps").insert({
        drip_id: existing.id,
        step_order: 1,
        step_type: mode === "text" ? "text" : "template",
        delay_minutes: 0,
        template_name: mode === "text" ? null : TEMPLATE_NAME,
        template_language: mode === "text" ? null : TEMPLATE_LANG,
        text_body: mode === "text" ? DAY1_TEXT : null,
      });
      created.push({
        stage,
        drip_id: existing.id as string,
        name,
        existed: true,
      });
      continue;
    }

    const { data: drip, error } = await admin
      .from("drip_campaigns")
      .insert({
        name,
        business_phone_number_id: bpid,
        trigger_stage: stage,
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
        { error: `Failed creating drip for ${stage}: ${error?.message}` },
        { status: 500 },
      );
    }

    const { error: stepErr } = await admin.from("drip_steps").insert({
      drip_id: drip.id,
      step_order: 1,
      step_type: mode === "text" ? "text" : "template",
      delay_minutes: 0,
      template_name: mode === "text" ? null : TEMPLATE_NAME,
      template_language: mode === "text" ? null : TEMPLATE_LANG,
      text_body: mode === "text" ? DAY1_TEXT : null,
    });
    if (stepErr) {
      await admin.from("drip_campaigns").delete().eq("id", drip.id);
      return NextResponse.json({ error: stepErr.message }, { status: 500 });
    }

    created.push({ stage, drip_id: drip.id as string, name, existed: false });
  }

  return NextResponse.json({
    ok: true,
    bpid,
    business_number: bn,
    mode,
    enabled,
    pilot_owner: process.env.DRIP_PILOT_OWNER || "Mehjabeen",
    drips: created,
    how_to_test: {
      sync: "POST /api/ahl-crm/sync with Bearer WEBHOOK_INTERNAL_TOKEN",
      body: {
        mobileNo: "91XXXXXXXXXX",
        leadUniqueId: "Lead ID - TEST",
        leadStatus: "Warm Lead",
        assignedTo: "Mehjabeen",
        clientName: "Test Client",
      },
      note:
        mode === "text"
          ? "Text mode only delivers inside the 24h WhatsApp window. Prefer mode=template once ahl_leak3_d1_a_book is approved on Meta."
          : "Requires Meta-approved template ahl_leak3_d1_a_book on AHL Messaging.",
    },
  });
}
