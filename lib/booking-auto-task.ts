// Auto-create OneInbox Tasks when a drip-enrolled, assigned contact
// clearly signals booking intent (BOOK / SHARE SLOTS / preferred slot / call).
//
// Scope (strict):
//   • Contact must have an active drip_run
//   • Contact must be assigned (contacts.assigned_to → team member, or
//     lsq_owner_email / lsq_owner_name mapped to a team member)
//   • No env fallback to Mantashaa / DRIP_PILOT_OWNER for random inbound

import { createServiceRoleClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createServiceRoleClient>;

/** Explicit booking / call intents — no bare yes/later/ready. */
const BOOKING_INTENT =
  /^(book|share\s*slots?|reschedule|preferred\s*date|call\s*me)$/i;

const CALL_INTENT = /^call\s*me$/i;

const DAY_OR_RELATIVE =
  /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|tomorrow|today|day\s*after)\b/i;

const MONTH_DATE =
  /\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/** Times like 4pm, 11 am, 10:30, 6.30 pm — not bare "5-8". */
const CLOCK_TIME =
  /\b\d{1,2}(?::|\.)\d{2}\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b/i;

const BOOKING_CONTEXT =
  /\b(?:slot|slots|appoint(?:ment)?|schedule|reschedule|book(?:ing)?|consult(?:ation)?|visit|available|availability|zenoti)\b/i;

const DEDUPE_LOOKBACK_HOURS = 72;

function endOfTodayIstIso(): string {
  // Due today end-of-day IST (UTC+5:30).
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  ist.setUTCHours(18, 29, 59, 999); // 23:59:59.999 IST as UTC clock on IST day
  return new Date(ist.getTime() - 5.5 * 60 * 60 * 1000).toISOString();
}

function normalizeIntent(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function detectBookingSignal(inboundText: string): {
  kind: "book" | "call" | "slots" | null;
  slotsSnippet: string | null;
} {
  const raw = normalizeIntent(inboundText);
  if (!raw) return { kind: null, slotsSnippet: null };

  // Cap free-text scan; still allow long messages that clearly book a slot.
  if (raw.length > 500 && !looksLikeSlotRequest(raw)) {
    return { kind: null, slotsSnippet: null };
  }

  const compact = raw.replace(/[^\w\s]/g, "").trim();

  if (CALL_INTENT.test(compact)) {
    return { kind: "call", slotsSnippet: null };
  }
  if (BOOKING_INTENT.test(compact)) {
    return { kind: "book", slotsSnippet: null };
  }
  if (looksLikeSlotRequest(raw)) {
    return { kind: "slots", slotsSnippet: raw.slice(0, 280) };
  }
  return { kind: null, slotsSnippet: null };
}

/** Day/date + (clock time OR booking words). Drops loose "5-8", bare "tomorrow", yes. */
function looksLikeSlotRequest(raw: string): boolean {
  const hasWhen = DAY_OR_RELATIVE.test(raw) || MONTH_DATE.test(raw);
  if (!hasWhen) return false;
  return CLOCK_TIME.test(raw) || BOOKING_CONTEXT.test(raw);
}

async function contactHasActiveDrip(
  admin: Admin,
  contactId: string,
  waId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("drip_runs")
    .select("id")
    .eq("status", "active")
    .or(`contact_id.eq.${contactId},wa_id.eq.${waId}`)
    .limit(1)
    .maybeSingle();
  return Boolean(data?.id);
}

async function resolveAssigneeFromContact(
  admin: Admin,
  contact: {
    assigned_to: string | null;
    lsq_owner_email: string | null;
    lsq_owner_name: string | null;
  },
): Promise<{ memberId: string; label: string } | null> {
  // 1) Dashboard assignee (auth user_id → team_members.id)
  if (contact.assigned_to) {
    const { data } = await admin
      .from("team_members")
      .select("id, full_name, first_name, email")
      .eq("user_id", contact.assigned_to)
      .eq("is_active", true)
      .maybeSingle();
    if (data?.id) {
      const label =
        (data.full_name as string | null)?.trim() ||
        (data.first_name as string | null)?.trim() ||
        (data.email as string);
      return { memberId: data.id as string, label };
    }
  }

  // 2) CRM owner email / name → team member (no Mantashaa env dump)
  const emailNeedle = (contact.lsq_owner_email || "").trim().toLowerCase();
  const nameNeedle = (contact.lsq_owner_name || "").trim().toLowerCase();
  if (!emailNeedle && !nameNeedle) return null;

  const { data: rows } = await admin
    .from("team_members")
    .select("id, full_name, first_name, email")
    .eq("is_active", true)
    .limit(300);

  const match = (
    (rows ?? []) as Array<{
      id: string;
      full_name: string | null;
      first_name: string | null;
      email: string;
    }>
  ).find((r) => {
    const email = (r.email || "").toLowerCase();
    const full = (r.full_name || "").trim().toLowerCase();
    const first = (r.first_name || "").trim().toLowerCase();
    if (emailNeedle && email && email === emailNeedle) return true;
    if (!nameNeedle) return false;
    if (full && (full === nameNeedle || full.startsWith(nameNeedle))) return true;
    if (first && first === nameNeedle.split(/\s+/)[0]) return true;
    if (full && full.split(/\s+/)[0] === nameNeedle.split(/\s+/)[0]) return true;
    return false;
  });

  if (!match) return null;
  const label =
    match.full_name?.trim() || match.first_name?.trim() || match.email;
  return { memberId: match.id, label };
}

function isAutoBookingTask(title: string, description: string | null): boolean {
  const tl = title.toLowerCase();
  if (
    tl.startsWith("book zenoti") ||
    tl.startsWith("call client") ||
    tl.includes("zenoti")
  ) {
    return true;
  }
  return (description || "").startsWith("Auto-created from WhatsApp reply.");
}

/**
 * If inbound looks like a booking / slot / call signal from a drip-enrolled
 * assigned contact, create (or refresh) an open task. Never throws.
 */
export async function maybeCreateBookingTask(opts: {
  contactId: string;
  waId: string;
  bpid: string | null;
  inboundText: string;
}): Promise<{ created: boolean; taskId?: string; reason?: string }> {
  try {
    const signal = detectBookingSignal(opts.inboundText);
    if (!signal.kind) return { created: false, reason: "no_signal" };

    const admin = createServiceRoleClient();

    const { data: contact } = await admin
      .from("contacts")
      .select(
        "id, name, profile_name, assigned_to, wa_id, lsq_owner_email, lsq_owner_name",
      )
      .eq("id", opts.contactId)
      .maybeSingle();
    if (!contact) return { created: false, reason: "contact_missing" };

    // Gate 1: active drip campaign only (not every inbound on the number).
    const onDrip = await contactHasActiveDrip(
      admin,
      opts.contactId,
      opts.waId,
    );
    if (!onDrip) return { created: false, reason: "not_on_active_drip" };

    // Gate 2: must resolve a real assignee from contact — no pilot fallback.
    const assignee = await resolveAssigneeFromContact(admin, {
      assigned_to: (contact.assigned_to as string | null) ?? null,
      lsq_owner_email: (contact.lsq_owner_email as string | null) ?? null,
      lsq_owner_name: (contact.lsq_owner_name as string | null) ?? null,
    });
    if (!assignee) {
      return { created: false, reason: "not_assigned" };
    }

    const clientName =
      ((contact.name as string | null) ?? "").trim() ||
      ((contact.profile_name as string | null) ?? "").trim() ||
      opts.waId;

    const slots =
      signal.slotsSnippet ||
      (signal.kind === "book"
        ? "Client asked to BOOK — confirm slot"
        : null) ||
      (signal.kind === "call"
        ? "Client asked to be called"
        : "Confirm preferred time");

    const title =
      signal.kind === "call"
        ? `Call client — ${clientName}`.slice(0, 200)
        : `Book Zenoti — ${clientName} — ${slots}`.slice(0, 200);

    const description = [
      `Auto-created from WhatsApp reply.`,
      `Client: ${clientName}`,
      `Phone: ${opts.waId}`,
      `Reply: ${normalizeIntent(opts.inboundText).slice(0, 500)}`,
      `Action: Book / confirm in Zenoti, then mark Done and update CRM stage.`,
    ].join("\n");

    // Dedupe: any open/in_progress auto-booking task for this contact (72h+).
    const since = new Date(
      Date.now() - DEDUPE_LOOKBACK_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const { data: existing } = await admin
      .from("tasks")
      .select("id, title, description, created_at")
      .eq("contact_id", opts.contactId)
      .in("status", ["open", "in_progress"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20);

    const openAuto = (
      (existing ?? []) as Array<{
        id: string;
        title: string;
        description: string | null;
      }>
    ).filter((t) => isAutoBookingTask(t.title, t.description));

    const prior = openAuto[0] ?? null;

    if (prior) {
      await admin
        .from("tasks")
        .update({
          title,
          description,
          priority: signal.kind === "call" ? "high" : "urgent",
          assigned_to: assignee.memberId,
          due_at: endOfTodayIstIso(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", prior.id);

      // Collapse race duplicates (same contact, still open).
      const dupIds = openAuto.slice(1).map((t) => t.id);
      if (dupIds.length) {
        await admin
          .from("tasks")
          .update({
            status: "cancelled",
            updated_at: new Date().toISOString(),
          })
          .in("id", dupIds);
      }

      return { created: false, taskId: prior.id, reason: "updated_existing" };
    }

    const { data: inserted, error } = await admin
      .from("tasks")
      .insert({
        title,
        description,
        status: "open",
        priority: signal.kind === "call" ? "high" : "urgent",
        assigned_to: assignee.memberId,
        created_by: null,
        contact_id: opts.contactId,
        business_phone_number_id: opts.bpid || null,
        due_at: endOfTodayIstIso(),
      })
      .select("id")
      .single();

    if (error) {
      console.warn("[booking-auto-task] insert failed:", error.message);
      return { created: false, reason: error.message };
    }

    // Post-insert race fold: if another open auto-task appeared, keep oldest.
    const { data: after } = await admin
      .from("tasks")
      .select("id, title, description, created_at")
      .eq("contact_id", opts.contactId)
      .in("status", ["open", "in_progress"])
      .order("created_at", { ascending: true })
      .limit(10);

    const autos = (
      (after ?? []) as Array<{
        id: string;
        title: string;
        description: string | null;
      }>
    ).filter((t) => isAutoBookingTask(t.title, t.description));

    if (autos.length > 1) {
      const keep = autos[0]!;
      const drop = autos.slice(1).map((t) => t.id);
      await admin
        .from("tasks")
        .update({
          title,
          description,
          priority: signal.kind === "call" ? "high" : "urgent",
          assigned_to: assignee.memberId,
          due_at: endOfTodayIstIso(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", keep.id);
      await admin
        .from("tasks")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .in("id", drop);
      return { created: false, taskId: keep.id, reason: "merged_race" };
    }

    return {
      created: true,
      taskId: (inserted as { id: string }).id,
    };
  } catch (e) {
    console.warn(
      "[booking-auto-task] failed:",
      e instanceof Error ? e.message : e,
    );
    return { created: false, reason: "exception" };
  }
}
