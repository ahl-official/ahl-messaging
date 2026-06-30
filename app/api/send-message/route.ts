import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { sendCtaUrl, sendInteractiveButtons, sendMedia, sendTemplate, sendTextMessage } from "@/lib/whatsapp";
import * as evolution from "@/lib/evolution";
import {
  sendInteraktText,
  sendInteraktMedia,
  sendInteraktTemplate,
  metaTemplateComponentsToInterakt,
  getInteraktApiKey,
} from "@/lib/interakt";
import { getCredential } from "@/lib/credentials";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { numberAllowed } from "@/lib/permission-types";

export const runtime = "nodejs";

interface SendBody {
  contact_id?: string;
  wa_id?: string;
  kind?: "text" | "template" | "media" | "interactive" | "rich";
  // text
  text?: string;
  // rich (quick reply) — optional media header + body text + buttons.
  button_text?: string;
  button_url?: string;
  /** Typed buttons: quick_reply (reply) or url (cta_url). Free-form WhatsApp
   *  allows up to 3 reply buttons OR one URL button (not mixed). */
  rich_buttons?: Array<{ type: "quick_reply" | "url"; text: string; url?: string }>;
  // interactive (reply buttons) — body_text + up to 3 tappable buttons
  body_text?: string;
  buttons?: Array<{ id?: string; title: string }>;
  // template
  template_name?: string;
  template_language?: string;
  template_body_preview?: string; // rendered body to store + preview
  template_components?: unknown[]; // Meta components array (header / body / button params)
  /** Public URL of the header media (image/video/document) so the
   *  dashboard can render the same header bubble the customer sees. */
  template_media_url?: string;
  /** Mime of the header media so the bubble renders img vs video vs doc.
   *  Defaults to image/* when omitted (back-compat). */
  template_media_mime?: string | null;
  /** Footer line copied off the template (e.g. "Type STOP to Unsubscribe"). */
  template_footer?: string | null;
  /** Buttons array copied off the template (Quick Reply / URL / Phone / Copy). */
  template_buttons?: Array<{
    type: string;
    text?: string;
    url?: string;
    phone_number?: string;
    example?: string | string[];
  }> | null;
  // media
  media_id?: string;
  media_url?: string;
  media_kind?: "image" | "video" | "audio" | "document";
  media_mime?: string;
  caption?: string;
  filename?: string;
  /** Quoted-reply context — the wamid of the message this send is
   *  replying to. Meta renders the customer's phone with a swipe-reply
   *  thread, and the dashboard bubble persists the quote header. */
  reply_to_wa_message_id?: string | null;
  /** Cached snippet of the quoted message body (so the dashboard
   *  bubble can render the quote header without a per-row lookup). */
  reply_to_content?: string | null;
  /** Direction of the quoted message — drives the quote header's
   *  sender label on the dashboard. */
  reply_to_direction?: "inbound" | "outbound" | null;
}

export async function POST(request: NextRequest) {
  // ---- AuthN: signed-in dashboard user OR shared internal token
  //      (used by /api/payments/webhook to auto-send receipts without
  //      a user session). Internal-token callers bypass the per-user
  //      permission check below — they're already trusted code paths. ----
  const authHeader = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const internalExpected = await getCredential("webhook_internal_token");
  const internalOk = !!internalExpected && authHeader === internalExpected;

  let actingUserId: string | null = null;
  let actingUserEmail: string | null = null;
  if (!internalOk) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    actingUserId = user.id;
    actingUserEmail = user.email ?? null;
  }

  // ---- Parse + validate body ----
  let body: SendBody;
  try {
    body = (await request.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const kind = body.kind ?? "text";
  const waId = body.wa_id?.trim();
  if (!waId) return NextResponse.json({ error: "wa_id is required" }, { status: 400 });

  // Diagnostic — proves whether the template_media_url field actually arrived.
  if (kind === "template") {
    console.log("[send-message] template body received:", {
      template_name: body.template_name,
      has_template_media_url: !!body.template_media_url,
      template_media_url: body.template_media_url ?? null,
    });
  }

  let payloadContent = "";
  let payloadType: "text" | "template" | "image" | "video" | "audio" | "document" = "text";
  let mediaMime: string | null = null;
  // Interactive reply-button sends: the parsed buttons + a numbered-text
  // fallback string for providers that can't render real buttons.
  let interactiveButtons: Array<{ id?: string; title: string }> = [];
  let interactiveFallbackText = "";

  if (kind === "text") {
    const text = body.text?.trim();
    if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
    if (text.length > 4096)
      return NextResponse.json({ error: "text too long (4096 max)" }, { status: 400 });
    payloadContent = text;
    payloadType = "text";
  } else if (kind === "template") {
    const name = body.template_name?.trim();
    if (!name) return NextResponse.json({ error: "template_name is required" }, { status: 400 });
    payloadContent = (body.template_body_preview?.trim() || `[template: ${name}]`).slice(0, 4096);
    payloadType = "template";
  } else if (kind === "interactive") {
    const bodyText = body.body_text?.trim() || body.text?.trim() || "";
    interactiveButtons = (body.buttons ?? [])
      .map((b) => ({ id: b.id, title: String(b.title ?? "").trim() }))
      .filter((b) => b.title);
    if (!bodyText) return NextResponse.json({ error: "body_text is required" }, { status: 400 });
    if (interactiveButtons.length === 0) return NextResponse.json({ error: "at least one button is required" }, { status: 400 });
    // Stored content = just the body; the buttons render as chips in the
    // dashboard (template_buttons below). The numbered-text fallback is for
    // providers (Evolution/Interakt) that can't send real reply buttons.
    payloadContent = bodyText.slice(0, 4096);
    interactiveFallbackText = [bodyText, ...interactiveButtons.map((b, i) => `${i + 1}. ${b.title}`)]
      .join("\n")
      .slice(0, 4096);
    payloadType = "text";
  } else if (kind === "media") {
    // Accept either a pre-uploaded Meta media_id (operator file upload) OR a
    // public media_url (trigger flows send images by URL — Meta/Evolution
    // both accept an http link directly, no upload step needed).
    if (!body.media_id && !body.media_url) return NextResponse.json({ error: "media_id or media_url required" }, { status: 400 });
    if (!body.media_kind) return NextResponse.json({ error: "media_kind required" }, { status: 400 });
    payloadType = body.media_kind;
    mediaMime = body.media_mime ?? null;
    // Bubble caption = the operator's text ONLY for image/video/audio. No
    // caption → empty (don't fall back to the filename, which showed up as
    // "image.png" under the image). Documents are the exception: the bubble
    // uses `content` as the file's display name, so keep the filename there.
    // The provider sends use body.caption directly, so this only affects what
    // we store/render.
    payloadContent = (
      body.caption?.trim() ||
      (body.media_kind === "document" ? body.filename : "") ||
      ""
    ).slice(0, 4096);
  } else if (kind === "rich") {
    // Rich quick reply: optional image/video header + text + a URL button.
    const text = body.text?.trim() || body.caption?.trim() || "";
    const hasMedia = !!body.media_url?.trim();
    if (!text && !hasMedia) {
      return NextResponse.json({ error: "rich needs text or media" }, { status: 400 });
    }
    payloadContent = text.slice(0, 4096);
    payloadType = hasMedia ? (body.media_kind === "video" ? "video" : "image") : "text";
    if (hasMedia) mediaMime = body.media_mime ?? (body.media_kind === "video" ? "video/mp4" : "image/jpeg");
  } else {
    return NextResponse.json({ error: "Unknown message kind" }, { status: 400 });
  }

  // Chat-list preview still needs a readable label so a caption-less media
  // row isn't blank in the sidebar.
  const listPreview =
    payloadContent || (kind === "media" ? `[${body.media_kind}]` : "");

  // ---- Resolve contact (create if missing) ----
  const admin = createServiceRoleClient();
  let contactId = body.contact_id;
  let businessPhoneNumberId: string | null = null;

  if (contactId) {
    const { data: existing } = await admin
      .from("contacts")
      .select("business_phone_number_id")
      .eq("id", contactId)
      .maybeSingle();
    businessPhoneNumberId = existing?.business_phone_number_id ?? null;
  } else {
    const { data: existing } = await admin
      .from("contacts")
      .select("id, business_phone_number_id")
      .eq("wa_id", waId)
      .maybeSingle();
    if (existing) {
      contactId = existing.id;
      businessPhoneNumberId = existing.business_phone_number_id ?? null;
    } else {
      businessPhoneNumberId = (await getCredential("whatsapp_phone_number_id")) ?? null;
      const { data: created, error: createErr } = await admin
        .from("contacts")
        .insert({
          wa_id: waId,
          last_message_preview: listPreview.slice(0, 120),
          business_phone_number_id: businessPhoneNumberId,
        })
        .select("id")
        .single();
      if (createErr || !created) {
        return NextResponse.json(
          { error: createErr?.message ?? "Failed to create contact" },
          { status: 500 },
        );
      }
      contactId = created.id;
    }
  }

  // ---- Permission check + provider resolution (run CONCURRENTLY) ----
  // Both only need businessPhoneNumberId, so we fire them together to cut a DB
  // round-trip off the send latency. The permission gate (a non-owner must be
  // assigned to this number) still returns 403 BEFORE any message is sent —
  // owner + internal-token callers bypass. Evolution/Interakt numbers branch
  // on providerRow below.
  interface ProviderRow {
    provider: "meta" | "evolution" | "interakt";
    evolution_instance_name: string | null;
    evolution_api_key: string | null;
    interakt_api_key: string | null;
  }
  let providerRow: ProviderRow | null = null;
  if (businessPhoneNumberId) {
    const [ctx, providerRes] = await Promise.all([
      internalOk
        ? Promise.resolve(null)
        : getCurrentEffectivePermissions(),
      admin
        .from("business_numbers")
        .select("provider, evolution_instance_name, evolution_api_key, interakt_api_key")
        .eq("phone_number_id", businessPhoneNumberId)
        .maybeSingle(),
    ]);
    if (
      ctx &&
      ctx.member.role !== "owner" &&
      !numberAllowed(ctx.perms, businessPhoneNumberId)
    ) {
      return NextResponse.json(
        {
          error:
            "Forbidden — you are not assigned to this WhatsApp number. Ask an owner to add it to your allowed numbers.",
        },
        { status: 403 },
      );
    }
    providerRow = (providerRes.data as ProviderRow | null) ?? null;
  }
  const isEvolution =
    providerRow?.provider === "evolution" &&
    !!providerRow?.evolution_instance_name &&
    !!providerRow?.evolution_api_key;
  const isInterakt = providerRow?.provider === "interakt";

  // ---- Send ----
  let waMessageId: string | null = null;
  try {
    if (isEvolution) {
      // Evolution path. Templates are Meta-only — reject. Otherwise
      // dispatch by kind. Evolution returns { key: { id } }; we map
      // it onto waMessageId so the mirror insert below is unchanged.
      if (kind === "template") {
        throw new Error(
          "Templates are not supported on Evolution (unofficial) numbers. Send a regular text or media message instead.",
        );
      }
      const instance = providerRow!.evolution_instance_name!;
      const apiKey = providerRow!.evolution_api_key!;
      const number = waId.replace(/\D/g, "");
      if (kind === "media") {
        const mediaKind = body.media_kind!;
        const mediaRef = body.media_id || body.media_url!;
        // Audio goes through sendMedia (mediatype:"audio"), NOT
        // sendWhatsAppAudio — the PTT path frequently fails with
        // "rate-overlimit" while a plain playable audio file sends fine.
        const r = await evolution.sendMedia({
          instanceName: instance,
          apiKey,
          number,
          mediatype:
            mediaKind === "image" || mediaKind === "video" || mediaKind === "audio" ? mediaKind : "document",
          media: mediaRef,
          mimetype: body.media_mime ?? undefined,
          caption: body.caption?.trim() || undefined,
          fileName: body.filename ?? (mediaKind === "audio" ? "voice.ogg" : undefined),
        });
        waMessageId = r.key?.id ?? null;
      } else {
        const r = await evolution.sendText({
          instanceName: instance,
          apiKey,
          number,
          text: kind === "interactive" ? interactiveFallbackText : payloadContent,
        });
        waMessageId = r.key?.id ?? null;
      }
    } else if (isInterakt) {
      // ---- Interakt path ----
      const key = providerRow!.interakt_api_key || (await getInteraktApiKey());
      if (!key) {
        throw new Error("Interakt API key not set. Add it in Settings → Interakt.");
      }
      if (kind === "template") {
        const { bodyValues, headerValues, fileName } = metaTemplateComponentsToInterakt(
          body.template_components,
        );
        const r = await sendInteraktTemplate(key, waId, {
          name: body.template_name!,
          languageCode: body.template_language || "en",
          bodyValues,
          headerValues,
          fileName,
        });
        waMessageId = r.messageId;
      } else if (kind === "media") {
        const mediaUrl = body.media_url?.trim();
        if (!mediaUrl) {
          throw new Error("Interakt media send needs a public media_url.");
        }
        const r = await sendInteraktMedia(key, waId, {
          kind: body.media_kind!,
          mediaUrl,
          message: body.caption?.trim() || "",
          fileName: body.filename ?? undefined,
        });
        waMessageId = r.messageId;
      } else {
        const r = await sendInteraktText(
          key,
          waId,
          kind === "interactive" ? interactiveFallbackText : payloadContent,
        );
        waMessageId = r.messageId;
      }
    } else {
      // ---- Meta path (unchanged) ----
      let resp;
      if (kind === "template") {
        resp = await sendTemplate(
          waId,
          body.template_name!,
          body.template_language || "en_US",
          body.template_components,
          businessPhoneNumberId ?? undefined,
        );
      } else if (kind === "media") {
        // media_id when uploaded; otherwise the public media_url — sendMedia
        // detects an http link and sends it as { link } instead of { id }.
        resp = await sendMedia(
          waId,
          body.media_kind!,
          body.media_id || body.media_url!,
          body.caption?.trim() || undefined,
          businessPhoneNumberId ?? undefined,
        );
      } else if (kind === "interactive") {
        resp = await sendInteractiveButtons(
          waId,
          payloadContent,
          interactiveButtons,
          businessPhoneNumberId ?? undefined,
        );
      } else if (kind === "rich") {
        const text = payloadContent || " ";
        const header = body.media_url?.trim()
          ? { kind: (body.media_kind === "video" ? "video" : "image") as "image" | "video", link: body.media_url.trim() }
          : null;
        const btns = body.rich_buttons ?? [];
        const replyBtns = btns.filter((b) => b.type === "quick_reply" && b.text?.trim());
        const urlBtn =
          btns.find((b) => b.type === "url" && b.text?.trim() && b.url?.trim()) ??
          (body.button_text?.trim() && body.button_url?.trim() ? { text: body.button_text.trim(), url: body.button_url.trim() } : null);
        // WhatsApp free-form: reply buttons (max 3) OR one URL button — not
        // both in one message. When mixed, send the reply buttons and fold the
        // URL into the body as a link line.
        if (replyBtns.length > 0) {
          const bodyText = urlBtn ? `${text}\n\n${urlBtn.text.trim()}: ${urlBtn.url!.trim()}`.slice(0, 1024) : text;
          resp = await sendInteractiveButtons(
            waId,
            bodyText,
            replyBtns.map((b) => ({ title: b.text.trim() })),
            businessPhoneNumberId ?? undefined,
            header,
          );
        } else if (urlBtn) {
          resp = await sendCtaUrl(waId, text, urlBtn.text.trim(), urlBtn.url!.trim(), header, businessPhoneNumberId ?? undefined);
        } else if (header) {
          resp = await sendMedia(waId, header.kind, header.link, payloadContent || undefined, businessPhoneNumberId ?? undefined);
        } else {
          resp = await sendTextMessage(waId, text, businessPhoneNumberId ?? undefined);
        }
      } else {
        resp = await sendTextMessage(
          waId,
          payloadContent,
          businessPhoneNumberId ?? undefined,
          body.reply_to_wa_message_id ?? null,
        );
      }
      waMessageId = resp.messages?.[0]?.id ?? null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "WhatsApp send failed";
    // Save the failed attempt for audit + return the inserted row to the
    // client so it can replace its optimistic bubble (otherwise polling
    // would later add the row as a duplicate).
    const { data: failedRow } = await admin
      .from("messages")
      .insert({
        contact_id: contactId,
        direction: "outbound",
        type: payloadType,
        content: payloadContent,
        media_mime_type: mediaMime,
        status: "failed",
        error_message: message,
        business_phone_number_id: businessPhoneNumberId,
        sent_by_user_id: actingUserId,
        sent_by_email: actingUserEmail,
      })
      .select("*")
      .single();
    return NextResponse.json({ error: message, message: failedRow }, { status: 502 });
  }

  // ---- Persist outbound message + bump contact preview ----
  const nowIso = new Date().toISOString();
  // Upsert (not insert) on wa_message_id: the provider's own webhook can echo
  // this same outbound message back to us and insert a row WITHOUT the sender
  // stamp (Interakt/Evolution don't tell us which dashboard user sent it). If
  // that echo wins the race, a plain insert would 23505-fail and the bubble
  // would show "WA" instead of the agent. Upserting lets our sender stamp win.
  const { data: inserted, error: insertErr } = await admin
    .from("messages")
    .upsert({
      contact_id: contactId,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: payloadType,
      content: payloadContent,
      // For "media" kind: the uploaded file URL.
      // For "template" kind: the header image URL if one was uploaded for
      // the template send (so the bubble can render the same header).
      media_url:
        kind === "media"
          ? body.media_url ?? null
          : kind === "template"
            ? body.template_media_url ?? null
            : kind === "rich"
              ? body.media_url ?? null
              : null,
      media_mime_type:
        kind === "template" && body.template_media_url
          ? body.template_media_mime ?? mediaMime ?? "image/*"
          : mediaMime,
      status: "sent",
      timestamp: nowIso,
      business_phone_number_id: businessPhoneNumberId,
      // Template card metadata — only populated for kind='template'.
      template_name: kind === "template" ? body.template_name ?? null : null,
      template_footer: kind === "template" ? body.template_footer ?? null : null,
      template_buttons:
        kind === "template" && body.template_buttons && body.template_buttons.length > 0
          ? body.template_buttons
          : kind === "interactive" && interactiveButtons.length > 0
            ? interactiveButtons.map((b) => ({ type: "QUICK_REPLY", text: b.title }))
            : kind === "rich"
              ? (() => {
                  const out = (body.rich_buttons ?? [])
                    .filter((b) => b.text?.trim())
                    .map((b) => (b.type === "url" ? { type: "URL", text: b.text.trim(), url: b.url?.trim() } : { type: "QUICK_REPLY", text: b.text.trim() }));
                  if (out.length === 0 && body.button_text?.trim() && body.button_url?.trim()) {
                    out.push({ type: "URL", text: body.button_text.trim(), url: body.button_url.trim() });
                  }
                  return out.length > 0 ? out : null;
                })()
              : null,
      // Audit who sent — used for the sender avatar + tooltip in the bubble.
      sent_by_user_id: actingUserId,
      sent_by_email: actingUserEmail,
      // Quoted-reply context — persisted so the bubble can render the
      // quote header alongside the body on every re-fetch.
      reply_to_wa_message_id: body.reply_to_wa_message_id ?? null,
      reply_to_content:
        body.reply_to_wa_message_id ? body.reply_to_content ?? null : null,
      reply_to_direction:
        body.reply_to_wa_message_id ? body.reply_to_direction ?? null : null,
    }, { onConflict: "wa_message_id" })
    .select("*")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Fire-and-forget — the inbox preview updates via realtime/poll, so don't
  // make the operator's send wait on this write to return.
  void admin
    .from("contacts")
    .update({
      last_message_at: nowIso,
      last_message_preview: listPreview.slice(0, 120),
      last_message_direction: "outbound",
      last_message_status: "sent",
    })
    .eq("id", contactId)
    .then(() => {}, () => {});

  // Log this outbound onto the LSQ activity timeline. Fire-and-forget
  // — never block the send response on it. Lazy import keeps this
  // route's cold start fast when LSQ isn't configured.
  if (contactId) {
    const finalContactId = contactId;
    void import("@/lib/lsq-message-logger").then(({ logWhatsappActivityToLSQ }) =>
      logWhatsappActivityToLSQ({
        contactId: finalContactId,
        direction: "Outbound",
        text: payloadContent,
        businessPhoneNumberId,
        timestamp: nowIso,
      }),
    ).catch(() => {});
  }

  return NextResponse.json({ message: inserted }, { status: 200 });
}
