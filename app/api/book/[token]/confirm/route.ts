// POST /api/book/[token]/confirm  { date: "YYYY-MM-DD" } — public.
// The client picked a date. Re-validate availability, write the Google
// Calendar event, mark confirmed. No auth (token is the credential).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { finalizeBooking, type BookingRow } from "@/lib/bookings";
import { notifyBookingConfirmed } from "@/lib/booking-notify";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  const token = params.token?.trim();
  if (!token) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { date?: string };
  try {
    body = (await request.json()) as { date?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const date = body.date?.trim();
  if (!date) return NextResponse.json({ error: "date is required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: booking } = await admin
    .from("bookings")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!booking) {
    return NextResponse.json({ error: "Invalid link." }, { status: 404 });
  }
  if (
    booking.status === "pending" &&
    booking.expires_at &&
    new Date(booking.expires_at).getTime() < Date.now()
  ) {
    return NextResponse.json({ error: "This link has expired." }, { status: 410 });
  }

  const res = await finalizeBooking(admin, booking as BookingRow, date, "client");
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 409 });
  }

  // Best-effort: WhatsApp confirmation template + CRM push + chat bubble.
  void notifyBookingConfirmed(admin, res.booking!).catch(() => {});

  return NextResponse.json({ status: "confirmed", booking_date: date });
}
