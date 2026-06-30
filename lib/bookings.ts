// Booking availability + helpers for the "Date Align" feature.
//
// Available days = next BOOKING_WINDOW_DAYS days, minus: weekly-offs, days the
// clinic's Google Calendar marks blocked (an all-day event whose title matches
// holiday/closed/off/block/leave), and days already at capacity (count of
// confirmed bookings in our DB). When Google creds aren't set, the calendar
// step is simply skipped (no blocked days) so the flow still works for testing.
//
// Config via env (Settings UI can override later):
//   BOOKING_CAPACITY_PER_DAY  default 3
//   BOOKING_WINDOW_DAYS       default 60
//   BOOKING_WEEKLY_OFF        comma day-numbers, 0=Sun … 6=Sat; default "0"

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listCalendarEvents, createCalendarEvent } from "@/lib/google-calendar";

export interface BookingRow {
  id: string;
  token: string;
  contact_id: string | null;
  business_phone_number_id: string | null;
  wa_id: string | null;
  patient_name: string | null;
  booking_date: string | null;
  status: string;
}

// Per-day booking cap. 0 (the default) = NO cap — a date stays bookable no
// matter how many appointments it already has, so agents can keep adding
// multiple to the same day. Set BOOKING_CAPACITY_PER_DAY to a positive number
// only if the clinic wants to close a day once it hits that many bookings.
export const BOOKING_CAPACITY = Number(process.env.BOOKING_CAPACITY_PER_DAY || 0);
export const BOOKING_WINDOW_DAYS = Number(process.env.BOOKING_WINDOW_DAYS || 180);
const WEEKLY_OFF = new Set(
  (process.env.BOOKING_WEEKLY_OFF ?? "0")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n)),
);
const BLOCK_RE = /holiday|closed|off\b|block|leave/i;

export function generateBookingToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/** Clock time (IST) for a timed calendar event, e.g. "10:30". Null for all-day. */
function clockTime(iso: string): string | null {
  try {
    return new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    });
  } catch {
    return null;
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** All bookable dates (YYYY-MM-DD) within the window, in chronological order. */
export interface Availability {
  /** Bookable dates (weekly-offs, holiday-blocked + at-capacity removed). */
  available: string[];
  /** Per-date appointment LOAD — confirmed app bookings + any non-blocking
   *  Google Calendar events on that day. Lets the agent calendar show "how
   *  many are already booked" per date. */
  load: Record<string, number>;
  /** Per-date event titles (what's written on the calendar that day) so the
   *  agent calendar can show the actual text, not just a count. */
  details: Record<string, string[]>;
  /** Per-date capacity ceiling, so the UI can show "2/3". */
  capacity: number;
}

export async function getAvailability(admin: SupabaseClient): Promise<Availability> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  // Candidate days: tomorrow … +window, dropping weekly-offs.
  const candidates: string[] = [];
  for (let i = 1; i <= BOOKING_WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (!WEEKLY_OFF.has(d.getUTCDay())) candidates.push(ymd(d));
  }
  if (candidates.length === 0)
    return { available: [], load: {}, details: {}, capacity: BOOKING_CAPACITY };

  // Google Calendar events in the window (no-op if Google not configured).
  const timeMin = new Date(start);
  timeMin.setUTCDate(timeMin.getUTCDate() + 1);
  const timeMax = new Date(start);
  timeMax.setUTCDate(timeMax.getUTCDate() + BOOKING_WINDOW_DAYS + 1);
  const events = await listCalendarEvents(timeMin.toISOString(), timeMax.toISOString());

  const blocked = new Set<string>();
  const load: Record<string, number> = {};
  const details: Record<string, string[]> = {};
  for (const e of events) {
    const day = e.allDayDate ?? (e.startIso ? e.startIso.slice(0, 10) : null);
    if (!day) continue;
    if (e.allDayDate && BLOCK_RE.test(e.summary)) {
      blocked.add(day); // holiday / closed — not an appointment
    } else {
      load[day] = (load[day] ?? 0) + 1; // a real appointment on the calendar
      const t = e.startIso ? clockTime(e.startIso) : null;
      const text = e.summary || "(untitled)";
      (details[day] ??= []).push(t ? `${t} · ${text}` : text); // time + event text
    }
  }

  // Capacity: confirmed app bookings per day (also counts toward load).
  const { data } = await admin
    .from("bookings")
    .select("booking_date")
    .eq("status", "confirmed")
    .gte("booking_date", candidates[0])
    .lte("booking_date", candidates[candidates.length - 1]);
  // DB confirmed bookings — used for the capacity gate. They also sync to the
  // calendar, so they're already counted in `load`/`details` above; we only
  // add them to load/details here when Google isn't configured (no events).
  const dbCounts = new Map<string, number>();
  const noGoogle = events.length === 0;
  for (const r of (data ?? []) as Array<{ booking_date: string | null }>) {
    if (r.booking_date) {
      dbCounts.set(r.booking_date, (dbCounts.get(r.booking_date) ?? 0) + 1);
      if (noGoogle) load[r.booking_date] = (load[r.booking_date] ?? 0) + 1;
    }
  }

  // Only drop a day for a weekly-off / holiday block (or, when a cap is set,
  // once it's reached). With BOOKING_CAPACITY = 0 (default) a day never fills
  // up, so agents can add multiple appointments to the same date.
  const available = candidates.filter(
    (ds) =>
      !blocked.has(ds) &&
      (BOOKING_CAPACITY <= 0 || (dbCounts.get(ds) ?? 0) < BOOKING_CAPACITY),
  );
  return { available, load, details, capacity: BOOKING_CAPACITY };
}

/** Back-compat: just the bookable dates. */
export async function getAvailableDates(admin: SupabaseClient): Promise<string[]> {
  return (await getAvailability(admin)).available;
}

/** True if a specific date is still bookable (re-checked at confirm time so a
 *  slot can't be double-booked between page-load and submit). */
export async function isDateAvailable(
  admin: SupabaseClient,
  date: string,
): Promise<boolean> {
  const all = await getAvailableDates(admin);
  return all.includes(date);
}

/** Lock in a date for a booking: re-validate availability, write the Google
 *  Calendar event, and mark the booking confirmed. Shared by the agent (align
 *  directly) and patient (public link) paths. Notification (WhatsApp template +
 *  LSQ push + chat bubble) is a separate, config-gated step handled by the
 *  caller. */
export async function finalizeBooking(
  admin: SupabaseClient,
  booking: BookingRow,
  date: string,
  source: "agent" | "patient",
  opts?: { title?: string | null; colorId?: string | null },
): Promise<{ ok: boolean; error?: string; booking?: BookingRow }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "Invalid date." };
  }
  if (booking.status === "confirmed") {
    return { ok: false, error: "This booking is already confirmed." };
  }
  if (!(await isDateAvailable(admin, date))) {
    return { ok: false, error: "Sorry, that date is no longer available." };
  }

  const who = booking.patient_name?.trim() || booking.wa_id || "Patient";
  const eventId = await createCalendarEvent({
    date,
    // Agent-typed title wins; else a sensible default.
    summary: opts?.title?.trim() || `Booking — ${who}`,
    description: `WhatsApp: ${booking.wa_id ?? ""}\nBooked via: ${source}`,
    colorId: opts?.colorId ?? undefined,
  });

  const { data: updated, error } = await admin
    .from("bookings")
    .update({
      booking_date: date,
      status: "confirmed",
      source,
      confirmed_at: new Date().toISOString(),
      gcal_event_id: eventId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", booking.id)
    .eq("status", "pending") // CAS: don't double-confirm
    .select("*")
    .single();

  if (error || !updated) {
    return { ok: false, error: "Could not save the booking." };
  }
  return { ok: true, booking: updated as BookingRow };
}
