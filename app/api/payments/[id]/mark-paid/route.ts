// POST /api/payments/[id]/mark-paid
//
// Manual settlement for UPI direct payments (and any other case where
// the gateway webhook didn't fire). Flips status='created' → 'paid',
// stamps paid_at, and — if the auto-receipt toggle is on — triggers the
// PDF receipt send right away. The receipt button on the Payments
// section remains available afterwards for re-send.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { getAppSetting } from "@/lib/app-settings";
import { PAYMENTS_AUTO_RECEIPT_KEY, sendReceiptInternal } from "@/lib/payments";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Marking a payment paid is a financial action — require admin+ and scope
  // to a number the caller is allowed to act on (was previously open to ANY
  // authenticated session → financial IDOR).
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("payments")
    .select("id, status, receipt_sent_at, business_phone_number_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  const perms = await getEffectivePermissionsFor(member);
  if (
    perms.allowed_number_ids !== null &&
    row.business_phone_number_id &&
    !perms.allowed_number_ids.includes(row.business_phone_number_id)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (row.status === "paid") {
    return NextResponse.json({ ok: true, already_paid: true });
  }

  const ts = new Date().toISOString();
  const { error: updateErr } = await admin
    .from("payments")
    .update({ status: "paid", paid_at: ts, updated_at: ts })
    .eq("id", id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Auto-receipt — same path as the gateway webhook so the operator
  // doesn't have to click "Send receipt" separately when the toggle is
  // already on.
  const auto = (await getAppSetting(PAYMENTS_AUTO_RECEIPT_KEY)) === "true";
  let receiptSent = false;
  if (auto && !row.receipt_sent_at) {
    const r = await sendReceiptInternal(id);
    receiptSent = r.ok;
  }

  return NextResponse.json({ ok: true, receipt_sent: receiptSent });
}
