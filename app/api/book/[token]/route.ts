// GET /api/book/[token] — public. Returns the booking's state + the list of
// available dates so the patient page can render a date picker. No auth.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAvailableDates } from "@/lib/bookings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } },
) {
  const token = params.token?.trim();
  if (!token) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createServiceRoleClient();
  const { data: booking } = await admin
    .from("bookings")
    .select("token, patient_name, status, booking_date, expires_at, business_phone_number_id")
    .eq("token", token)
    .maybeSingle();

  if (!booking) {
    return NextResponse.json({ error: "This booking link is invalid." }, { status: 404 });
  }
  if (booking.status === "cancelled") {
    return NextResponse.json({ status: "cancelled", patient_name: booking.patient_name });
  }
  if (
    booking.status === "pending" &&
    booking.expires_at &&
    new Date(booking.expires_at).getTime() < Date.now()
  ) {
    return NextResponse.json({ status: "expired", patient_name: booking.patient_name });
  }

  // Clinic label for the page header.
  let clinic = "our clinic";
  if (booking.business_phone_number_id) {
    const { data: bn } = await admin
      .from("business_numbers")
      .select("nickname, verified_name")
      .eq("phone_number_id", booking.business_phone_number_id)
      .maybeSingle();
    clinic = bn?.nickname?.trim() || bn?.verified_name?.trim() || clinic;
  }

  if (booking.status === "confirmed") {
    return NextResponse.json({
      status: "confirmed",
      patient_name: booking.patient_name,
      booking_date: booking.booking_date,
      clinic,
    });
  }

  const dates = await getAvailableDates(admin);
  return NextResponse.json({
    status: "pending",
    patient_name: booking.patient_name,
    clinic,
    available_dates: dates,
  });
}
