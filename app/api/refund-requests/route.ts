// POST /api/refund-requests
//
// Operator submits a refund request from the contact-details panel.
// The screenshot has already been uploaded to the `refund-screenshots`
// bucket by the browser client; this endpoint just stamps the metadata
// row + cached agent / lead / patient info so a later LSQ change
// doesn't rewrite history.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { memberDisplayName } from "@/lib/team-types";

export const runtime = "nodejs";

const REASON_CODES = new Set([
  "cancelled_by_patient",
  "medical_reasons",
  "surgery_rescheduled",
  "duplicate_payment",
  "service_not_delivered",
  "other",
]);

interface Body {
  contact_id?: string;
  lsq_lead_number?: string | null;
  lsq_prospect_id?: string | null;
  patient_name?: string | null;
  booking_date?: string | null;
  per_graft_rate?: number | string | null;
  estimated_grafts?: number | string | null;
  booking_amount?: number | string | null;
  refundable_amount?: number | string | null;
  reason_code?: string;
  reason_other?: string | null;
  payment_screenshot_path?: string | null;
  payment_screenshot_url?: string | null;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const contactId = body.contact_id?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  }
  const reasonCode = body.reason_code?.trim() ?? "";
  if (!REASON_CODES.has(reasonCode)) {
    return NextResponse.json({ error: "Invalid reason_code" }, { status: 400 });
  }
  if (reasonCode === "other" && !body.reason_other?.trim()) {
    return NextResponse.json(
      { error: "reason_other required when reason_code = other" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();

  // Confirm the contact exists before stamping a row that references it.
  const { data: contactRow } = await admin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contactRow) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const insert = {
    contact_id: contactId,
    requested_by_user_id: member.user_id ?? null,
    requested_by_email: member.email ?? null,
    requested_by_name: memberDisplayName(member) ?? null,
    lsq_lead_number: body.lsq_lead_number?.trim() || null,
    lsq_prospect_id: body.lsq_prospect_id?.trim() || null,
    patient_name: body.patient_name?.trim() || null,
    booking_date: body.booking_date || null,
    per_graft_rate: toNum(body.per_graft_rate),
    estimated_grafts: toNum(body.estimated_grafts),
    booking_amount: toNum(body.booking_amount),
    refundable_amount: toNum(body.refundable_amount),
    reason_code: reasonCode,
    reason_other: body.reason_other?.trim() || null,
    payment_screenshot_path: body.payment_screenshot_path?.trim() || null,
    payment_screenshot_url: body.payment_screenshot_url?.trim() || null,
  };

  const { data, error } = await admin
    .from("refund_requests")
    .insert(insert)
    .select("id, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, refund_request: data });
}
