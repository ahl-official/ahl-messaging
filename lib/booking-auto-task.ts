// Auto-create OneInbox Tasks when a client signals booking intent
// (BOOK / SHARE SLOTS / preferred date-time / etc.). Assigned to the
// contact's CRM owner when possible, else DRIP_PILOT_OWNER (Mantashaa).

import { createServiceRoleClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createServiceRoleClient>;

/** Quick-reply / keyword intents from Task 2 templates. */
const BOOKING_INTENT =
  /^(book|share\s*slots?|reschedule|preferred\s*date|ready|call\s*me|call|yes|later)$/i;

const CALL_INTENT = /^(call\s*me|call)$/i;

/** Free-text that looks like preferred slots (Sat 4pm, Sun 11am, 26 Nov 3pm…). */
const SLOT_HINT =
  /\b(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?\b|\b(?:tomorrow|today|day\s*after)\b|\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

const DEDUPE_HOURS = 24;

function endOfTodayIstIso(): string {
  // Due today end-of-day IST (UTC+5:30).
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  ist.setUTCHours(18, 29, 59, 999); // 23:59:59.999 IST
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
  if (!raw || raw.length > 500) {
    // Still allow long messages if they clearly contain slots.
    if (raw.length > 500 && SLOT_HINT.test(raw)) {
      return { kind: "slots", slotsSnippet: raw.slice(0, 280) };
    }
    return { kind: null, slotsSnippet: null };
  }

  const compact = raw.replace(/[^\w\s]/g, "").trim();
  if (CALL_INTENT.test(compact)) {
    return { kind: "call", slotsSnippet: null };
  }
  if (BOOKING_INTENT.test(compact)) {
    return { kind: "book", slotsSnippet: null };
  }
  if (SLOT_HINT.test(raw)) {
    return { kind: "slots", slotsSnippet: raw.slice(0, 280) };
  }
  return { kind: null, slotsSnippet: null };
}

async function resolveAssigneeMemberId(
  admin: Admin,
  contactAssignedAuthUserId: string | null,
): Promise<{ memberId: string; label: string } | null> {
  // 1) Contact's CRM/WA assignee (auth user_id → team_members.id)
  if (contactAssignedAuthUserId) {
    const { data } = await admin
      .from("team_members")
      .select("id, full_name, first_name, email")
      .eq("user_id", contactAssignedAuthUserId)
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

  // 2) DRIP_PILOT_OWNER / BOOKING_TASK_ASSIGNEE (display name or email)
  const needle = (
    process.env.BOOKING_TASK_ASSIGNEE ||
    process.env.DRIP_PILOT_OWNER ||
    "Mantashaa"
  )
    .trim()
    .toLowerCase();
  if (!needle || needle === "*") return null;

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
    if (email && email === needle) return true;
    if (full && (full === needle || full.startsWith(needle) || needle.startsWith(full)))
      return true;
    if (first && first === needle) return true;
    if (full && full.split(/\s+/)[0] === needle) return true;
    return false;
  });

  if (!match) return null;
  const label =
    match.full_name?.trim() || match.first_name?.trim() || match.email;
  return { memberId: match.id, label };
}

/**
 * If inbound looks like a booking / slot / call signal, create (or refresh)
 * an open task for the CRM agent. Never throws.
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
      .select("id, name, profile_name, assigned_to, wa_id")
      .eq("id", opts.contactId)
      .maybeSingle();
    if (!contact) return { created: false, reason: "contact_missing" };

    const clientName =
      ((contact.name as string | null) ?? "").trim() ||
      ((contact.profile_name as string | null) ?? "").trim() ||
      opts.waId;

    const assignee = await resolveAssigneeMemberId(
      admin,
      (contact.assigned_to as string | null) ?? null,
    );
    if (!assignee) {
      console.warn(
        "[booking-auto-task] no assignee (set DRIP_PILOT_OWNER or assign contact)",
      );
      return { created: false, reason: "no_assignee" };
    }

    const replyNorm = normalizeIntent(opts.inboundText);
    const isVagueYes =
      /^(yes|later|ready)$/i.test(replyNorm.replace(/[^\w\s]/g, "").trim()) &&
      !signal.slotsSnippet;

    const slots =
      signal.slotsSnippet ||
      (signal.kind === "book"
        ? isVagueYes
          ? "Client said YES — confirm & book in Zenoti"
          : "Client asked to BOOK — confirm slot"
        : null) ||
      (signal.kind === "call" ? "Client asked to be called" : "Confirm preferred time");

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

    // Dedupe: refresh an open booking/call task for this contact (24h).
    const since = new Date(
      Date.now() - DEDUPE_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const { data: existing } = await admin
      .from("tasks")
      .select("id, title")
      .eq("contact_id", opts.contactId)
      .in("status", ["open", "in_progress"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);

    const prior = (
      (existing ?? []) as Array<{ id: string; title: string }>
    ).find((t) => {
      const tl = t.title.toLowerCase();
      return (
        tl.startsWith("book zenoti") ||
        tl.startsWith("call client") ||
        tl.includes("zenoti")
      );
    });

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
