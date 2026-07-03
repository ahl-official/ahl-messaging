// Provider-agnostic webhook core. Both /webhook/razorpay and
// /webhook/payu funnel into here so the row-update + auto-receipt path
// lives in exactly one place. The account whose credentials we verify
// against comes from ?account=<uuid> on the URL, falling back to the
// workspace's currently-active account for the provider.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAppSetting } from "@/lib/app-settings";
import {
  PAYMENTS_AUTO_RECEIPT_KEY,
  paymentsAutoReceiptKey,
  sendReceiptInternal,
} from "@/lib/payments";
import { getProviderBindingForWebhook } from "@/lib/payment-providers";
import type { ProviderId } from "@/lib/payment-providers/types";

export async function handleProviderWebhook(
  request: NextRequest,
  providerId: ProviderId,
): Promise<NextResponse> {
  const accountId = request.nextUrl.searchParams.get("account");
  const binding = await getProviderBindingForWebhook(providerId, accountId);
  if (!binding) {
    return NextResponse.json(
      { error: "No matching account configured for this webhook" },
      { status: 400 },
    );
  }
  const { provider, credentials, clinic } = binding;

  const raw = await request.text();
  const headers: Record<string, string | null> = {};
  request.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const verified = await provider.verifyWebhook(raw, headers, credentials);
  if (!verified) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  const event = await provider.parseWebhookEvent(raw);
  if (event.kind === "other") {
    return NextResponse.json({ ok: true, skipped: "ignored_event" });
  }

  const admin = createServiceRoleClient();
  let row:
    | { id: string; contact_id: string; status: string; receipt_sent_at: string | null }
    | null = null;
  if (event.internalPaymentId) {
    const r = await admin
      .from("payments")
      .select("id, contact_id, status, receipt_sent_at")
      .eq("id", event.internalPaymentId)
      .maybeSingle();
    row = r.data ?? null;
  }
  if (!row && event.providerLinkId) {
    const r = await admin
      .from("payments")
      .select("id, contact_id, status, receipt_sent_at")
      .eq("provider", provider.id)
      .eq("provider_link_id", event.providerLinkId)
      .maybeSingle();
    row = r.data ?? null;
  }
  if (!row && event.internalTxnId) {
    const r = await admin
      .from("payments")
      .select("id, contact_id, status, receipt_sent_at")
      .eq("provider", provider.id)
      .eq("provider_txnid", event.internalTxnId)
      .maybeSingle();
    row = r.data ?? null;
  }
  if (!row) {
    console.warn(
      `[payments/webhook/${provider.id}] no matching row — link=${event.providerLinkId ?? "—"} txnid=${event.internalTxnId ?? "—"} payment_id=${event.internalPaymentId ?? "—"}`,
    );
    return NextResponse.json({ ok: true, skipped: "row_not_found" });
  }

  const ts = new Date().toISOString();
  if (event.kind === "paid") {
    // Note: receipt_url is intentionally NOT set here — we used to
    // store the gateway's one-time checkout URL, but that URL becomes
    // "Payment Link Closed" the moment the client finishes paying.
    // sendReceiptInternal generates a real branded PDF and stamps
    // receipt_url with the Supabase public URL of that PDF.
    const update: Record<string, unknown> = {
      status: "paid",
      updated_at: ts,
    };
    if (row.status !== "paid") update.paid_at = ts;
    await admin.from("payments").update(update).eq("id", row.id);

    // Per-salon auto-receipt toggle (falls back to the legacy global
    // key so deployments that haven't migrated app_settings yet keep
    // working).
    const perClinic = await getAppSetting(paymentsAutoReceiptKey(clinic));
    const legacy = await getAppSetting(PAYMENTS_AUTO_RECEIPT_KEY);
    const auto = (perClinic ?? legacy) === "true";
    if (auto && !row.receipt_sent_at) {
      await sendReceiptInternal(row.id);
    }
  } else if (event.kind === "cancelled") {
    await admin
      .from("payments")
      .update({ status: "cancelled", updated_at: ts })
      .eq("id", row.id);
  } else if (event.kind === "expired") {
    await admin
      .from("payments")
      .update({ status: "expired", updated_at: ts })
      .eq("id", row.id);
  } else if (event.kind === "failed") {
    await admin
      .from("payments")
      .update({ status: "failed", updated_at: ts })
      .eq("id", row.id);
  }

  return NextResponse.json({
    ok: true,
    provider: provider.id,
    kind: event.kind,
    payment_id: row.id,
  });
}
