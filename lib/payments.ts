// Shared payment helpers — used by the webhook (auto-receipt) AND the
// manual /send-receipt route, so both follow the exact same WhatsApp
// send path and write the same audit trail.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { buildReceiptPdf } from "@/lib/payment-receipt";
import { uploadMediaBytes } from "@/lib/storage";
import { sendMedia } from "@/lib/whatsapp";
import type { Clinic } from "@/lib/payment-accounts";

/** Per-clinic app_settings keys for the operator's auto-receipt
 *  toggle: when 'true', the gateway webhook auto-sends the PDF receipt
 *  to the patient as soon as payment lands. When 'false' (default),
 *  the operator hits "Send receipt" manually from the contact panel.
 *  Controlled from Settings → Payments → <Clinic>. */
export function paymentsAutoReceiptKey(clinic: Clinic): string {
  return `payments_auto_receipt_${clinic}`;
}

/** @deprecated — kept only for migration code paths that read the
 *  pre-multi-clinic key. New code should call `paymentsAutoReceiptKey`. */
export const PAYMENTS_AUTO_RECEIPT_KEY = "payments_auto_receipt";

/** app_settings.key — clinic's UPI VPA (e.g. `qht@hdfcbank`) used to
 *  build the UPI deeplink QR sent to the patient. Set once from
 *  Settings → Payments; the chat dialog no longer asks per-payment. */
export const PAYMENTS_UPI_VPA_KEY = "payments_upi_vpa";

/** app_settings.key — payee name displayed in the patient's UPI app
 *  when they scan the QR (e.g. "QHT Clinic"). */
export const PAYMENTS_UPI_PAYEE_KEY = "payments_upi_payee_name";

/** Generates a branded QHT receipt PDF for the payment, uploads it to
 *  Supabase Storage, and sends it to the patient as a WhatsApp document
 *  attachment. Idempotency is the caller's responsibility — the webhook
 *  guards on receipt_sent_at; the manual button has UX confirmation. */
export async function sendReceiptInternal(
  paymentId: string,
  _receiptUrlOverride?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createServiceRoleClient();

  // Atomic claim — only one caller wins. PayU's S2S webhook routinely
  // retries the same notification within seconds; without this guard
  // two concurrent webhook hits both pass handler.ts's pre-check
  // (receipt_sent_at IS NULL at read-time), both call us, and the
  // patient gets the PDF twice. By stamping receipt_sent_at with a
  // conditional update that requires it to currently be NULL, the
  // second caller's update affects 0 rows and we silently skip.
  const claimTs = new Date().toISOString();
  const { data: claimed } = await admin
    .from("payments")
    .update({ receipt_sent_at: claimTs })
    .eq("id", paymentId)
    .is("receipt_sent_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return { ok: true };

  // Releases the claim so a retry (or the manual "Send receipt"
  // button) can fire again. Only clears the timestamp if it still
  // matches our claim — won't trample a concurrent successful send.
  const releaseClaim = async () => {
    await admin
      .from("payments")
      .update({ receipt_sent_at: null })
      .eq("id", paymentId)
      .eq("receipt_sent_at", claimTs);
  };

  const { data: row } = await admin
    .from("payments")
    .select(
      "id, contact_id, business_phone_number_id, amount_minor, currency, description, paid_at, status, receipt_url, provider, provider_txnid, provider_link_id, short_url",
    )
    .eq("id", paymentId)
    .maybeSingle();
  if (!row) {
    await releaseClaim();
    return { ok: false, error: "payment_not_found" };
  }

  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, name, profile_name, business_phone_number_id")
    .eq("id", row.contact_id)
    .maybeSingle();
  if (!contact) {
    await releaseClaim();
    return { ok: false, error: "contact_not_found" };
  }

  const bpid =
    (row.business_phone_number_id as string | null) ||
    (contact.business_phone_number_id as string | null) ||
    null;
  if (!bpid) {
    await releaseClaim();
    return { ok: false, error: "no_business_phone_number" };
  }

  const fullName =
    ((contact.name as string | null) || (contact.profile_name as string | null) || "").trim() ||
    "Customer";
  const firstName = fullName.split(/\s+/)[0];
  const amountMinor = row.amount_minor as number;
  const rupeesPretty = (amountMinor / 100).toLocaleString("en-IN");
  const receiptNumber =
    (row.provider_txnid as string | null) || String(row.id).slice(0, 8);

  // Build the branded PDF.
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await buildReceiptPdf({
      receiptNumber,
      paidAtIso: (row.paid_at as string | null) ?? new Date().toISOString(),
      amountMinor,
      currency: (row.currency as string) || "INR",
      description: (row.description as string | null) ?? null,
      patientName: fullName,
      patientPhone: contact.wa_id as string,
      transactionId: (row.provider_link_id as string | null) ?? null,
      provider:
        ((row.provider as string | null) === "razorpay" ? "razorpay" : "payu"),
    });
  } catch (e) {
    await releaseClaim();
    return {
      ok: false,
      error: `pdf_build_failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }

  // Upload the PDF to Supabase Storage so Meta can fetch it via link.
  let pdfUrl: string;
  try {
    const uploaded = await uploadMediaBytes(pdfBuffer, {
      mime: "application/pdf",
      folder: "outbound",
      suggestedName: `QHT-Receipt-${receiptNumber}`,
    });
    pdfUrl = uploaded.publicUrl;
  } catch (e) {
    await releaseClaim();
    return {
      ok: false,
      error: `upload_failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }

  // Send the WhatsApp document. Meta caps document filenames at 240
  // chars; ours stays well under.
  const filename = `QHT-Receipt-${receiptNumber}.pdf`;
  const caption =
    `${firstName ? `Hi ${firstName},` : "Hi,"} ` +
    `we have received your payment of ₹${rupeesPretty}. ` +
    `Your receipt is attached.\n\nThank you — QHT Clinic team.`;

  let waMessageId: string | null = null;
  try {
    const resp = await sendMedia(
      contact.wa_id as string,
      "document",
      pdfUrl,
      caption,
      bpid,
      filename,
    );
    waMessageId = resp.messages?.[0]?.id ?? null;
  } catch (e) {
    await releaseClaim();
    return {
      ok: false,
      error: `send_failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }

  const nowIso = new Date().toISOString();

  // Persist the outbound message bubble so the dashboard renders the
  // same document attachment the patient sees.
  await admin.from("messages").insert({
    contact_id: contact.id,
    wa_message_id: waMessageId,
    direction: "outbound",
    type: "document",
    content: caption,
    media_url: pdfUrl,
    media_mime_type: "application/pdf",
    status: "sent",
    timestamp: nowIso,
    business_phone_number_id: bpid,
  });

  // Stamp the payment row — receipt_url now points to the PDF, not
  // the (one-time) PayU/Razorpay checkout URL.
  await admin
    .from("payments")
    .update({
      receipt_url: pdfUrl,
      receipt_sent_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", paymentId);

  // Bump the contact preview so the chat list reflects the new bubble.
  await admin
    .from("contacts")
    .update({
      last_message_at: nowIso,
      last_message_preview: caption.slice(0, 120),
      last_message_direction: "outbound",
      last_message_status: "sent",
    })
    .eq("id", contact.id);

  return { ok: true };
}
