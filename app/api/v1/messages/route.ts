// POST /api/v1/messages — public relay to Meta's WhatsApp Cloud API.
//
// Auth: `Authorization: Bearer qht_...` where the token is issued from
// Settings → Numbers → API tokens. The token determines which business
// phone number the call targets; the portfolio's Meta access-token
// (loaded from .env.local on this server) is then used to actually call
// Meta. The integrator never sees the Meta credential.
//
// Body: same shape as Meta's POST /v22.0/{phone-number-id}/messages.
// We forward 1:1, then mirror the send into our `messages` table so the
// outbound shows up in the dashboard chat and future status-webhook
// events (sent / delivered / read / failed) can attach to it.
//
// This is the auth-only relay — see /api/v1/media for the multipart
// upload counterpart.

import { NextResponse, type NextRequest } from "next/server";
import { bearerFrom, resolveApiToken, logApiRequest } from "@/lib/api-tokens";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";
import { getApiVersion } from "@/lib/whatsapp";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { renderTemplatePreview, validateTemplatePayload } from "@/lib/template-preview";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const ua = request.headers.get("user-agent");
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    null;
  const logHit = (
    status: number,
    tokenCtx?: { id?: string | null; name?: string | null; bpid?: string | null },
  ): void =>
    logApiRequest({
      tokenId: tokenCtx?.id ?? null,
      tokenName: tokenCtx?.name ?? null,
      businessPhoneNumberId: tokenCtx?.bpid ?? null,
      method: "POST",
      path: "/api/v1/messages",
      status,
      durationMs: Date.now() - startedAt,
      userAgent: ua,
      sourceIp: ip,
    });

  const bearer = bearerFrom(request.headers);
  if (!bearer) {
    logHit(401);
    return NextResponse.json(
      { error: "Missing Authorization: Bearer <token>" },
      { status: 401 },
    );
  }
  const tok = await resolveApiToken(bearer);
  if (!tok) {
    logHit(401);
    return NextResponse.json(
      { error: "Invalid or disabled API token" },
      { status: 401 },
    );
  }
  const tokCtx = { id: tok.id, name: tok.name, bpid: tok.business_phone_number_id };

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    logHit(400, tokCtx);
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Meta requires messaging_product=whatsapp on every send. Inject it
  // if the caller forgot — saves them a confusing 400.
  if (!body.messaging_product) body.messaging_product = "whatsapp";

  const creds = await resolveCredsForPhoneNumberId(tok.business_phone_number_id);
  if (!creds) {
    logHit(500, tokCtx);
    return NextResponse.json(
      {
        error: `No portfolio creds configured for phone_number_id ${tok.business_phone_number_id}`,
      },
      { status: 500 },
    );
  }
  const apiVersion = await getApiVersion();
  const url = `https://graph.facebook.com/${apiVersion}/${tok.business_phone_number_id}/messages`;

  // Pre-send validation for template messages — catches the most common
  // cause of Meta's vague "(#135000) Generic user error" (missing header
  // / wrong body var count / missing URL button param). Caller sees a
  // specific message instead of guessing.
  if (body.type === "template") {
    const problems = await validateTemplatePayload({
      waba_id: creds.business_account_id,
      access_token: creds.access_token,
      body,
    });
    if (problems.length > 0) {
      logHit(400, tokCtx);
      return NextResponse.json(
        {
          error: {
            message: "Template payload incomplete — Meta would return (#135000)",
            code: 135000,
            details: problems,
          },
          _qht: { mirror: "skipped", validation_failed: true },
        },
        { status: 400 },
      );
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  // Mirror Meta's status + JSON. Always parse — even on error, the body
  // carries useful diagnostics ({ error: { message, code, type } }).
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string };
  };

  // Mirror successful sends into our local DB so the dashboard chat
  // shows them and future status webhooks can update them. We AWAIT
  // this now (instead of fire-and-forget) so the n8n response includes
  // a diagnostic block — if it failed, the operator sees exactly why
  // without spelunking through pm2 logs.
  let qhtDiag: { mirror: "ok" | "skipped" | "error"; message?: string } = {
    mirror: "skipped",
  };
  if (res.ok && json.messages?.[0]?.id) {
    const waMessageId = json.messages[0].id;
    try {
      await mirrorOutboundToDb(
        body,
        tok.business_phone_number_id,
        waMessageId,
        creds.access_token,
        creds.business_account_id,
        tok.name,
        tok.created_by_user_id,
      );
      qhtDiag = { mirror: "ok" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[/api/v1/messages] DB mirror failed:", msg);
      qhtDiag = { mirror: "error", message: msg };
      // Persist on the api_token row so the Numbers → API tokens panel
      // surfaces the last failure (same pattern as outbound webhooks).
      try {
        const admin = createServiceRoleClient();
        await admin
          .from("api_tokens")
          .update({
            last_used_at: new Date().toISOString(),
            // Repurposing request_count's neighbour — we don't have a
            // dedicated last_error column yet, so log to console as the
            // primary surface for now.
          })
          .eq("id", tok.id);
      } catch {
        // ignore
      }
    }
  }

  logHit(res.status, tokCtx);
  return NextResponse.json({ ...json, _qht: qhtDiag }, { status: res.status });
}

// ---------------------------------------------------------------------
// DB mirror — upsert the contact (if new) and insert an outbound
// `messages` row so the dashboard chat reflects the send and Meta's
// status webhooks (sent/delivered/read/failed) can find their target.
// ---------------------------------------------------------------------
async function mirrorOutboundToDb(
  body: Record<string, unknown>,
  bpid: string,
  waMessageId: string,
  accessToken: string,
  wabaId: string | null,
  tokenName: string,
  createdByUserId: string | null,
): Promise<void> {
  const to = typeof body.to === "string" ? body.to.replace(/\D/g, "") : "";
  if (!to) {
    throw new Error(`Missing 'to' in body — got ${JSON.stringify(body.to)}`);
  }
  const admin = createServiceRoleClient();

  // 1) Upsert contact via the composite unique index from migration
  //    0016: (wa_id, business_phone_number_id). Single statement so a
  //    race between two parallel relay calls doesn't 23505 us.
  let contactId: string | null = null;
  {
    const { data: upserted, error: upErr } = await admin
      .from("contacts")
      .upsert(
        {
          wa_id: to,
          business_phone_number_id: bpid,
          status: "open",
        },
        { onConflict: "wa_id,business_phone_number_id", ignoreDuplicates: false },
      )
      .select("id")
      .single();
    if (upErr) {
      throw new Error(`Contact upsert failed: ${upErr.message}`);
    }
    contactId = (upserted?.id as string | undefined) ?? null;
  }
  if (!contactId) throw new Error("Contact upsert returned no id");

  const { type, content: fallbackContent, mime } = previewFromBody(body);
  const nowIso = new Date().toISOString();

  // For templates, ask Meta what the approved template looks like and
  // substitute the variables we just sent — body text, footer, header,
  // and buttons. Falls back to the bare placeholder if the lookup
  // fails so the bubble at least shows *something*.
  let content = fallbackContent;
  let templateFooter: string | null = null;
  let templateButtons: unknown[] | null = null;
  let mediaUrl: string | null = null;
  let mediaMime: string | null = mime;
  if (type === "template") {
    const rendered = await renderTemplatePreview({
      waba_id: wabaId,
      access_token: accessToken,
      body,
    });
    if (rendered?.text) {
      // Body (with header text + substituted vars)
      content = rendered.header_text
        ? `${rendered.header_text}\n\n${rendered.text}`
        : rendered.text;
      templateFooter = rendered.footer;
      // Buttons in the same shape the dashboard's MessageBubble already
      // renders — {type, text, url?, phone_number?}.
      templateButtons = rendered.buttons.length > 0 ? rendered.buttons : null;
      if (rendered.header_media_url) {
        mediaUrl = rendered.header_media_url;
        mediaMime = "image/*";
      }
    }
  }

  const { error: msgErr } = await admin.from("messages").insert({
    contact_id: contactId,
    wa_message_id: waMessageId,
    direction: "outbound",
    type,
    content,
    media_url: mediaUrl,
    media_mime_type: mediaMime,
    status: "sent",
    timestamp: nowIso,
    business_phone_number_id: bpid,
    template_footer: templateFooter,
    template_buttons: templateButtons,
    // Tag the row so the dashboard chat shows an "API" chip instead of
    // a person's initials. Token name goes after the prefix so the
    // tooltip can reveal which integration sent it.
    sent_by_email: `api:${tokenName}`,
    // Stamp the human who generated this token so the chat can also show
    // "by <person>" under the API chip.
    sent_by_user_id: createdByUserId,
  });
  if (msgErr) {
    throw new Error(`messages insert failed: ${msgErr.message}`);
  }

  const { error: cErr } = await admin
    .from("contacts")
    .update({
      last_message_at: nowIso,
      last_message_preview: content.slice(0, 120),
      last_message_direction: "outbound",
      last_message_status: "sent",
    })
    .eq("id", contactId);
  if (cErr) {
    // Non-fatal — the message row exists, just the contact preview
    // didn't update. Surface in the diagnostic but don't fail.
    console.warn("[/api/v1/messages] contacts preview update failed:", cErr.message);
  }
}

// Best-effort preview text for the dashboard chat bubble. Each Meta
// message type carries its body in a different shape; pick the right
// one or fall back to a bracketed marker so the bubble isn't empty.
function previewFromBody(body: Record<string, unknown>): {
  type: string;
  content: string;
  mime: string | null;
} {
  const t = (body.type as string | undefined) ?? "text";
  switch (t) {
    case "text":
      return {
        type: "text",
        content: ((body.text as { body?: string } | undefined)?.body ?? "").toString(),
        mime: null,
      };
    case "template": {
      const tpl = body.template as { name?: string } | undefined;
      return { type: "template", content: `[Template: ${tpl?.name ?? "—"}]`, mime: null };
    }
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const m = body[t] as { caption?: string } | undefined;
      const cap = (m?.caption ?? "").toString();
      return {
        type: t,
        content: cap || `[${t}]`,
        mime: t === "image" ? "image/*" : t === "video" ? "video/*" : t === "audio" ? "audio/*" : t === "document" ? "application/*" : "image/webp",
      };
    }
    case "interactive":
      return { type: "interactive", content: "[Interactive]", mime: null };
    case "reaction": {
      const r = body.reaction as { emoji?: string } | undefined;
      return { type: "reaction", content: r?.emoji ?? "[reaction]", mime: null };
    }
    case "location":
      return { type: "location", content: "[Location]", mime: null };
    default:
      return { type: t, content: `[${t}]`, mime: null };
  }
}

