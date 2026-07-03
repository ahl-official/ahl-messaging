import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getApiVersion, sendTemplate } from "@/lib/whatsapp";
import { uploadMediaBytes } from "@/lib/storage";
import { contactDisplayName } from "@/lib/types";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";
import { renderMagicCardPng } from "@/lib/magic-card";

export const runtime = "nodejs";
const TEMPLATE_NAME = "magic_message";
const TEMPLATE_LANGUAGE = "en_US";

interface Body {
  contact_id?: string;
  wa_id?: string;
  text?: string;
  /** Optional — which business number to send from when the contact has
   *  none assigned yet. Used by the dialog's "Send from" picker. The contact
   *  is then assigned to this number so future messages route correctly. */
  business_phone_number_id?: string;
}

// =====================================================================
// POST /api/magic-message/text
//
// Pipeline:
//   1. Take agent-typed text
//   2. Render the magic-message card in-process via lib/magic-card (next/og)
//   3. Upload those bytes to Meta → fresh media_id, and mirror to Supabase
//      Storage for a stable preview URL
//   4. Send the `magic_message` utility template with the generated image
//      as the header — this punches through the 24h customer service window
//   5. Persist the message + bump contact preview + reopen the conversation
// =====================================================================
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
  const contactId = body.contact_id?.trim();
  const waId = body.wa_id?.trim();
  const text = body.text?.trim();
  if (!contactId || !waId || !text) {
    return NextResponse.json(
      { error: "contact_id, wa_id, and text are required" },
      { status: 400 },
    );
  }
  if (text.length > 1500) {
    return NextResponse.json(
      { error: "Text too long for the magic message card (1500 max)" },
      { status: 400 },
    );
  }

  const apiVersion = await getApiVersion();

  // ---- 1. Look up contact (for the body-var name + the WA business number) -
  const admin = createServiceRoleClient();
  const { data: contactRow } = await admin
    .from("contacts")
    .select("id, wa_id, name, profile_name, business_phone_number_id, status")
    .eq("id", contactId)
    .maybeSingle();
  if (!contactRow) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  // contactDisplayName takes a Contact-shaped object. Cast the row since the
  // selected fields are a strict subset. If the resolved "name" still
  // looks like a phone number (legacy contacts where the placeholder was
  // literally the digits), drop it — the greeting reads "Hi +91-…"
  // otherwise and that's worse than a generic "Hi there".
  const rawName =
    contactDisplayName(contactRow as Parameters<typeof contactDisplayName>[0]) ||
    "there";
  const phoneish = /^[+\d][\d\s()+-]*$/.test(rawName.trim());
  const customerName = phoneish ? "there" : rawName;
  // Use the contact's number; if it has none, fall back to the picker's
  // choice and assign the contact to it so it routes correctly from now on.
  const overrideNumber = body.business_phone_number_id?.trim() || null;
  const businessPhoneNumberId = contactRow.business_phone_number_id ?? overrideNumber;
  if (!businessPhoneNumberId) {
    return NextResponse.json(
      { error: "Contact has no assigned WhatsApp business number. Pick one in 'Send from'." },
      { status: 400 },
    );
  }
  if (!contactRow.business_phone_number_id && overrideNumber) {
    await admin
      .from("contacts")
      .update({ business_phone_number_id: overrideNumber })
      .eq("id", contactId);
  }

  // ---- Interakt path -----------------------------------------------------
  // Plain text can't reopen a closed 24h window — only an approved utility
  // template can. So mirror the Meta flow: render the magic card, upload it
  // for a public URL, and send the `magic_message_llp` utility template
  // with that image as the header + customer name as the body var.
  if (businessPhoneNumberId.startsWith("interakt:")) {
    const { getInteraktApiKey, sendInteraktMagicMessage } = await import("@/lib/interakt");
    const { data: numRow } = await admin
      .from("business_numbers")
      .select("interakt_api_key, magic_message_template")
      .eq("phone_number_id", businessPhoneNumberId)
      .maybeSingle();
    const key = numRow?.interakt_api_key || (await getInteraktApiKey());
    if (!key) {
      return NextResponse.json(
        { error: "Interakt API key not set. Add it in Settings → Interakt." },
        { status: 400 },
      );
    }

    // Agent name for the card's "Replied By" line (best-effort here, unlike
    // the Meta branch which hard-requires it).
    const { data: senderRow } = await admin
      .from("team_members")
      .select("first_name, last_name, full_name")
      .eq("user_id", user.id)
      .maybeSingle();
    const agentName =
      [senderRow?.first_name?.trim(), senderRow?.last_name?.trim()].filter(Boolean).join(" ") ||
      senderRow?.full_name?.trim() ||
      "Team";

    // Render the card + upload for a public URL Interakt can fetch.
    let publicUrl: string;
    try {
      const card = await renderMagicCardPng({ text, agentName });
      const uploaded = await uploadMediaBytes(card.bytes, {
        mime: card.mime,
        folder: "outbound",
        suggestedName: "magic-message",
      });
      publicUrl = uploaded.publicUrl;
    } catch (e) {
      return NextResponse.json(
        { error: `Card render/upload failed: ${e instanceof Error ? e.message : "unknown"}` },
        { status: 502 },
      );
    }

    let waMessageId: string | null = null;
    try {
      const r = await sendInteraktMagicMessage(key, waId, {
        imageUrl: publicUrl,
        fileName: "magic-message.png",
        customerName,
        templateName: numRow?.magic_message_template || undefined,
      });
      waMessageId = r.messageId;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Interakt template send failed";
      const { data: failedRow } = await admin
        .from("messages")
        .insert({
          contact_id: contactId,
          direction: "outbound",
          type: "template",
          content: text,
          media_url: publicUrl,
          media_mime_type: "image/png",
          status: "failed",
          error_message: message,
          business_phone_number_id: businessPhoneNumberId,
          sent_by_user_id: user.id,
          sent_by_email: user.email ?? null,
        })
        .select("*")
        .single();
      return NextResponse.json({ error: message, message: failedRow }, { status: 502 });
    }
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insertErr } = await admin
      .from("messages")
      .insert({
        contact_id: contactId,
        wa_message_id: waMessageId,
        direction: "outbound",
        type: "template",
        content: text,
        media_url: publicUrl,
        media_mime_type: "image/png",
        status: "sent",
        timestamp: nowIso,
        business_phone_number_id: businessPhoneNumberId,
        template_name: "magic_message_llp",
        sent_by_user_id: user.id,
        sent_by_email: user.email ?? null,
      })
      .select("*")
      .single();
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }
    await admin
      .from("contacts")
      .update({
        last_message_at: nowIso,
        last_message_preview: text.slice(0, 120),
        last_message_direction: "outbound",
        last_message_status: "sent",
      })
      .eq("id", contactId);
    return NextResponse.json({ ok: true, message: inserted });
  }

  const creds = await resolveCredsForPhoneNumberId(businessPhoneNumberId);
  if (!creds) {
    return NextResponse.json(
      {
        error:
          `No portfolio found for phone_number_id ${businessPhoneNumberId}. Assign it under Settings → Portfolios.`,
      },
      { status: 400 },
    );
  }
  const accessToken = creds.access_token;

  // ---- 1.5. Look up the agent's display name -----------------------------
  // The card's "Replied By" line should credit the agent who actually sent
  // the message — not the customer. We require first + last name in the
  // team_members row before allowing the send so the card never falls back
  // to a generic label.
  const { data: senderRow } = await admin
    .from("team_members")
    .select("first_name, last_name, full_name, email")
    .eq("user_id", user.id)
    .maybeSingle();

  const agentDisplayName = senderRow
    ? [senderRow.first_name?.trim(), senderRow.last_name?.trim()]
        .filter(Boolean)
        .join(" ") || senderRow.full_name?.trim() || ""
    : "";

  if (!agentDisplayName) {
    return NextResponse.json(
      {
        error:
          "Please complete your profile (Settings → Profile) — first name and last name are required before sending a Magic Message.",
      },
      { status: 400 },
    );
  }

  // ---- 2. Render the magic-message card in-process via next/og -----------
  // Previously this hopped through services/image-generator (Express +
  // Puppeteer at localhost:3001). That service was easy to forget to start,
  // which surfaced as "Image generator failed: fetch failed" on every Magic
  // Message attempt. Rendering inline removes the moving part entirely.
  let imageBytes: ArrayBuffer;
  let imageMime: string;
  try {
    const card = await renderMagicCardPng({
      text,
      agentName: agentDisplayName,
    });
    imageBytes = card.bytes;
    imageMime = card.mime;
  } catch (e) {
    return NextResponse.json(
      {
        error: `Card render failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 502 },
    );
  }

  // ---- 3. Mirror the generated image into Meta + Supabase Storage --------
  let mediaId: string | null = null;
  let supabaseUrl: string | null = null;
  try {
    // (a) Meta upload
    const metaForm = new FormData();
    metaForm.append("messaging_product", "whatsapp");
    metaForm.append("type", imageMime);
    metaForm.append(
      "file",
      new Blob([imageBytes], { type: imageMime }),
      `magic-${Date.now()}.${imageMime.split("/")[1] ?? "png"}`,
    );
    const metaRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/${businessPhoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: metaForm,
      },
    );
    const metaJson = (await metaRes.json()) as { id?: string; error?: { message?: string } };
    if (!metaRes.ok || !metaJson.id) {
      throw new Error(metaJson.error?.message ?? `Meta upload HTTP ${metaRes.status}`);
    }
    mediaId = metaJson.id;

    // (b) Supabase Storage mirror — non-fatal if it fails
    try {
      const uploaded = await uploadMediaBytes(imageBytes, {
        mime: imageMime,
        folder: "outbound",
        suggestedName: "magic-message",
      });
      supabaseUrl = uploaded.publicUrl;
    } catch (e) {
      console.error(
        "[magic-message/text] Supabase mirror failed:",
        e instanceof Error ? e.message : e,
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: `Couldn't prepare generated image for send: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      },
      { status: 502 },
    );
  }

  // ---- 4. Send the magic_message template with the generated image -------
  let waMessageId: string | null = null;
  try {
    const components = [
      {
        type: "header",
        parameters: [{ type: "image", image: { id: mediaId } }],
      },
      {
        type: "body",
        parameters: [{ type: "text", text: customerName }],
      },
    ];
    const resp = await sendTemplate(
      waId,
      TEMPLATE_NAME,
      TEMPLATE_LANGUAGE,
      components,
      businessPhoneNumberId ?? undefined,
    );
    waMessageId = resp.messages?.[0]?.id ?? null;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Template send failed";
    // Persist a failed-send row so the dashboard sees what went wrong.
    const { data: failedRow } = await admin
      .from("messages")
      .insert({
        contact_id: contactId,
        direction: "outbound",
        type: "template",
        content: text,
        media_url: supabaseUrl,
        media_mime_type: "image/*",
        status: "failed",
        error_message: message,
        business_phone_number_id: businessPhoneNumberId,
        sent_by_user_id: user.id,
        sent_by_email: user.email ?? null,
      })
      .select("*")
      .single();
    return NextResponse.json({ error: message, message: failedRow }, { status: 502 });
  }

  // ---- 5. Persist the success row + bump contact preview ------------------
  const nowIso = new Date().toISOString();
  // Body preview for the conversation list / chat bubble — the actual
  // template body Meta renders has the same shape.
  const templatePreview =
    `Hi ${customerName},\n\n` +
    `Information related to your support ticket has updated.\n\n` +
    `Please review and reply accordingly`;

  const { data: inserted, error: insertErr } = await admin
    .from("messages")
    .insert({
      contact_id: contactId,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: "template",
      content: templatePreview,
      media_url: supabaseUrl,
      media_mime_type: "image/jpeg",
      status: "sent",
      timestamp: nowIso,
      business_phone_number_id: businessPhoneNumberId,
      template_name: TEMPLATE_NAME,
      template_footer: "Type STOP to Unsubscribe",
      // The magic_message template has a single Quick Reply button; persisting
      // it here makes the dashboard bubble render the "Reply Now" CTA the
      // same way it would for any other template send.
      template_buttons: [{ type: "QUICK_REPLY", text: "Reply Now" }],
      sent_by_user_id: user.id,
      sent_by_email: user.email ?? null,
    })
    .select("*")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Bump preview + last-message timestamp ONLY. Do NOT force the conversation
  // back to "open" — closing a chat is the agent's deliberate decision; the
  // Magic Message is a one-shot outreach. The webhook already flips status
  // back to "open" the moment the customer replies, which is the right
  // trigger.
  await admin
    .from("contacts")
    .update({
      last_message_at: nowIso,
      last_message_preview: text.slice(0, 120),
      last_message_direction: "outbound",
      last_message_status: "sent",
    })
    .eq("id", contactId);

  // Log Magic Message to CRM activity timeline.
  void import("@/lib/lsq-message-logger").then(({ logWhatsappActivityToLSQ }) =>
    logWhatsappActivityToLSQ({
      contactId,
      direction: "Outbound",
      text: `[Magic Message] ${text}`,
      businessPhoneNumberId,
      timestamp: nowIso,
    }),
  ).catch(() => {});

  return NextResponse.json({ ok: true, message: inserted });
}
