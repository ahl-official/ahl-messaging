// GET  /api/settings/payments  → { accounts: [...with .clinic], auto_receipt: {americanhairline, alchemane}, webhook_base_url }
// PUT  /api/settings/payments  → body { auto_receipt_americanhairline?: bool, auto_receipt_alchemane?: bool }
//                                 (account-active flips go through the dedicated routes below)
//
// Owner / superadmin only.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getAppSetting, setAppSetting } from "@/lib/app-settings";
import { listPaymentAccounts, CLINICS } from "@/lib/payment-accounts";
import {
  PAYMENTS_AUTO_RECEIPT_KEY,
  paymentsAutoReceiptKey,
} from "@/lib/payments";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner" && me.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [accounts, legacyReceipt, ...perClinicReceipts] = await Promise.all([
    listPaymentAccounts(),
    getAppSetting(PAYMENTS_AUTO_RECEIPT_KEY),
    ...CLINICS.map((c) => getAppSetting(paymentsAutoReceiptKey(c))),
  ]);
  // Strip secrets before returning — UI only needs label + provider +
  // clinic + active flag. Editing keys uses the dedicated POST endpoint.
  const safe = accounts.map((a) => ({
    id: a.id,
    clinic: a.clinic,
    provider: a.provider,
    label: a.label,
    is_active: a.is_active,
    is_env_fallback: a.is_env_fallback,
    has_webhook_secret: Boolean(a.credentials.webhook_secret),
    env: a.credentials.env ?? null,
    created_by: a.created_by,
    created_at: a.created_at,
  }));
  const auto_receipt: Record<string, boolean> = {};
  CLINICS.forEach((c, i) => {
    const perClinic = perClinicReceipts[i];
    auto_receipt[c] = (perClinic ?? legacyReceipt) === "true";
  });
  return NextResponse.json(
    {
      accounts: safe,
      auto_receipt,
      webhook_base_url: process.env.NEXT_PUBLIC_APP_URL ?? "",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  let body: { auto_receipt_americanhairline?: boolean; auto_receipt_alchemane?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (typeof body.auto_receipt_americanhairline === "boolean") {
    await setAppSetting(
      paymentsAutoReceiptKey("americanhairline"),
      body.auto_receipt_americanhairline ? "true" : "false",
    );
  }
  if (typeof body.auto_receipt_alchemane === "boolean") {
    await setAppSetting(
      paymentsAutoReceiptKey("alchemane"),
      body.auto_receipt_alchemane ? "true" : "false",
    );
  }
  return NextResponse.json({ ok: true });
}
