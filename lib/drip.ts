// Drip engine — CRM lead-event triggered message sequences.
//
//   • enrollDripsForLead()  — called from the CRM webhook. Matches a lead's
//     (stage, source) against enabled drips and enrolls the matching
//     contact(s) into a drip_run.
//   • runDripTick()         — called every 30s by the in-process scheduler.
//     Drains due runs: sends the current step, schedules the next, and stops
//     a run if the contact's CRM stage has moved off the enrolled stage.
//
// Only WhatsApp-Cloud sends here (sendTemplate / sendTextMessage). The drip's
// business_phone_number_id picks the sending number + portfolio token.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { sendTemplate, sendTextMessage } from "@/lib/whatsapp";
import { lsqGetLeadRawByPhone } from "@/lib/lsq";
import type { ParsedLsqLead } from "@/lib/lsq-webhook";

interface DripRow {
  id: string;
  name: string;
  business_phone_number_id: string;
  trigger_stage: string;
  trigger_source: string | null;
  trigger_field: string | null;
  trigger_value: string | null;
  trigger_conditions: Array<{ field?: string; value?: string | null }> | null;
  enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

interface StepRow {
  drip_id: string;
  step_order: number;
  step_type: "template" | "magic" | "text";
  delay_minutes: number;
  template_name: string | null;
  template_language: string | null;
  magic_prompt: string | null;
  magic_tone: string | null;
  text_body: string | null;
}

interface RunRow {
  id: string;
  drip_id: string;
  contact_id: string | null;
  wa_id: string;
  business_phone_number_id: string;
  display_name: string | null;
  enrolled_stage: string | null;
  next_step_order: number;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Substitute {{name}} / {{1}} with the contact name; drop other placeholders. */
function renderVars(s: string | null | undefined, name: string | null): string {
  return (s ?? "").replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k) =>
    k === "name" || k === "1" ? name ?? "" : "",
  );
}

// ---------------------------------------------------------------------------
// Enrollment — called from the CRM webhook after the lead is mirrored.
// ---------------------------------------------------------------------------
export async function enrollDripsForLead(lead: ParsedLsqLead): Promise<number> {
  const stage = norm(lead.stage);
  if (!stage) return 0;
  const admin = createServiceRoleClient();

  const { data: drips } = await admin
    .from("drip_campaigns")
    .select(
      "id, name, business_phone_number_id, trigger_stage, trigger_source, trigger_field, trigger_value, trigger_conditions, enabled, quiet_hours_start, quiet_hours_end",
    )
    .eq("enabled", true);

  // Stage-matched candidates first (cheap, no LSQ call).
  const stageDrips = (drips ?? []).filter((d) => norm(d.trigger_stage) === stage) as DripRow[];
  if (stageDrips.length === 0) return 0;

  // Every field condition across all candidate drips (new multi-condition +
  // legacy single field).
  const conditionsOf = (d: DripRow): Array<{ field: string; value: string }> => {
    const list = Array.isArray(d.trigger_conditions) ? d.trigger_conditions : [];
    const out = list
      .map((c) => ({ field: norm(c.field), value: norm(c.value) }))
      .filter((c) => c.field);
    if (out.length === 0 && d.trigger_field) {
      out.push({ field: norm(d.trigger_field), value: norm(d.trigger_value) });
    }
    return out;
  };

  // Field values: start with the push, then enrich from a single CRM lead
  // fetch if any condition needs a field the push didn't include (mx_Brand
  // etc. rarely ride along on the webhook).
  let fields: Record<string, string> = { ...(lead.fields ?? {}) };
  const neededFields = [
    ...new Set(stageDrips.flatMap((d) => conditionsOf(d).map((c) => c.field))),
  ];
  const missing = neededFields.some((f) => !(f in fields));
  if (missing && lead.mobile) {
    const raw = await lsqGetLeadRawByPhone(lead.mobile);
    if (raw) fields = { ...raw, ...fields }; // push values win over the fetch
  }

  const leadSrc = norm(lead.source);
  const leadSub = norm(lead.sub_source);
  const matched = stageDrips.filter((d) => {
    const conds = conditionsOf(d);
    if (conds.length > 0) {
      // ALL conditions must match (AND).
      return conds.every((c) => {
        const have = norm(fields[c.field] ?? "");
        return c.value ? have === c.value : have.length > 0;
      });
    }
    // Legacy source filter (back-compat).
    const want = norm(d.trigger_source);
    if (!want) return true; // any
    return want === leadSrc || want === leadSub;
  });
  if (matched.length === 0) return 0;

  let enrolled = 0;
  for (const drip of matched as DripRow[]) {
    // Find the WhatsApp contact(s) on THIS drip's number that the lead maps to.
    const byId = new Map<string, { wa_id: string; name: string | null }>();
    if (lead.prospect_id) {
      const { data } = await admin
        .from("contacts")
        .select("id, wa_id, name")
        .eq("business_phone_number_id", drip.business_phone_number_id)
        .eq("lsq_prospect_id", lead.prospect_id);
      for (const r of data ?? []) byId.set(r.id as string, { wa_id: r.wa_id as string, name: r.name as string | null });
    }
    if (lead.mobile) {
      const last10 = lead.mobile.slice(-10);
      const { data } = await admin
        .from("contacts")
        .select("id, wa_id, name")
        .eq("business_phone_number_id", drip.business_phone_number_id)
        .ilike("wa_id", `%${last10}`);
      for (const r of data ?? []) byId.set(r.id as string, { wa_id: r.wa_id as string, name: r.name as string | null });
    }
    if (byId.size === 0) continue;

    const rows = [...byId.entries()].map(([contactId, c]) => ({
      drip_id: drip.id,
      contact_id: contactId,
      wa_id: c.wa_id,
      business_phone_number_id: drip.business_phone_number_id,
      display_name: c.name,
      enrolled_stage: lead.stage,
      status: "active",
      next_step_order: 1,
      next_run_at: new Date().toISOString(),
    }));
    // onConflict (drip_id, contact_id) ignore — never double-enroll an active
    // or past run for the same contact (avoids re-firing on repeated pushes).
    const { error } = await admin
      .from("drip_runs")
      .upsert(rows, { onConflict: "drip_id,contact_id", ignoreDuplicates: true });
    if (!error) enrolled += rows.length;
  }
  return enrolled;
}

// ---------------------------------------------------------------------------
// Worker — drains due runs.
// ---------------------------------------------------------------------------
export interface DripTickResult {
  scanned: number;
  sent: number;
  completed: number;
  stopped: number;
  failed: number;
}

/** Is `now` (IST) inside the [start,end] quiet window? Handles wrap-around
 *  windows (e.g. 21:00–08:00). Returns the minute-of-day the window ends, or
 *  null if not in a quiet window. */
function quietEndMinute(
  start: string | null,
  end: string | null,
  istMinutes: number,
): number | null {
  if (!start || !end) return null;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map((x) => parseInt(x, 10));
    return (h || 0) * 60 + (m || 0);
  };
  const a = toMin(start);
  const b = toMin(end);
  if (a === b) return null;
  const inside = a < b ? istMinutes >= a && istMinutes < b : istMinutes >= a || istMinutes < b;
  return inside ? b : null;
}

async function sendStep(run: RunRow, step: StepRow): Promise<string | null> {
  const name = run.display_name ?? null;
  if (step.step_type === "template") {
    if (!step.template_name) throw new Error("template step missing template_name");
    const lang = step.template_language || "en";
    const bodyComp = name
      ? [{ type: "body", parameters: [{ type: "text", text: name }] }]
      : undefined;
    try {
      const resp = await sendTemplate(
        run.wa_id,
        step.template_name,
        lang,
        bodyComp,
        run.business_phone_number_id,
      );
      return resp.messages?.[0]?.id ?? null;
    } catch (e) {
      // Template may have no {{1}} body var → Meta rejects the param. Retry
      // with no components so zero-variable templates also send.
      if (bodyComp) {
        const resp = await sendTemplate(
          run.wa_id,
          step.template_name,
          lang,
          undefined,
          run.business_phone_number_id,
        );
        return resp.messages?.[0]?.id ?? null;
      }
      throw e;
    }
  }
  // text + magic (v1: magic prompt is sent as plain text). Only delivers
  // inside the 24h window — templates are the reliable re-engagement path.
  const body = renderVars(step.step_type === "magic" ? step.magic_prompt : step.text_body, name);
  if (!body.trim()) throw new Error(`${step.step_type} step has no body`);
  const resp = await sendTextMessage(run.wa_id, body, run.business_phone_number_id);
  return resp.messages?.[0]?.id ?? null;
}

async function logDripSend(
  admin: ReturnType<typeof createServiceRoleClient>,
  run: RunRow,
  step: StepRow,
  waMessageId: string | null,
): Promise<void> {
  if (!run.contact_id) return;
  try {
    const isTpl = step.step_type === "template";
    const content = isTpl
      ? renderVars(step.template_name ?? "", run.display_name)
      : renderVars(step.step_type === "magic" ? step.magic_prompt : step.text_body, run.display_name);
    const nowIso = new Date().toISOString();
    await admin.from("messages").insert({
      contact_id: run.contact_id,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: isTpl ? "template" : "text",
      template_name: isTpl ? step.template_name : null,
      content,
      status: "sent",
      timestamp: nowIso,
      business_phone_number_id: run.business_phone_number_id,
    });
    await admin
      .from("contacts")
      .update({
        last_message_at: nowIso,
        last_message_preview: content.slice(0, 120),
        last_message_direction: "outbound",
        last_message_status: "sent",
      })
      .eq("id", run.contact_id);
  } catch {
    /* logging must never fail the send */
  }
}

export async function runDripTick(): Promise<DripTickResult> {
  const admin = createServiceRoleClient();
  const result: DripTickResult = { scanned: 0, sent: 0, completed: 0, stopped: 0, failed: 0 };

  const nowIso = new Date().toISOString();
  const { data: due } = await admin
    .from("drip_runs")
    .select(
      "id, drip_id, contact_id, wa_id, business_phone_number_id, display_name, enrolled_stage, next_step_order",
    )
    .eq("status", "active")
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(50);

  const runs = (due ?? []) as RunRow[];
  result.scanned = runs.length;
  if (runs.length === 0) return result;

  // Load the drips + steps these runs reference.
  const dripIds = [...new Set(runs.map((r) => r.drip_id))];
  const [{ data: drips }, { data: steps }] = await Promise.all([
    admin
      .from("drip_campaigns")
      .select(
        "id, name, business_phone_number_id, trigger_stage, trigger_source, enabled, quiet_hours_start, quiet_hours_end",
      )
      .in("id", dripIds),
    admin.from("drip_steps").select("*").in("drip_id", dripIds).order("step_order", { ascending: true }),
  ]);
  const dripById = new Map<string, DripRow>();
  for (const d of (drips ?? []) as DripRow[]) dripById.set(d.id, d);
  const stepsByDrip = new Map<string, StepRow[]>();
  for (const s of (steps ?? []) as StepRow[]) {
    const arr = stepsByDrip.get(s.drip_id) ?? stepsByDrip.set(s.drip_id, []).get(s.drip_id)!;
    arr.push(s);
  }

  // IST minute-of-day for quiet-hours checks.
  const istMinutes = (() => {
    const ist = new Date(Date.now() + 5.5 * 3600_000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  })();

  for (const run of runs) {
    const drip = dripById.get(run.drip_id);
    const stop = async (reason: string) => {
      await admin
        .from("drip_runs")
        .update({ status: "stopped", stop_reason: reason, updated_at: new Date().toISOString() })
        .eq("id", run.id);
      result.stopped++;
    };

    if (!drip || !drip.enabled) {
      await stop("drip_disabled");
      continue;
    }

    // Stage-change guard — stop if the contact moved off the enrolled stage.
    if (run.contact_id && run.enrolled_stage) {
      const { data: ct } = await admin
        .from("contacts")
        .select("lsq_stage")
        .eq("id", run.contact_id)
        .maybeSingle();
      if (ct && norm(ct.lsq_stage as string | null) !== norm(run.enrolled_stage)) {
        await stop("stage_changed");
        continue;
      }
    }

    // Quiet hours — defer to the end of the window.
    const endMin = quietEndMinute(drip.quiet_hours_start, drip.quiet_hours_end, istMinutes);
    if (endMin !== null) {
      const delayMin = (endMin - istMinutes + 1440) % 1440 || 1;
      await admin
        .from("drip_runs")
        .update({ next_run_at: new Date(Date.now() + delayMin * 60_000).toISOString() })
        .eq("id", run.id);
      continue;
    }

    const all = (stepsByDrip.get(run.drip_id) ?? []).sort((a, b) => a.step_order - b.step_order);
    const step = all.find((s) => s.step_order === run.next_step_order);
    if (!step) {
      await admin
        .from("drip_runs")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", run.id);
      result.completed++;
      continue;
    }

    try {
      const waId = await sendStep(run, step);
      await logDripSend(admin, run, step, waId);
      result.sent++;

      const next = all.find((s) => s.step_order === run.next_step_order + 1);
      const patch: Record<string, unknown> = {
        last_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (next) {
        patch.next_step_order = next.step_order;
        patch.next_run_at = new Date(Date.now() + Math.max(0, next.delay_minutes) * 60_000).toISOString();
      } else {
        patch.status = "completed";
        result.completed++;
      }
      await admin.from("drip_runs").update(patch).eq("id", run.id);
    } catch (e) {
      await admin
        .from("drip_runs")
        .update({
          status: "failed",
          stop_reason: (e instanceof Error ? e.message : "send failed").slice(0, 300),
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      result.failed++;
    }
  }

  return result;
}
