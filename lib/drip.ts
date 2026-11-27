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
import {
  AHL_MESSAGING_BPID,
  ensureAhlMessagingContact,
} from "@/lib/ahl-messaging-contact";
import { TASK2_TWO_VAR_TEMPLATE_NAMES } from "@/lib/task2-leak-templates";
import { resolveAssigneeFromContact } from "@/lib/booking-auto-task";

/** Pilot owner filter. Default Mehjabeen; set DRIP_PILOT_OWNER=* to enroll all. */
function dripPilotOwner(): string {
  return (process.env.DRIP_PILOT_OWNER ?? "Mehjabeen").trim().toLowerCase();
}

function ownerMatchesPilot(ownerName: string | null | undefined): boolean {
  const pilot = dripPilotOwner();
  if (!pilot || pilot === "*" || pilot === "all") return true;
  const owner = norm(ownerName);
  if (!owner) return false;
  if (owner === pilot) return true;
  if (owner.startsWith(pilot + " ")) return true;
  return owner.split(/\s+/)[0] === pilot;
}

interface DripRow {
  id: string;
  name: string;
  business_phone_number_id: string;
  trigger_stage: string;
  /** Multi-stage enroll set. Empty/null → fall back to trigger_stage only. */
  trigger_stages: string[] | null;
  trigger_source: string | null;
  trigger_field: string | null;
  trigger_value: string | null;
  trigger_conditions: Array<{ field?: string; value?: string | null }> | null;
  enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

/** Stages this drip enrolls (and stays active on). */
function dripStageSet(d: Pick<DripRow, "trigger_stage" | "trigger_stages">): Set<string> {
  const out = new Set<string>();
  for (const s of d.trigger_stages ?? []) {
    const n = norm(s);
    if (n) out.add(n);
  }
  const primary = norm(d.trigger_stage);
  if (primary) out.add(primary);
  return out;
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
  /** Attempts for the current step. Reset when the step advances. */
  step_send_attempts?: number | null;
  stop_reason?: string | null;
}

/** Max Meta send tries per step. Fail #1 → retry same template after 24h; fail #2 → stop. */
const MAX_STEP_SEND_ATTEMPTS = 2;
const STEP_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const RETRY_COLS = [
  "step_send_attempts",
  "last_send_error",
  "last_sent_step_order",
  "last_sent_attempts",
  "last_failed_wa_message_id",
] as const;

/** Permanent / non-transient Meta codes — stop immediately, no day-2 retry. */
const HARD_META_CODES = new Set([
  100, // Invalid parameter
  131021, // Recipient cannot be sender
  131026, // Undeliverable / not on WhatsApp
  131031, // Business eligibility / payment
  131049, // Marketing / ecosystem restriction (common Task2 reject)
  131051, // Unsupported message type
  132001, // Template name does not exist
  132015, // Template paused
  132016, // Template disabled
  133010, // Account not registered
  130472, // User in experiment / restricted
]);

const HARD_META_MESSAGE =
  /undeliverable|not a valid whatsapp|does not exist|template.*paused|template.*disabled|experiment|not registered|invalid parameter|unsupported message|marketing messages? (lite|limit)|ecosystem/i;

export function parseMetaErrorCode(err: string): number | null {
  const m = err.match(/\(\#(\d{3,5})\)|code[\s:]+(\d{3,5})/i);
  if (!m) return null;
  const n = parseInt(m[1] || m[2] || "", 10);
  return Number.isFinite(n) ? n : null;
}

/** Hard = stop now. Soft = retry after 24h (max 2 attempts). */
export function isHardMetaDripFailure(err: string): boolean {
  const code = parseMetaErrorCode(err);
  if (code != null && HARD_META_CODES.has(code)) return true;
  return HARD_META_MESSAGE.test(err);
}

function priorStepAttempts(run: RunRow): number {
  if (typeof run.step_send_attempts === "number") return run.step_send_attempts;
  return /^retry_after_fail:/i.test(run.stop_reason || "") ? 1 : 0;
}

async function createDripFailureTask(
  admin: ReturnType<typeof createServiceRoleClient>,
  run: RunRow,
  errMsg: string,
  templateName: string | null,
): Promise<void> {
  if (!run.contact_id) return;
  try {
    const { data: contact } = await admin
      .from("contacts")
      .select(
        "id, name, profile_name, assigned_to, lsq_owner_email, lsq_owner_name, wa_id",
      )
      .eq("id", run.contact_id)
      .maybeSingle();
    if (!contact) return;

    const assignee = await resolveAssigneeFromContact(admin, {
      assigned_to: (contact.assigned_to as string | null) ?? null,
      lsq_owner_email: (contact.lsq_owner_email as string | null) ?? null,
      lsq_owner_name: (contact.lsq_owner_name as string | null) ?? null,
    });
    if (!assignee) {
      console.warn(
        `[drip] fail task skipped — no assignee for contact ${run.contact_id}`,
      );
      return;
    }

    const clientName =
      ((contact.name as string | null) ?? "").trim() ||
      ((contact.profile_name as string | null) ?? "").trim() ||
      run.display_name ||
      run.wa_id;

    const title =
      `Drip template failed — ${clientName}`.slice(0, 200);
    const description = [
      `Auto-created from drip send failure.`,
      `Client: ${clientName}`,
      `Phone: ${run.wa_id}`,
      `Template: ${templateName || "(unknown)"}`,
      `Step: ${run.next_step_order}`,
      `Error: ${errMsg}`,
      `Action: Call / check WhatsApp quality, then mark Done.`,
    ].join("\n");

    const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await admin
      .from("tasks")
      .select("id, title, description")
      .eq("contact_id", run.contact_id)
      .in("status", ["open", "in_progress"])
      .gte("created_at", since)
      .limit(10);

    const prior = (
      (existing ?? []) as Array<{
        id: string;
        title: string;
        description: string | null;
      }>
    ).find((t) => {
      const tl = t.title.toLowerCase();
      return (
        tl.startsWith("drip template failed") ||
        (t.description || "").startsWith("Auto-created from drip send failure.")
      );
    });

    const due = new Date(Date.now() + 5.5 * 3600_000);
    due.setUTCHours(18, 29, 59, 999);
    const dueAt = new Date(due.getTime() - 5.5 * 3600_000).toISOString();

    if (prior) {
      await admin
        .from("tasks")
        .update({
          title,
          description,
          priority: "high",
          assigned_to: assignee.memberId,
          due_at: dueAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", prior.id);
      return;
    }

    await admin.from("tasks").insert({
      title,
      description,
      status: "open",
      priority: "high",
      assigned_to: assignee.memberId,
      created_by: null,
      contact_id: run.contact_id,
      business_phone_number_id: run.business_phone_number_id || null,
      due_at: dueAt,
    });
  } catch (e) {
    console.warn(
      "[drip] fail task create failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Apply hard-stop or 24h retry for a failed drip step. Creates CRM task on final fail.
 * Returns whether the run was marked failed.
 */
async function applyDripStepFailure(
  admin: ReturnType<typeof createServiceRoleClient>,
  run: RunRow,
  errMsgRaw: string,
  templateName: string | null,
  opts?: { waMessageId?: string | null; stepOrder?: number },
): Promise<"retried" | "failed"> {
  const errMsg = errMsgRaw.slice(0, 300);
  const hard = isHardMetaDripFailure(errMsg);
  const attempts = priorStepAttempts(run) + 1;
  const stepOrder = opts?.stepOrder ?? run.next_step_order;

  if (hard || attempts >= MAX_STEP_SEND_ATTEMPTS) {
    console.warn(
      `[drip] stop run=${run.id} step=${stepOrder} hard=${hard} attempt=${attempts}/${MAX_STEP_SEND_ATTEMPTS}: ${errMsg}`,
    );
    await updateDripRun(admin, run.id, {
      status: "failed",
      next_step_order: stepOrder,
      step_send_attempts: attempts,
      last_send_error: errMsg,
      stop_reason: (hard ? `hard_fail:${errMsg}` : errMsg).slice(0, 300),
      last_failed_wa_message_id: opts?.waMessageId || null,
      updated_at: new Date().toISOString(),
    });
    await createDripFailureTask(admin, { ...run, next_step_order: stepOrder }, errMsg, templateName);
    return "failed";
  }

  console.warn(
    `[drip] retry in 24h run=${run.id} step=${stepOrder} attempt=${attempts}/${MAX_STEP_SEND_ATTEMPTS}: ${errMsg}`,
  );
  await updateDripRun(admin, run.id, {
    status: "active",
    next_step_order: stepOrder,
    step_send_attempts: attempts,
    last_send_error: errMsg,
    stop_reason: `retry_after_fail:${errMsg}`.slice(0, 300),
    next_run_at: new Date(Date.now() + STEP_RETRY_DELAY_MS).toISOString(),
    last_failed_wa_message_id: opts?.waMessageId || null,
    updated_at: new Date().toISOString(),
  });
  return "retried";
}

/** Update drip_runs; if migration 0130 cols are missing, retry without them. */
async function updateDripRun(
  admin: ReturnType<typeof createServiceRoleClient>,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from("drip_runs").update(patch).eq("id", runId);
  if (!error) return;
  if (!RETRY_COLS.some((c) => (error.message || "").includes(c))) {
    throw error;
  }
  const stripped = { ...patch };
  for (const c of RETRY_COLS) delete stripped[c];
  const { error: e2 } = await admin.from("drip_runs").update(stripped).eq("id", runId);
  if (e2) throw e2;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Templates that need {{1}}=name and {{2}}=agent when sending via Meta. */
const TWO_VAR_TEMPLATES = TASK2_TWO_VAR_TEMPLATE_NAMES;

/** Substitute {{name}}/{{1}} with contact name, {{agent}}/{{2}} with agent. */
function renderVars(
  s: string | null | undefined,
  name: string | null,
  agent: string | null = null,
): string {
  return (s ?? "").replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k) => {
    if (k === "name" || k === "1") return name ?? "";
    if (k === "agent" || k === "2") return agent ?? "";
    return "";
  });
}

async function resolveAgentName(
  admin: ReturnType<typeof createServiceRoleClient>,
  contactId: string | null,
): Promise<string> {
  if (contactId) {
    const { data } = await admin
      .from("contacts")
      .select("lsq_owner_name")
      .eq("id", contactId)
      .maybeSingle();
    const owner = (data?.lsq_owner_name as string | null)?.trim();
    if (owner) return owner.split(/\s+/)[0] || owner;
  }
  const pilot = dripPilotOwner();
  if (pilot && pilot !== "*" && pilot !== "all") {
    return pilot.charAt(0).toUpperCase() + pilot.slice(1);
  }
  return "your counsellor";
}

// ---------------------------------------------------------------------------
// Enrollment — called from the CRM webhook after the lead is mirrored.
// ---------------------------------------------------------------------------
export async function enrollDripsForLead(lead: ParsedLsqLead): Promise<number> {
  const stage = norm(lead.stage);
  if (!stage) return 0;

  // Stage matching on each drip decides who enrolls (Qualified ≠ Booked ≠ Visited).
  // Task 2 pilot: only the configured owner (default Mehjabeen; set
  // DRIP_PILOT_OWNER=Mantashaa for her pilot, or * for everyone).
  if (!ownerMatchesPilot(lead.owner_name)) return 0;

  const admin = createServiceRoleClient();

  // Prefer trigger_stages; fall back if the column is absent on older DBs.
  let drips: DripRow[] | null = null;
  {
    const withStages = await admin
      .from("drip_campaigns")
      .select(
        "id, name, business_phone_number_id, trigger_stage, trigger_stages, trigger_source, trigger_field, trigger_value, trigger_conditions, enabled, quiet_hours_start, quiet_hours_end",
      )
      .eq("enabled", true);
    if (
      withStages.error &&
      /trigger_stages/i.test(withStages.error.message || "")
    ) {
      const base = await admin
        .from("drip_campaigns")
        .select(
          "id, name, business_phone_number_id, trigger_stage, trigger_source, trigger_field, trigger_value, trigger_conditions, enabled, quiet_hours_start, quiet_hours_end",
        )
        .eq("enabled", true);
      drips = (base.data ?? []) as DripRow[];
    } else {
      drips = (withStages.data ?? []) as DripRow[];
    }
  }

  // Stage-matched candidates — primary stage OR any entry in trigger_stages.
  const stageDrips = (drips ?? []).filter((d) =>
    dripStageSet(d as DripRow).has(stage),
  ) as DripRow[];
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

    // Task 2: CRM leads may never have messaged AHL Messaging. Create the
    // contact on that Meta number so drip templates can send from it.
    if (
      byId.size === 0 &&
      lead.mobile &&
      drip.business_phone_number_id === AHL_MESSAGING_BPID
    ) {
      const ensured = await ensureAhlMessagingContact({
        mobile: lead.mobile,
        name: lead.first_name,
        stage: lead.stage,
        ownerName: lead.owner_name,
        ownerEmail: lead.owner_email,
        prospectId: lead.prospect_id,
        leadNumber: lead.lead_number,
      });
      if (ensured) {
        byId.set(ensured.id, { wa_id: ensured.wa_id, name: ensured.name });
      }
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

async function sendStep(
  admin: ReturnType<typeof createServiceRoleClient>,
  run: RunRow,
  step: StepRow,
): Promise<string | null> {
  const name = run.display_name ?? null;
  const needsAgent =
    (step.template_name && TWO_VAR_TEMPLATES.has(step.template_name)) ||
    /\{\{\s*(2|agent)\s*\}\}/i.test(step.text_body ?? "") ||
    /\{\{\s*(2|agent)\s*\}\}/i.test(step.magic_prompt ?? "");
  const agent = needsAgent ? await resolveAgentName(admin, run.contact_id) : null;

  if (step.step_type === "template") {
    if (!step.template_name) throw new Error("template step missing template_name");
    const lang = step.template_language || "en";
    const params: Array<{ type: "text"; text: string }> = [];
    if (name) params.push({ type: "text", text: name });
    if (needsAgent && TWO_VAR_TEMPLATES.has(step.template_name)) {
      params.push({ type: "text", text: agent || "your counsellor" });
    }
    const bodyComp =
      params.length > 0 ? [{ type: "body", parameters: params }] : undefined;
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
  const body = renderVars(
    step.step_type === "magic" ? step.magic_prompt : step.text_body,
    name,
    agent,
  );
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
  // Prefer step_send_attempts; fall back if migration 0130 not applied yet.
  let due: RunRow[] | null = null;
  {
    const withAttempts = await admin
      .from("drip_runs")
      .select(
        "id, drip_id, contact_id, wa_id, business_phone_number_id, display_name, enrolled_stage, next_step_order, step_send_attempts, stop_reason",
      )
      .eq("status", "active")
      .lte("next_run_at", nowIso)
      .order("next_run_at", { ascending: true })
      .limit(50);
    if (
      withAttempts.error &&
      /step_send_attempts/i.test(withAttempts.error.message || "")
    ) {
      const base = await admin
        .from("drip_runs")
        .select(
          "id, drip_id, contact_id, wa_id, business_phone_number_id, display_name, enrolled_stage, next_step_order, stop_reason",
        )
        .eq("status", "active")
        .lte("next_run_at", nowIso)
        .order("next_run_at", { ascending: true })
        .limit(50);
      due = (base.data ?? []) as RunRow[];
    } else {
      due = (withAttempts.data ?? []) as RunRow[];
    }
  }

  const runs = due ?? [];
  result.scanned = runs.length;
  if (runs.length === 0) return result;

  // Load the drips + steps these runs reference.
  // Prefer trigger_stages; fall back if the column is missing so ticks don't
  // treat every run as drip_disabled.
  const dripIds = [...new Set(runs.map((r) => r.drip_id))];
  let drips: DripRow[] | null = null;
  {
    const withStages = await admin
      .from("drip_campaigns")
      .select(
        "id, name, business_phone_number_id, trigger_stage, trigger_stages, trigger_source, enabled, quiet_hours_start, quiet_hours_end",
      )
      .in("id", dripIds);
    if (
      withStages.error &&
      /trigger_stages/i.test(withStages.error.message || "")
    ) {
      const base = await admin
        .from("drip_campaigns")
        .select(
          "id, name, business_phone_number_id, trigger_stage, trigger_source, enabled, quiet_hours_start, quiet_hours_end",
        )
        .in("id", dripIds);
      drips = (base.data ?? []) as DripRow[];
    } else {
      drips = (withStages.data ?? []) as DripRow[];
    }
  }
  const { data: steps } = await admin
    .from("drip_steps")
    .select("*")
    .in("drip_id", dripIds)
    .order("step_order", { ascending: true });
  const dripById = new Map<string, DripRow>();
  for (const d of drips ?? []) dripById.set(d.id, d);
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

    // Stop guards — booked/visited/blocked, or stage moved off enrolled.
    if (run.contact_id) {
      const { data: ct } = await admin
        .from("contacts")
        .select("lsq_stage, bot_blocked_at")
        .eq("id", run.contact_id)
        .maybeSingle();
      if (ct?.bot_blocked_at) {
        await stop("blocked");
        continue;
      }
      const curStage = norm(ct?.lsq_stage as string | null);
      // Still in this drip's stage set → keep going. Left it (e.g. Warm → Booked
      // on a Qualified drip, or Booked → Visited on a Noshow drip) → stop.
      if (curStage) {
        const allowed = dripStageSet(drip as DripRow);
        if (allowed.size > 0 && !allowed.has(curStage)) {
          await stop("stage_changed");
          continue;
        }
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
      const waId = await sendStep(admin, run, step);
      await logDripSend(admin, run, step, waId);
      result.sent++;

      const next = all.find((s) => s.step_order === run.next_step_order + 1);
      const sentAttempts = priorStepAttempts(run);
      const patch: Record<string, unknown> = {
        last_sent_at: new Date().toISOString(),
        last_sent_step_order: run.next_step_order,
        // Preserve attempt count for delivery-fail; next step starts at 0.
        last_sent_attempts: sentAttempts,
        updated_at: new Date().toISOString(),
        step_send_attempts: 0,
        last_send_error: null,
        stop_reason: null,
      };
      if (next) {
        patch.next_step_order = next.step_order;
        patch.next_run_at = new Date(Date.now() + Math.max(0, next.delay_minutes) * 60_000).toISOString();
      } else {
        patch.status = "completed";
        result.completed++;
      }
      await updateDripRun(admin, run.id, patch);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "send failed";
      const outcome = await applyDripStepFailure(
        admin,
        run,
        errMsg,
        step.template_name ?? null,
      );
      if (outcome === "failed") result.failed++;
    }
  }

  return result;
}

/**
 * Meta accepted the send then reported delivery failed. Re-queue the same
 * drip step after 24h (or hard-stop + CRM task). Dedupes by wa_message_id.
 */
export async function handleDripOutboundDeliveryFailed(opts: {
  waMessageId: string;
  contactId: string;
  errorMessage: string | null;
  templateName?: string | null;
}): Promise<{ handled: boolean; reason?: string }> {
  const admin = createServiceRoleClient();
  const errMsg = (opts.errorMessage || "delivery failed").slice(0, 300);
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const { data: runs } = await admin
    .from("drip_runs")
    .select(
      "id, drip_id, contact_id, wa_id, business_phone_number_id, display_name, enrolled_stage, next_step_order, step_send_attempts, stop_reason, last_sent_step_order, last_sent_attempts, last_failed_wa_message_id, last_sent_at, status",
    )
    .eq("contact_id", opts.contactId)
    .in("status", ["active", "completed"])
    .gte("last_sent_at", since)
    .order("last_sent_at", { ascending: false })
    .limit(5);

  const run = ((runs ?? []) as Array<
    RunRow & {
      last_sent_step_order?: number | null;
      last_sent_attempts?: number | null;
      last_failed_wa_message_id?: string | null;
      status?: string;
    }
  >)[0];

  if (!run) return { handled: false, reason: "no_recent_drip_run" };
  if (run.last_failed_wa_message_id === opts.waMessageId) {
    return { handled: false, reason: "already_handled" };
  }

  const stepOrder =
    typeof run.last_sent_step_order === "number"
      ? run.last_sent_step_order
      : Math.max(1, (run.next_step_order || 1) - 1);

  let templateName = opts.templateName ?? null;
  if (!templateName) {
    const { data: steps } = await admin
      .from("drip_steps")
      .select("template_name, step_order")
      .eq("drip_id", run.drip_id)
      .eq("step_order", stepOrder)
      .maybeSingle();
    templateName = (steps?.template_name as string | null) ?? null;
  }

  // Continue the attempt counter from the accepted send (not the next step's 0).
  const runForFail: RunRow = {
    ...run,
    next_step_order: stepOrder,
    step_send_attempts:
      typeof run.last_sent_attempts === "number"
        ? run.last_sent_attempts
        : priorStepAttempts(run),
  };

  const outcome = await applyDripStepFailure(
    admin,
    runForFail,
    errMsg,
    templateName,
    { waMessageId: opts.waMessageId, stepOrder },
  );
  return { handled: true, reason: outcome };
}
