// POST /api/payments/create-link
//
// Operator clicks the ₹ icon in the chat composer → small dialog →
// this route. Two modes:
//   - mode='link': mint a PayU/Razorpay payment link (hosted checkout)
//     and send a QR of that URL to the patient.
//   - mode='upi':  call PayU's Dynamic UPI QR API (DBQR / UPIDBQR) and
//     send a QR of the returned `upi://pay?...` deeplink. Patient
//     scanning it lands directly in GPay / Paytm / PhonePe — no PayU
//     webpage in between. The S2S webhook fires on success exactly the
//     same way, so the existing handler flips status → paid and
//     auto-receipts fire.

import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getActiveProviderBinding } from "@/lib/payment-providers";
import { fetchPayuUpiQr } from "@/lib/payu-qr-scrape";
import { uploadMediaBytes } from "@/lib/storage";
import { sendMedia } from "@/lib/whatsapp";

export const runtime = "nodejs";

interface Body {
  contact_id: string;
  amount: number;          // rupees (we convert to paise)
  description?: string;
  message_prefix?: string;
  /** 'link' (default) — gateway-hosted checkout link.
   *  'upi'  — PayU Dynamic UPI QR (true `upi://pay` deeplink). */
  mode?: "link" | "upi";
  /** Which clinic's payment account to mint through. Defaults to American Hairline
   *  so existing callers keep working without code changes. */
  clinic?: "americanhairline" | "alchemane";
}

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.contact_id) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  }
  const rupees = Number(body.amount);
  if (!Number.isFinite(rupees) || rupees <= 0) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }
  const amountMinor = Math.round(rupees * 100);
  const mode: "link" | "upi" = body.mode === "upi" ? "upi" : "link";
  const clinic: "americanhairline" | "alchemane" =
    body.clinic === "alchemane" ? "alchemane" : "americanhairline";

  let binding;
  try {
    binding = await getActiveProviderBinding(clinic);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No provider configured" },
      { status: 500 },
    );
  }
  const provider = binding.provider;

  const admin = createServiceRoleClient();
  const { data: contact, error: cErr } = await admin
    .from("contacts")
    .select("id, wa_id, name, profile_name, business_phone_number_id")
    .eq("id", body.contact_id)
    .maybeSingle();
  if (cErr || !contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const description = body.description?.trim().slice(0, 500) ?? null;
  const txnid = `qht_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const contactName = (contact.name || contact.profile_name || "").trim();

  // -----------------------------------------------------------------
  // UPI mode — mint a regular PayU payment-link, then scrape the
  // `upi://pay?…` deeplink from PayU's hosted /upfrontQr screen and
  // send a QR of that deeplink to the patient. Patient scanning it
  // jumps straight into GPay / Paytm / PhonePe, payment flows through
  // PayU and the existing S2S webhook flips the row to `paid`.
  // -----------------------------------------------------------------
  if (mode === "upi") {
    if (provider.id !== "payu") {
      return NextResponse.json(
        {
          error:
            "UPI QR mode is only supported with PayU as the active gateway. Switch in Settings → Payments.",
        },
        { status: 400 },
      );
    }

    const { data: payment, error: pErr } = await admin
      .from("payments")
      .insert({
        contact_id: contact.id,
        business_phone_number_id: contact.business_phone_number_id,
        amount_minor: amountMinor,
        currency: "INR",
        description,
        status: "created",
        provider: "payu",
        provider_txnid: txnid,
        created_by: user.email ?? null,
      })
      .select("id")
      .single();
    if (pErr || !payment) {
      return NextResponse.json(
        { error: pErr?.message ?? "Could not create payment row" },
        { status: 500 },
      );
    }

    try {
      // Step 1 — mint a regular PayU payment-link (same OAuth flow
      // that the Payment Link mode uses).
      const link = await provider.createPaymentLink(
        {
          amountMinor,
          currency: "INR",
          description: description ?? "American Hairline payment",
          customer: {
            name: contactName || undefined,
            contact: `+${contact.wa_id}`,
          },
          internalPaymentId: payment.id,
          internalTxnId: txnid,
        },
        binding.credentials,
      );

      await admin
        .from("payments")
        .update({
          provider_link_id: link.providerLinkId,
          short_url: link.shortUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("id", payment.id);

      // Step 2 — scrape the UPI QR off PayU's upfrontQr screen.
      const qr = await fetchPayuUpiQr(link.shortUrl);

      const rupeesPretty = (amountMinor / 100).toLocaleString("en-IN");
      const firstName = contactName ? contactName.split(/\s+/)[0] : "";
      const greeting = firstName ? `Hi ${firstName}!` : "Hi!";
      const forPart = description ? ` — ${description}` : "";
      const lines: string[] = [];
      if (body.message_prefix?.trim()) {
        lines.push(body.message_prefix.trim());
        lines.push(`₹${rupeesPretty}${forPart}`);
      } else {
        lines.push(`${greeting} ₹${rupeesPretty}${forPart}`);
        lines.push("Scan QR via GPay / Paytm / PhonePe to pay.");
      }
      // Same-device UPI intent fails for high-value (>= ₹2000) on most
      // banks — patient needs to scan from a SECOND phone.
      if (amountMinor >= 200000) {
        lines.push(
          "Note: ₹2000+ ke liye QR ko KISI DUSRE phone se scan kijiye — same phone se UPI fail karta hai.",
        );
        lines.push(
          "For amounts above ₹2000, please scan the QR from a DIFFERENT phone — same-phone UPI fails.",
        );
      }
      const captionText = lines.join("\n");

      let qrSent = false;
      try {
        // Prefer re-encoding the deeplink ourselves (crisp, sized).
        // Fall back to PayU's own canvas screenshot when the deeplink
        // couldn't be extracted.
        const pngBuffer = qr.deeplink
          ? await QRCode.toBuffer(qr.deeplink, {
              type: "png",
              errorCorrectionLevel: "M",
              margin: 2,
              width: 600,
              color: { dark: "#0f172a", light: "#ffffff" },
            })
          : qr.canvasPng!;
        const uploaded = await uploadMediaBytes(pngBuffer, {
          mime: "image/png",
          folder: "outbound",
          suggestedName: `payment-upi-${payment.id}`,
        });
        if (contact.business_phone_number_id) {
          const sendRes = await sendMedia(
            contact.wa_id,
            "image",
            uploaded.publicUrl,
            captionText,
            contact.business_phone_number_id,
          );
          const waMessageId = sendRes.messages?.[0]?.id ?? null;
          await admin.from("messages").insert({
            contact_id: contact.id,
            wa_message_id: waMessageId,
            direction: "outbound",
            type: "image",
            content: captionText,
            media_url: uploaded.publicUrl,
            media_mime_type: "image/png",
            status: "sent",
            timestamp: new Date().toISOString(),
            business_phone_number_id: contact.business_phone_number_id,
            sent_by_user_id: user.id,
            sent_by_email: user.email ?? null,
          });
          await admin
            .from("contacts")
            .update({
              last_message_at: new Date().toISOString(),
              last_message_preview: captionText.slice(0, 120),
              last_message_direction: "outbound",
              last_message_status: "sent",
            })
            .eq("id", contact.id);
          qrSent = true;
        }
      } catch (qrErr) {
        console.error(
          "[payments/create-link] UPI QR send failed:",
          qrErr instanceof Error ? qrErr.message : qrErr,
        );
      }

      return NextResponse.json({
        ok: true,
        payment_id: payment.id,
        mode: "upi",
        provider: "payu",
        short_url: link.shortUrl,
        upi_deeplink: qr.deeplink,
        qr_source: qr.source,
        message_text: qrSent ? null : captionText,
        qr_sent: qrSent,
      });
    } catch (e) {
      await admin
        .from("payments")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", payment.id);
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Gateway error" },
        { status: 502 },
      );
    }
  }

  // -----------------------------------------------------------------
  // Link mode — existing PayU / Razorpay hosted-checkout flow.
  // -----------------------------------------------------------------
  const { data: payment, error: pErr } = await admin
    .from("payments")
    .insert({
      contact_id: contact.id,
      business_phone_number_id: contact.business_phone_number_id,
      amount_minor: amountMinor,
      currency: "INR",
      description,
      status: "created",
      provider: provider.id,
      provider_txnid: txnid,
      created_by: user.email ?? null,
    })
    .select("id")
    .single();
  if (pErr || !payment) {
    return NextResponse.json(
      { error: pErr?.message ?? "Could not create payment row" },
      { status: 500 },
    );
  }

  try {
    const link = await provider.createPaymentLink(
      {
        amountMinor,
        currency: "INR",
        description: description ?? "American Hairline payment",
        customer: {
          name: contactName || undefined,
          contact: `+${contact.wa_id}`,
        },
        internalPaymentId: payment.id,
        internalTxnId: txnid,
      },
      binding.credentials,
    );

    await admin
      .from("payments")
      .update({
        provider_link_id: link.providerLinkId,
        razorpay_payment_link_id:
          provider.id === "razorpay" ? link.providerLinkId : null,
        short_url: link.shortUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id);

    const rupeesPretty = (amountMinor / 100).toLocaleString("en-IN");
    const lines: string[] = [];
    if (body.message_prefix?.trim()) lines.push(body.message_prefix.trim());
    else
      lines.push(
        `${contactName ? `Hi ${contactName.split(/\s+/)[0]},` : "Hi,"} please use the link below to complete your payment.`,
      );
    lines.push("");
    lines.push(`Amount: ₹${rupeesPretty}`);
    if (description) lines.push(`For: ${description}`);
    lines.push(`Pay here: ${link.shortUrl}`);
    const captionText = lines.join("\n");

    let qrSent = false;
    try {
      const pngBuffer = await QRCode.toBuffer(link.shortUrl, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 600,
        color: { dark: "#0f172a", light: "#ffffff" },
      });
      const uploaded = await uploadMediaBytes(pngBuffer, {
        mime: "image/png",
        folder: "outbound",
        suggestedName: `payment-qr-${payment.id}`,
      });
      if (contact.business_phone_number_id) {
        const sendRes = await sendMedia(
          contact.wa_id,
          "image",
          uploaded.publicUrl,
          captionText,
          contact.business_phone_number_id,
        );
        const waMessageId = sendRes.messages?.[0]?.id ?? null;
        await admin.from("messages").insert({
          contact_id: contact.id,
          wa_message_id: waMessageId,
          direction: "outbound",
          type: "image",
          content: captionText,
          media_url: uploaded.publicUrl,
          media_mime_type: "image/png",
          status: "sent",
          timestamp: new Date().toISOString(),
          business_phone_number_id: contact.business_phone_number_id,
          sent_by_user_id: user.id,
          sent_by_email: user.email ?? null,
        });
        await admin
          .from("contacts")
          .update({
            last_message_at: new Date().toISOString(),
            last_message_preview: captionText.slice(0, 120),
            last_message_direction: "outbound",
            last_message_status: "sent",
          })
          .eq("id", contact.id);
        qrSent = true;
      }
    } catch (qrErr) {
      console.error(
        "[payments/create-link] QR send failed:",
        qrErr instanceof Error ? qrErr.message : qrErr,
      );
    }

    return NextResponse.json({
      ok: true,
      payment_id: payment.id,
      mode: "link",
      provider: provider.id,
      short_url: link.shortUrl,
      message_text: qrSent ? null : captionText,
      qr_sent: qrSent,
    });
  } catch (e) {
    await admin
      .from("payments")
      .update({
        status: "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Gateway error" },
      { status: 502 },
    );
  }
}
