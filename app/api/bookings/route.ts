// POST /api/bookings
//   { contact_id }          → create a pending booking, return the public link
//   { contact_id, date }    → agent aligns a date directly (confirm now)
//
// Agent-only (logged-in member). The public client flow lives under
// /api/book/[token].

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import {
  generateBookingToken,
  finalizeBooking,
  type BookingRow,
} from "@/lib/bookings";
import { sendBookingLink, notifyBookingConfirmed } from "@/lib/booking-notify";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const perms = await getEffectivePermissionsFor(member);
  if (!perms.can_align_dates) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  let body: {
    contact_id?: string;
    date?: string;
    send_link?: boolean;
    title?: string;
    color?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const contactId = body.contact_id?.trim();
  const date = body.date?.trim() || null;
  // Agent-typed calendar event title + colour (colorId "1"–"11").
  const title = body.title?.trim() || null;
  const colorId = /^(?:[1-9]|1[01])$/.test(body.color ?? "") ? body.color! : null;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, name, profile_name, business_phone_number_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const token = generateBookingToken();
  const { data: inserted, error } = await admin
    .from("bookings")
    .insert({
      token,
      contact_id: contact.id,
      business_phone_number_id: contact.business_phone_number_id,
      wa_id: contact.wa_id,
      patient_name: contact.name ?? contact.profile_name ?? null,
      status: "pending",
      created_by_user_id: member.user_id ?? null,
      created_by_email: member.email ?? null,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    })
    .select("*")
    .single();
  if (error || !inserted) {
    return NextResponse.json({ error: "Could not create booking" }, { status: 500 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const link = `${base}/book/${token}`;

  // Agent aligned a date directly → confirm it now (+ notify the client).
  if (date) {
    const res = await finalizeBooking(admin, inserted as BookingRow, date, "agent", {
      title,
      colorId,
    });
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 409 });
    }
    void notifyBookingConfirmed(admin, res.booking!).catch(() => {});
    return NextResponse.json({ booking: res.booking, link });
  }

  // Otherwise it's a pending link. Optionally WhatsApp it to the client now.
  if (body.send_link) {
    void sendBookingLink(admin, inserted as BookingRow, link).catch(() => {});
  }

  return NextResponse.json({ booking: inserted, link });
}
