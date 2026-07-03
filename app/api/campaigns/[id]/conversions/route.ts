// GET /api/campaigns/[id]/conversions
//
// Post-campaign LSQ conversion tracking. Reads each recipient's CURRENT
// lsq_stage from the local `contacts` table (kept fresh by the CRM webhook),
// so it covers ALL recipients cheaply and can auto-refresh:
//   • Package bucket (HT Done / Order Placed) → Total Package value + notes.
//   • Order bucket   (Order Confirmed)        → Order Value (Revenue).
// Values are stored on the contact; any conversion-stage contact still
// missing a value is backfilled from LSQ (bounded per request) so it
// self-heals over a few refreshes.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { lsqGetLeadRawByPhone } from "@/lib/lsq";

export const runtime = "nodejs";
export const maxDuration = 60;

const PACKAGE_STAGES = ["ht done", "order placed"];
const ORDER_STAGES = ["order confirmed"];
const BOOKING_STAGES = ["booking done"];
// Max LSQ backfill calls per request (rate-limited) — fills missing values
// gradually across refreshes.
const BACKFILL_CAP = 25;

const num = (v: unknown): number => {
  const n = Number((v ?? "").toString().replace(/[^\d.-]/g, ""));
  return isNaN(n) ? 0 : n;
};

interface ContactRow {
  id: string;
  wa_id: string;
  lsq_stage: string | null;
  lsq_total_package: number | null;
  lsq_order_value: number | null;
  lsq_sales_notes: string | null;
  lsq_booking_amount: number | null;
  lsq_booking_date: string | null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const admin = createServiceRoleClient();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, business_phone_number_id")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const bpid = campaign.business_phone_number_id as string;

  const { data: recipients } = await admin
    .from("campaign_recipients")
    .select("wa_id, display_name")
    .eq("campaign_id", id)
    .limit(5000);
  const waIds = [...new Set((recipients ?? []).map((r) => r.wa_id as string).filter(Boolean))];
  const nameByWa = new Map<string, string | null>();
  for (const r of recipients ?? []) {
    if (!nameByWa.has(r.wa_id as string)) nameByWa.set(r.wa_id as string, (r.display_name as string | null) ?? null);
  }
  if (waIds.length === 0) {
    return NextResponse.json({
      total_recipients: 0,
      package: { count: 0, total_value: 0, items: [] },
      order: { count: 0, total_value: 0, items: [] },
    });
  }

  // Local read — current stage + stored values for every recipient.
  const { data: contacts } = await admin
    .from("contacts")
    .select("id, wa_id, lsq_stage, lsq_total_package, lsq_order_value, lsq_sales_notes, lsq_booking_amount, lsq_booking_date")
    .eq("business_phone_number_id", bpid)
    .in("wa_id", waIds);
  const rows = (contacts ?? []) as ContactRow[];

  // Backfill missing values for conversion-stage contacts (bounded).
  let backfilled = 0;
  for (const c of rows) {
    if (backfilled >= BACKFILL_CAP) break;
    const low = (c.lsq_stage ?? "").trim().toLowerCase();
    const isPkg = PACKAGE_STAGES.includes(low);
    const isOrder = ORDER_STAGES.includes(low);
    const isBooking = BOOKING_STAGES.includes(low);
    if (!isPkg && !isOrder && !isBooking) continue;
    const missing =
      (isPkg && c.lsq_total_package == null) ||
      (isOrder && c.lsq_order_value == null) ||
      (isBooking && c.lsq_booking_amount == null);
    if (!missing) continue;
    const lead = await lsqGetLeadRawByPhone(c.wa_id);
    backfilled++;
    if (!lead) continue;
    const pkg = num(lead["mx_total_package"]) || num(lead["mx_booking_amount"]);
    const ord = num(lead["revenue"]) || num(lead["mx_total_order"]);
    const booking = num(lead["mx_booking_amount"]);
    const bookingDate = lead["mx_booking_date"] || lead["booking_date"] || lead["mx_booking__date"] || null;
    const notes = lead["mx_sales_notes"] ?? null;
    c.lsq_total_package = pkg;
    c.lsq_order_value = ord;
    c.lsq_booking_amount = booking;
    c.lsq_booking_date = bookingDate;
    c.lsq_sales_notes = notes;
    await admin
      .from("contacts")
      .update({
        lsq_total_package: pkg,
        lsq_order_value: ord,
        lsq_booking_amount: booking,
        lsq_booking_date: bookingDate,
        lsq_sales_notes: notes,
      })
      .eq("id", c.id);
  }

  type PkgItem = { wa_id: string; name: string | null; package_value: number; notes: string | null };
  const htDoneItems: PkgItem[] = [];
  const orderPlacedItems: PkgItem[] = [];
  const orderItems: Array<{ wa_id: string; name: string | null; order_value: number; confirmed_date: string | null }> = [];
  const bookedItems: Array<{ wa_id: string; name: string | null; booking_amount: number; booking_date: string | null }> = [];
  for (const c of rows) {
    const stage = (c.lsq_stage ?? "").trim();
    const low = stage.toLowerCase();
    if (low === "ht done" || low === "order placed") {
      const item: PkgItem = {
        wa_id: c.wa_id,
        name: nameByWa.get(c.wa_id) ?? null,
        package_value: num(c.lsq_total_package),
        notes: c.lsq_sales_notes,
      };
      (low === "ht done" ? htDoneItems : orderPlacedItems).push(item);
    } else if (ORDER_STAGES.includes(low)) {
      orderItems.push({
        wa_id: c.wa_id,
        name: nameByWa.get(c.wa_id) ?? null,
        order_value: num(c.lsq_order_value),
        confirmed_date: null,
      });
    }
    // Booked — anyone with a booking amount OR at the "Booking Done" stage
    // (independent of pkg/order bucket; a booked lead may also have a package).
    if (num(c.lsq_booking_amount) > 0 || BOOKING_STAGES.includes(low)) {
      bookedItems.push({
        wa_id: c.wa_id,
        name: nameByWa.get(c.wa_id) ?? null,
        booking_amount: num(c.lsq_booking_amount),
        booking_date: c.lsq_booking_date,
      });
    }
  }

  const pkgBucket = (items: PkgItem[]) => ({
    count: items.length,
    total_value: items.reduce((s, i) => s + i.package_value, 0),
    items,
  });

  return NextResponse.json({
    total_recipients: waIds.length,
    backfilled,
    ht_done: pkgBucket(htDoneItems),
    order_placed: pkgBucket(orderPlacedItems),
    order: {
      count: orderItems.length,
      total_value: orderItems.reduce((s, i) => s + i.order_value, 0),
      items: orderItems,
    },
    booked: {
      count: bookedItems.length,
      total_value: bookedItems.reduce((s, i) => s + i.booking_amount, 0),
      items: bookedItems,
    },
  });
}
