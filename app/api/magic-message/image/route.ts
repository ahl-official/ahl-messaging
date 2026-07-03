import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getApiVersion, sendTemplate } from "@/lib/whatsapp";
import { uploadMediaBytes } from "@/lib/storage";
import { contactDisplayName } from "@/lib/types";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";

export const runtime = "nodejs";
const TEMPLATE_NAME = "magic_message";
const TEMPLATE_LANGUAGE = "en_US";

const ALLOWED_MIMES = ["image/jpeg", "image/png"];
const MAX_BYTES = 5 * 1024 * 1024; // 5MB — matches Meta's image template limit

// =====================================================================
// POST /api/magic-message/image
//
// Pipeline (image branch of Magic Message):
//   1. Receive a multipart upload — agent picks an image from their device
//   2. Upload bytes to Meta to get a fresh media_id
//   3. Mirror to Supabase Storage for the dashboard's stable preview URL
//   4. Send the `magic_message` utility template with that image as the
//      header (body var = customer's display name, fixed body copy)
//   5. Persist the message + bump contact preview
//
// Same end result as the Text branch but skips the QHT IMG SERVER —
// the agent supplies the image directly so no rendering step is needed.
// =====================================================================
export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiVersion = await getApiVersion();

  // ---- Parse multipart body ------------------------------------------------
  const form = await request.formData();
  const contactId = (form.get("contact_id") as string | null)?.trim();
  const waId = (form.get("wa_id") as string | null)?.trim();
  // Agent-provided override for the body's {{1}} variable. Lets the agent
  // correct or personalize the customer name before sending — same UX as
  // the Text branch's editable greeting.
  const customerNameOverride = (form.get("customer_name") as string | null)?.trim();
  const file = form.get("file");

  if (!contactId || !waId) {
    return NextResponse.json(
      { error: "contact_id and wa_id are required" },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIMES.includes(mime)) {
    return NextResponse.json(
      { error: `Unsupported image type: ${mime}. Use JPEG or PNG.` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${Math.round(file.size / 1024 / 1024)}MB) — max 5MB.` },
      { status: 400 },
    );
  }

  // ---- 1. Look up contact + sender details --------------------------------
  const admin = createServiceRoleClient();
  const { data: contactRow } = await admin
    .from("contacts")
    .select("id, wa_id, name, profile_name, business_phone_number_id, status")
    .eq("id", contactId)
    .maybeSingle();
  if (!contactRow) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  // Prefer the agent's override (typed in the dialog); fall back to the
  // contact's display name; final fallback is "there" so {{1}} is never empty.
  const customerName =
    customerNameOverride ||
    contactDisplayName(contactRow as Parameters<typeof contactDisplayName>[0]) ||
    "there";
  const businessPhoneNumberId = contactRow.business_phone_number_id ?? null;
  if (!businessPhoneNumberId) {
    return NextResponse.json(
      { error: "Contact has no assigned WhatsApp business number." },
      { status: 400 },
    );
  }

  // ---- Interakt path -----------------------------------------------------
  // Plain media can't reopen a closed 24h window — send the uploaded image
  // as the header of the `magic_message_llp` utility template instead. The
  // image is mirrored to Storage for a public URL Interakt can fetch.
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
    const bytes = await file.arrayBuffer();
    let publicUrl: string;
    try {
      const uploaded = await uploadMediaBytes(bytes, {
        mime,
        folder: "outbound",
        suggestedName: file.name,
      });
      publicUrl = uploaded.publicUrl;
    } catch (e) {
      return NextResponse.json(
        { error: `Storage upload failed: ${e instanceof Error ? e.message : "unknown"}` },
        { status: 502 },
      );
    }
    let waMessageId: string | null = null;
    try {
      const r = await sendInteraktMagicMessage(key, waId, {
        imageUrl: publicUrl,
        fileName: file.name,
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
          content: file.name,
          media_url: publicUrl,
          media_mime_type: mime,
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
        content: file.name,
        media_url: publicUrl,
        media_mime_type: mime,
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
        last_message_preview: "📷 Photo",
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

  // Sender (for the bubble's avatar tooltip — body credits the agent only on
  // the Text branch where it's rendered into the image; here it's metadata).
  const { data: senderRow } = await admin
    .from("team_members")
    .select("first_name, last_name, full_name")
    .eq("user_id", user.id)
    .maybeSingle();

  // ---- 2. Upload to Meta + mirror to Supabase Storage ---------------------
  const bytes = await file.arrayBuffer();

  let mediaId: string | null = null;
  let supabaseUrl: string | null = null;
  try {
    // Meta upload
    const metaForm = new FormData();
    metaForm.append("messaging_product", "whatsapp");
    metaForm.append("type", mime);
    metaForm.append("file", new Blob([bytes], { type: mime }), file.name);

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

    // Supabase mirror — non-fatal
    try {
      const uploaded = await uploadMediaBytes(bytes, {
        mime,
        folder: "outbound",
        suggestedName: file.name,
      });
      supabaseUrl = uploaded.publicUrl;
    } catch (e) {
      console.error(
        "[magic-message/image] Supabase mirror failed:",
        e instanceof Error ? e.message : e,
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: `Couldn't prepare image for send: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      },
      { status: 502 },
    );
  }

  // ---- 3. Send the magic_message template ---------------------------------
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
    const { data: failedRow } = await admin
      .from("messages")
      .insert({
        contact_id: contactId,
        direction: "outbound",
        type: "template",
        content: file.name,
        media_url: supabaseUrl,
        media_mime_type: mime,
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

  // ---- 4. Persist + bump contact preview ----------------------------------
  const nowIso = new Date().toISOString();
  const templatePreview =
    `Hi ${customerName},\n\n` +
    `Information related to your support ticket has updated.\n\n` +
    `Please review and reply accordingly`;

  const senderDisplay =
    senderRow?.first_name?.trim() && senderRow?.last_name?.trim()
      ? `${senderRow.first_name.trim()} ${senderRow.last_name.trim()}`
      : senderRow?.full_name?.trim() || user.email || null;

  const { data: inserted, error: insertErr } = await admin
    .from("messages")
    .insert({
      contact_id: contactId,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: "template",
      content: templatePreview,
      media_url: supabaseUrl,
      media_mime_type: mime,
      status: "sent",
      timestamp: nowIso,
      business_phone_number_id: businessPhoneNumberId,
      template_name: TEMPLATE_NAME,
      template_footer: "Type STOP to Unsubscribe",
      template_buttons: [{ type: "QUICK_REPLY", text: "Reply Now" }],
      sent_by_user_id: user.id,
      sent_by_email: senderDisplay ?? user.email ?? null,
    })
    .select("*")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Don't auto-reopen closed conversations — that's the webhook's job when
  // the customer actually replies.
  await admin
    .from("contacts")
    .update({
      last_message_at: nowIso,
      last_message_preview: `📷 ${file.name}`.slice(0, 120),
      last_message_direction: "outbound",
      last_message_status: "sent",
    })
    .eq("id", contactId);

  // Log Magic Message (image branch) to CRM activity timeline.
  void import("@/lib/lsq-message-logger").then(({ logWhatsappActivityToLSQ }) =>
    logWhatsappActivityToLSQ({
      contactId,
      direction: "Outbound",
      text: `[Magic Message · Image] ${file.name}`,
      businessPhoneNumberId,
      timestamp: nowIso,
    }),
  ).catch(() => {});

  return NextResponse.json({ ok: true, message: inserted });
}
