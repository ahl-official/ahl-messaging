import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { fetchPhoneNumberDetails, getApiVersion } from "@/lib/whatsapp";
import { uploadMediaBytes } from "@/lib/storage";
import { getCredential } from "@/lib/credentials";
import {
  getPortfolioByVerifyToken,
  getPortfolioByPhoneNumberId,
  listPortfolios,
  resolveCredsForPhoneNumberId,
} from "@/lib/portfolios";
import { dispatchOutboundWebhook } from "@/lib/outbound-webhooks";
import { broadcastInbox } from "@/lib/realtime-inbox";
import { parseUtm, buildReferralParams, attributionLabel } from "@/lib/utm";

async function downloadInboundMedia(
  mediaId: string,
  fallbackMime: string,
  receivingPhoneNumberId: string,
): Promise<{ url: string; mime: string } | null> {
  // Retry the whole flow up to 5× with exponential backoff (1s / 2s /
  // 4s / 8s / 16s — total ~31s). Meta media URLs stay valid for 5
  // minutes so we have headroom; 3 attempts was losing photos in
  // bursts of 6+ when their CDN throttled. Each attempt fetches the
  // short-lived URL fresh, so a transient 401/429 on attempt 1
  // doesn't poison the rest.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const creds = await resolveCredsForPhoneNumberId(receivingPhoneNumberId);
      const apiVersion = await getApiVersion();
      const token = creds?.access_token;
      if (!token) return null;

      const metaRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/${mediaId}?fields=url,mime_type`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      );
      if (!metaRes.ok) {
        if (attempt < 5) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        return null;
      }
      const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
      if (!meta.url) {
        if (attempt < 5) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        return null;
      }

      const dlRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!dlRes.ok) {
        if (attempt < 5) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        return null;
      }
      const bytes = await dlRes.arrayBuffer();
      const mime = meta.mime_type ?? fallbackMime;

      const { publicUrl } = await uploadMediaBytes(bytes, {
        mime,
        folder: "inbound",
        suggestedName: mediaId,
      });
      return { url: publicUrl, mime };
    } catch (e) {
      console.warn(
        `[webhook] media download attempt ${attempt} failed:`,
        e instanceof Error ? e.message : e,
      );
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  console.error(`[webhook] media download GAVE UP for ${mediaId}`);
  return null;
}

function mediaIdOf(msg: WAMessage): string | null {
  return (
    msg.image?.id ??
    msg.video?.id ??
    msg.audio?.id ??
    msg.document?.id ??
    msg.sticker?.id ??
    null
  );
}

// Ordered status rank — higher = further along the delivery lifecycle. Used
// when handling out-of-order webhook events to prevent downgrades.
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 99,
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// =====================================================================
// GET — Meta verification handshake
// =====================================================================
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  // Multi-portfolio: each Meta App has its own verify token. Match the
  // incoming token against any active portfolio in .env.local.
  const portfolio = await getPortfolioByVerifyToken(token);
  if (!portfolio) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

// =====================================================================
// POST — incoming messages + status updates
// Must respond 200 within 5s. Heavy work happens in waitUntil.
// =====================================================================
type WAContact = { wa_id: string; profile?: { name?: string } };
type WAMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  sticker?: { id: string; mime_type?: string; animated?: boolean };
  // Customer shared a location (live or static). lat/lng always present;
  // name/address are optional (only when they picked a named place).
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  // Customer reacted to one of our messages with an emoji. Empty emoji =
  // they removed their reaction.
  reaction?: { message_id?: string; emoji?: string };
  // Customer tapped a Quick Reply button on a template message (legacy
  // template button reply shape).
  button?: { payload?: string; text?: string };
  // Customer tapped a button or list option on an interactive message.
  interactive?: {
    type?: "button_reply" | "list_reply" | "call_permission_reply";
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
    // Patient's response to a Call Permission Request. `response` is
    // "accept" or "reject"; `expiration_timestamp` (epoch sec) is set on
    // accept and tells us when the grant lapses.
    call_permission_reply?: {
      response?: "accept" | "reject";
      response_source?: string;
      expiration_timestamp?: number;
    };
  };
  // Click-to-WhatsApp ad/post the lead tapped to start the chat. Present
  // only on the first inbound of an ad-sourced conversation. Invisible to
  // the lead — the attribution rides here, not in the message body.
  referral?: {
    source_url?: string;
    source_id?: string;
    source_type?: string;
    headline?: string;
    body?: string;
    media_type?: string;
    ctwa_clid?: string;
  };
};
type WAStatus = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  errors?: { title?: string; message?: string }[];
};
// WhatsApp Cloud Calling — webhook event for a call leg.
//
// Meta sends one entry per state transition:
//   event = "connect"   → the user (inbound) or business (outbound) is dialing.
//                         Carries the SDP offer for the WebRTC route.
//   event = "accept"    → call answered. SDP answer present when applicable.
//   event = "reject"    → user declined.
//   event = "terminate" → call ended (either side hung up, or it was missed).
//
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/calling
type WACallEvent = {
  id: string;
  from?: string;
  to?: string;
  /** "connect" | "accept" | "reject" | "terminate" */
  event: string;
  /** "user_initiated" | "business_initiated" */
  direction?: string;
  timestamp?: string;
  /** WebRTC SDP. `offer` arrives on connect, `answer` on accept. */
  session?: { sdp?: string; sdp_type?: "offer" | "answer" };
  /** Free-form reason from Meta — populated on reject/terminate. */
  status?: { code?: string; message?: string };
};
type WAChange = {
  field: string;
  value: {
    messaging_product?: "whatsapp";
    metadata?: { display_phone_number: string; phone_number_id: string };
    contacts?: WAContact[];
    messages?: WAMessage[];
    statuses?: WAStatus[];
    calls?: WACallEvent[];
  };
};
type WAEntry = { id: string; changes: WAChange[] };
type WAWebhookBody = { object: string; entry: WAEntry[] };

// Verify Meta's X-Hub-Signature-256 against the raw body.
//   "ok"      → a configured APP_SECRET produced a matching HMAC
//   "invalid" → a secret is configured but the signature is missing/wrong
//   "skip"    → no APP_SECRET is configured anywhere (legacy deploy) — we
//               proceed but log a loud warning so the gap is visible.
async function verifyMetaSignature(
  raw: string,
  header: string | null,
  phoneNumberId: string | null,
): Promise<"ok" | "invalid" | "skip"> {
  // Verify against the secret of the portfolio THIS event belongs to, and
  // only that one. Verification is opt-in PER portfolio: if the resolved
  // portfolio has no APP_SECRET configured we skip (can't verify), rather
  // than trying other portfolios' secrets — those belong to different Meta
  // apps and would always fail, wrongly rejecting (403) a legitimate event.
  // Only when we can't resolve the portfolio at all (missing metadata) do we
  // fall back to trying every configured secret.
  const resolved = phoneNumberId
    ? await getPortfolioByPhoneNumberId(phoneNumberId)
    : null;
  const secrets = (
    resolved
      ? resolved.app_secret
        ? [resolved.app_secret]
        : []
      : listPortfolios().map((p) => p.app_secret)
  ).filter((s): s is string => Boolean(s));

  if (secrets.length === 0) {
    console.warn(
      `[webhook] APP_SECRET not configured for portfolio "${resolved?.key ?? "unknown"}" — skipping signature verification. Set PORTFOLIO_<KEY>_APP_SECRET in .env.local to enforce it.`,
    );
    return "skip";
  }
  if (!header || !header.startsWith("sha256=")) return "invalid";
  const provided = Buffer.from(header.slice("sha256=".length), "utf8");
  for (const secret of secrets) {
    const expected = Buffer.from(
      createHmac("sha256", secret).update(raw, "utf8").digest("hex"),
      "utf8",
    );
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return "ok";
    }
  }
  return "invalid";
}

export async function POST(request: NextRequest) {
  // Read the RAW body once — needed both to verify Meta's HMAC signature
  // (which must match byte-for-byte) and to parse the event.
  const raw = await request.text();
  let body: WAWebhookBody;
  try {
    body = JSON.parse(raw) as WAWebhookBody;
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  // ---- Verify X-Hub-Signature-256 -------------------------------------
  // Meta signs every event POST with HMAC-SHA256(rawBody, APP_SECRET).
  // Without this check, anyone could forge inbound messages / statuses.
  const phoneId =
    body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null;
  const sigState = await verifyMetaSignature(
    raw,
    request.headers.get("x-hub-signature-256"),
    phoneId,
  );
  if (sigState === "invalid") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Ack Meta IMMEDIATELY, then process in the background. The media
  // download inside processWebhook can take up to ~31s of (I/O-bound)
  // retries; awaiting it kept the webhook request open past Meta's 5s
  // budget and triggered a retry-storm that compounded load. On the
  // long-lived pm2 process the un-awaited promise runs to completion;
  // the message insert happens within ~100ms so loss-on-crash is a
  // negligible window, and we already 200'd on processing errors before.
  void processWebhook(body).catch((err) => {
    console.error(
      "[webhook] processing error:",
      err instanceof Error ? err.message : err,
    );
  });

  return new NextResponse("OK", { status: 200 });
}

async function processWebhook(body: WAWebhookBody) {
  if (body.object !== "whatsapp_business_account") return;

  const supabase = createServiceRoleClient();

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      // ---- Identify which business number this event is for ----
      const businessPhoneNumberId = value.metadata?.phone_number_id ?? null;
      if (businessPhoneNumberId) {
        await ensureBusinessNumber(
          supabase,
          businessPhoneNumberId,
          value.metadata?.display_phone_number ?? null,
        );
      }

      // Build a wa_id -> profile_name map for this batch
      const contactProfile: Record<string, string | undefined> = {};
      for (const c of value.contacts ?? []) {
        contactProfile[c.wa_id] = c.profile?.name;
      }

      // ---- Inbound messages ----
      for (const msg of value.messages ?? []) {
        const waId = msg.from;
        const profileName = contactProfile[waId];

        // Drop "unsupported" type entirely. Meta sends this when its
        // own classifier can't determine the message kind (oversize
        // images, exotic formats, signal-protocol hiccups, etc.).
        // Inserting the row would leave a [unsupported] bubble with
        // no recoverable content — pure noise. Log the raw payload
        // for diagnosis but skip the DB write + automation pipeline.
        if (msg.type === "unsupported") {
          console.warn(
            `[webhook] skipping unsupported message from ${waId}, wamid=${msg.id} payload=${JSON.stringify(msg).slice(0, 500)}`,
          );
          continue;
        }

        // Meta retries webhooks on 5xx / timeout, so we may see the same
        // message twice. Skip the heavy work (media download, unread bump)
        // if we already have a row with this wa_message_id.
        const { data: existingMessage } = await supabase
          .from("messages")
          .select("id")
          .eq("wa_message_id", msg.id)
          .maybeSingle();
        if (existingMessage) continue;

        // Upsert contact. `status: 'open'` is critical — a new inbound means
        // the customer is re-engaging, so any prior 'closed' state (manual
        // resolve OR auto-close from a stale 24h window) should reset.
        // Without this the chat would stay in the "Closed" filter even
        // though the conversation has fresh activity.
        const { data: contact, error: upsertErr } = await supabase
          .from("contacts")
          .upsert(
            {
              wa_id: waId,
              profile_name: profileName ?? null,
              status: "open",
              last_message_at: new Date(Number(msg.timestamp) * 1000).toISOString(),
              // Opens/extends the 24h customer-service window — the inbox's
              // real-time "Open" check runs off this exact timestamp.
              last_inbound_at: new Date(Number(msg.timestamp) * 1000).toISOString(),
              last_message_preview: previewOf(msg),
              // Inbound from customer — surfaces the "Reply" CTA on the
              // contact list row. "received" is a synthetic status (not a
              // real Meta delivery state) so the renderer can distinguish
              // inbound messages from outbound ones in tick logic.
              last_message_direction: "inbound",
              last_message_status: "received",
              business_phone_number_id: businessPhoneNumberId,
            },
            { onConflict: "wa_id,business_phone_number_id" },
          )
          .select("id, unread_count")
          .single();

        if (upsertErr || !contact) {
          console.error("[webhook] upsert contact failed:", upsertErr?.message);
          continue;
        }

        // Atomic unread bump (see migration 0084) — avoids the read-modify-
        // write race where two parallel inbound messages lose an increment.
        await supabase.rpc("bump_unread", { p_contact_id: contact.id });

        // For media types, download from Meta + cache in Supabase Storage
        let mediaUrl: string | null = null;
        let mediaMime: string | null = extractMime(msg);
        const mediaId = mediaIdOf(msg);
        if (mediaId) {
          const downloaded = await downloadInboundMedia(
            mediaId,
            mediaMime ?? "application/octet-stream",
            businessPhoneNumberId ?? "",
          );
          if (downloaded) {
            mediaUrl = downloaded.url;
            mediaMime = downloaded.mime;
          }
        }

        // Remap interactive call_permission_reply onto its own row type so
        // the dashboard can render a dedicated bubble + update the
        // permissions table below.
        const cprResponse = isCallPermissionReply(msg) ? callPermissionResponse(msg) : null;
        const storedType = cprResponse ? "call_permission_reply" : msg.type;
        const storedContent = cprResponse
          ? cprResponse === "accept"
            ? "✅ Patient granted call permission. You can place WhatsApp calls."
            : "🚫 Patient denied call permission."
          : extractContent(msg);

        // Quoted-reply context — when the customer swipe-replies to one
        // of our outbound messages, Meta sends `context.id` pointing at
        // the original wamid. Capture it + cache a snippet of the
        // quoted message body so the dashboard bubble can render the
        // quote header without a per-row lookup.
        let replyToWamid: string | null = null;
        let replyToContent: string | null = null;
        let replyToDirection: "inbound" | "outbound" | null = null;
        const rawCtx = (msg as { context?: { id?: string } }).context;
        if (rawCtx?.id) {
          replyToWamid = rawCtx.id;
          const { data: quoted } = await supabase
            .from("messages")
            .select("content, direction")
            .eq("wa_message_id", rawCtx.id)
            .maybeSingle();
          if (quoted) {
            replyToContent = (quoted.content as string | null) ?? null;
            replyToDirection =
              ((quoted.direction as "inbound" | "outbound") ?? null);
          }
        }

        // Insert message
        const { data: insertedRow, error: insertErr } = await supabase
          .from("messages")
          .insert({
            contact_id: contact.id,
            wa_message_id: msg.id,
            direction: "inbound",
            type: storedType,
            content: storedContent,
            media_url: mediaUrl,
            media_mime_type: mediaMime,
            status: "delivered",
            timestamp: new Date(Number(msg.timestamp) * 1000).toISOString(),
            business_phone_number_id: businessPhoneNumberId,
            raw_payload: msg as unknown as object,
            reply_to_wa_message_id: replyToWamid,
            reply_to_content: replyToContent,
            reply_to_direction: replyToDirection,
          })
          .select("id")
          .single();

        // Push the inbox live the instant this message lands — independent
        // of RLS-gated postgres_changes (see lib/realtime-inbox).
        void broadcastInbox({
          business_phone_number_id: businessPhoneNumberId,
          contact_id: contact.id,
          wa_id: waId,
          direction: "inbound",
        });

        // Persist the patient's accept/reject onto whatsapp_call_permissions
        // so the next dial bypasses CPR (for accept) or surfaces the
        // denial (for reject).
        if (cprResponse) {
          const expiresAt = msg.interactive?.call_permission_reply?.expiration_timestamp;
          await supabase
            .from("whatsapp_call_permissions")
            .upsert(
              {
                contact_id: contact.id,
                state: cprResponse === "accept" ? "granted" : "denied",
                granted_at: cprResponse === "accept" ? new Date().toISOString() : null,
                expires_at:
                  cprResponse === "accept" && expiresAt
                    ? new Date(expiresAt * 1000).toISOString()
                    : null,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "contact_id" },
            );
        }
        if (insertErr && insertErr.code !== "23505") {
          // 23505 = duplicate wa_message_id (Meta retried between our check
          // above and the insert). Safe to ignore.
          console.error("[webhook] insert message failed:", insertErr.message);
        }

        // Fire-and-forget AI auto-reply trigger. We don't `await` so the
        // webhook stays under Meta's 5s response budget; the processor
        // route handles its own DB writes + send. If automation is off
        // or the contact doesn't qualify, the processor logs "skipped".
        // Log this inbound onto the LSQ activity timeline. Fire-and-
        // forget — never blocks the webhook ack. The helper exits early
        // if the contact doesn't have an LSQ prospect_id yet.
        //
        // Skip image messages here — /api/lsq/photo-received fires
        // separately and creates a richer "Received Image" activity
        // with the photo attached. Logging both would produce a
        // duplicate "[no text]" inbound activity.
        if (insertedRow && msg.type !== "image") {
          import("@/lib/lsq-message-logger").then(({ logWhatsappActivityToLSQ }) => {
            void logWhatsappActivityToLSQ({
              contactId: contact.id,
              direction: "Inbound",
              text: extractContent(msg) ?? "",
              businessPhoneNumberId,
              timestamp: new Date(Number(msg.timestamp) * 1000).toISOString(),
            });
          }).catch(() => {});
        }

        // Campaign reply tracking — if this contact recently received a
        // campaign message, mark their recipient row as 'replied'. STOP
        // keyword (any case-insensitive variant) triggers a permanent
        // opt-out so future campaigns skip them.
        const inboundText = (extractContent(msg) ?? "").trim();

        // Campaign attribution — a Click-to-WhatsApp ad attaches a
        // `referral` object (source_id / ctwa_clid / source_url, invisible
        // to the lead), while a wa.me?text=... link drops utm_*/source_id
        // into the first message text. Prefer the referral; fall back to
        // the text marker. Stamp it on the contact ONCE; the
        // `.is(utm_source, null)` guard preserves first-touch attribution.
        const attribution =
          buildReferralParams(msg.referral) ?? parseUtm(inboundText);
        if (attribution) {
          await supabase
            .from("contacts")
            .update({
              utm_source: attributionLabel(attribution),
              utm_params: attribution,
            })
            .eq("id", contact.id)
            .is("utm_source", null);
        }

        const isStop = /^(stop|unsubscribe|stop all|opt out|optout|unsub|band karo|rok do|stop kar)$/i.test(inboundText);
        if (isStop && businessPhoneNumberId) {
          await supabase.from("campaign_unsubscribes").upsert(
            {
              wa_id: waId,
              business_phone_number_id: businessPhoneNumberId,
              source: "stop_reply",
            },
            { onConflict: "wa_id,business_phone_number_id" },
          );
        }
        // Find the most recent sent recipient row for this wa_id and
        // mark it replied. The narrow 7-day window keeps an old reply
        // from re-flagging an ancient campaign.
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: recentRecipient } = await supabase
          .from("campaign_recipients")
          .select("id, status, campaign_id")
          .eq("wa_id", waId)
          .gte("sent_at", sevenDaysAgo)
          .in("status", ["sent", "delivered", "read"])
          .order("sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (recentRecipient) {
          // Was this a button tap on the template we sent? buttonLabel()
          // already extracts the visible button text from button /
          // interactive messages. Capture it on the recipient row so
          // the campaign detail page can show button-by-button click
          // counts.
          const isButtonReply = msg.type === "button" || msg.type === "interactive";
          const buttonText = isButtonReply ? buttonLabel(msg) : null;
          const replyText = inboundText.slice(0, 1000) || null;
          // Mark replied using ONLY guaranteed columns. The reply_text /
          // button_clicked columns may not exist on older schemas; bundling
          // them here would fail the WHOLE update, leaving the recipient
          // un-marked (so Replied count + CTR stayed at 0).
          await supabase
            .from("campaign_recipients")
            .update({
              status: isStop ? "unsubscribed" : "replied",
              replied_at: new Date().toISOString(),
            })
            .eq("id", recentRecipient.id);
          // Best-effort extras — tolerate the columns being absent.
          const extras: Record<string, unknown> = {};
          if (replyText) extras.reply_text = replyText;
          if (buttonText) {
            extras.button_clicked = buttonText;
            extras.button_clicked_at = new Date().toISOString();
          }
          if (Object.keys(extras).length > 0) {
            const { error: exErr } = await supabase
              .from("campaign_recipients")
              .update(extras)
              .eq("id", recentRecipient.id);
            if (exErr) {
              console.warn(
                `[webhook] campaign reply extras skipped (run migration 0094): ${exErr.message}`,
              );
            }
          }
          // Roll the reply up onto the campaign counters now — a completed
          // campaign no longer ticks, so without this the Replied count
          // (and reply rate) stays stuck at 0 even as patients reply.
          if (recentRecipient.campaign_id) {
            const { recomputeCounters } = await import("@/lib/campaigns");
            await recomputeCounters(recentRecipient.campaign_id as string).catch(() => {});
          }
        }

        if (insertedRow) {
          const internalToken = await getCredential("webhook_internal_token");
          if (internalToken) {
            const origin =
              process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

            // Audio inbound: skip the immediate automation trigger.
            // The /transcribe route fires it AFTER Whisper finishes
            // so the bot's history reader sees the transcribed text
            // instead of an empty content field. Other types fire
            // automation right away.
            const isAudioMsg =
              msg.type === "audio" ||
              (msg.type as string) === "voice" ||
              (mediaMime ?? "").startsWith("audio/");
            if (!isAudioMsg) {
              fetch(`${origin}/api/automation/process`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contact_id: contact.id,
                  trigger_message_id: insertedRow.id,
                  token: internalToken,
                }),
              }).catch((e) => {
                console.error(
                  "[webhook] automation trigger failed:",
                  e instanceof Error ? e.message : e,
                );
              });
            }

            // Fire-and-forget LSQ lead create-or-update. Idempotent —
            // the route exits immediately if the contact already has
            // a cached prospect_id. First WhatsApp message from a new
            // number ⇒ a fresh LSQ lead is created automatically;
            // existing leads get matched by phone and refreshed.
            fetch(`${origin}/api/lsq/ensure-lead`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contact_id: contact.id,
                token: internalToken,
              }),
            }).catch((e) => {
              console.error(
                "[webhook] LSQ ensure-lead failed:",
                e instanceof Error ? e.message : e,
              );
            });

            // Fire-and-forget photo pipeline — runs only when the
            // inbound is an image AND we have it cached locally
            // (downloadInboundMedia fills mediaUrl). Creates a
            // "Received Image" activity in LSQ, uploads the bytes,
            // links them as an attachment, and conditionally bumps
            // ProspectStage based on the per-number config.
            if (msg.type === "image" && mediaUrl) {
              fetch(`${origin}/api/lsq/photo-received`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contact_id: contact.id,
                  media_url: mediaUrl,
                  media_mime: mediaMime,
                  timestamp: new Date(
                    Number(msg.timestamp) * 1000,
                  ).toISOString(),
                  token: internalToken,
                }),
              }).catch((e) => {
                console.error(
                  "[webhook] LSQ photo pipeline failed:",
                  e instanceof Error ? e.message : e,
                );
              });

              // First-photo-as-avatar — when the contact has no
              // operator-uploaded avatar yet, the first inbound image
              // becomes their profile picture automatically. Once
              // set, we never overwrite (operator can still replace
              // via the panel uploader).
              void supabase
                .from("contacts")
                .update({ avatar_url: mediaUrl })
                .eq("id", contact.id)
                .is("avatar_url", null);
            }

            // Auto-transcribe inbound voice notes / audio. The
            // transcribe route is responsible for kicking the AI
            // pipeline AFTER Whisper completes (we deliberately did
            // NOT fire automation/process for audio above) so the
            // bot's history reader sees the transcribed text on its
            // very first pass.
            if (isAudioMsg && insertedRow) {
              fetch(`${origin}/api/messages/${insertedRow.id}/transcribe`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${internalToken}`,
                },
              }).catch((e) => {
                console.error(
                  "[webhook] auto-transcribe failed:",
                  e instanceof Error ? e.message : e,
                );
              });
            }
          }
        }

        // Fan out to operator-registered outbound webhooks. Fire-and-
        // forget — failures here MUST NOT block message processing.
        if (businessPhoneNumberId) {
          dispatchOutboundWebhook({
            type: "message.inbound",
            business_phone_number_id: businessPhoneNumberId,
            occurred_at: new Date().toISOString(),
            data: {
              wa_id: waId,
              wa_message_id: msg.id,
              type: msg.type,
              profile_name: profileName ?? null,
              raw: msg,
            },
          }).catch((e) =>
            console.error(
              "[webhook] outbound fan-out (inbound) failed:",
              e instanceof Error ? e.message : e,
            ),
          );
        }
      }

      // Diagnostic: log a one-line summary of every webhook batch so we can
      // see in the dev terminal what Meta is actually sending us.
      const inCount = (value.messages ?? []).length;
      const stCount = (value.statuses ?? []).length;
      if (inCount > 0 || stCount > 0) {
        console.log(`[webhook] batch — inbound=${inCount} statuses=${stCount}`);
      }

      // ---- Status updates ----
      // Meta sends events in order (sent → delivered → read) but webhooks
      // are async — a stale 'delivered' could land after 'read'. We only
      // upgrade the rank, so blue ticks once earned never get downgraded.
      for (const status of value.statuses ?? []) {
        const errMsg = status.errors?.[0]?.message ?? null;
        const rank = STATUS_RANK[status.status] ?? 0;

        // Campaign delivery/read/failed FIRST — independent of the
        // messages table. Campaign sends only create campaign_recipients
        // (no messages row), so the lookup below would otherwise `continue`
        // and the campaign would show 0 delivered / 0 read / 0 replied
        // forever. Only upgrade (never downgrade a higher tick).
        {
          const recipientPatch: Record<string, unknown> = { status: status.status };
          if (status.status === "delivered") recipientPatch.delivered_at = new Date().toISOString();
          if (status.status === "read") recipientPatch.read_at = new Date().toISOString();
          if (status.status === "failed") recipientPatch.failed_reason = errMsg;
          // Don't let a late, out-of-order status downgrade the row.
          const lowerStatuses =
            status.status === "read"
              ? ["sent", "delivered"]
              : status.status === "delivered"
                ? ["sent"]
                : null;
          let rq = supabase
            .from("campaign_recipients")
            .update(recipientPatch)
            .eq("wa_message_id", status.id);
          if (lowerStatuses) rq = rq.in("status", lowerStatuses);
          const { data: updatedRecipients } = await rq.select("campaign_id");
          const touched = new Set(
            (updatedRecipients ?? []).map((r) => r.campaign_id as string),
          );
          if (touched.size > 0) {
            const { recomputeCounters } = await import("@/lib/campaigns");
            await Promise.all(Array.from(touched).map((id) => recomputeCounters(id)));
          }
        }

        const { data: existing } = await supabase
          .from("messages")
          .select("status, id")
          .eq("wa_message_id", status.id)
          .maybeSingle();

        if (!existing) {
          // Not in messages (e.g. a campaign-only send) — the recipient
          // row was already updated above, nothing more to mirror.
          continue;
        }

        const currentRank =
          existing.status ? STATUS_RANK[existing.status as keyof typeof STATUS_RANK] ?? 0 : 0;

        // 'failed' always wins (it's a terminal bad state), otherwise only
        // upgrade if the incoming rank is higher than what we have.
        if (status.status !== "failed" && rank <= currentRank) {
          console.log(
            `[webhook] status ${status.status} for ${status.id} — already at ${existing.status}, skipping`,
          );
          continue;
        }

        const { data: updatedRow, error: updateErr } = await supabase
          .from("messages")
          .update({
            status: status.status,
            error_message: status.status === "failed" ? errMsg : null,
          })
          .eq("wa_message_id", status.id)
          .select("id, contact_id, timestamp")
          .single();

        if (updateErr) {
          console.error(
            `[webhook] status update failed for ${status.id}:`,
            updateErr.message,
          );
        } else {
          console.log(
            `[webhook] ✓ status ${existing.status ?? "—"} → ${status.status} for ${status.id}`,
          );

          // If this status update is for the LATEST message of the contact,
          // mirror the new status onto the contact row so the contact list's
          // tick indicator updates from gray ✓ to emerald ✓✓ in real time.
          if (updatedRow) {
            const { data: contactRow } = await supabase
              .from("contacts")
              .select("id, last_message_at")
              .eq("id", updatedRow.contact_id)
              .maybeSingle();
            if (
              contactRow &&
              contactRow.last_message_at &&
              new Date(contactRow.last_message_at).getTime() ===
                new Date(updatedRow.timestamp).getTime()
            ) {
              await supabase
                .from("contacts")
                .update({ last_message_status: status.status })
                .eq("id", updatedRow.contact_id);
            }
          }

          if (businessPhoneNumberId) {
            dispatchOutboundWebhook({
              type: "message.status",
              business_phone_number_id: businessPhoneNumberId,
              occurred_at: new Date().toISOString(),
              data: {
                wa_message_id: status.id,
                status: status.status,
                error: errMsg,
                raw: status,
              },
            }).catch((e) =>
              console.error(
                "[webhook] outbound fan-out (status) failed:",
                e instanceof Error ? e.message : e,
              ),
            );
          }
        }
      }

      // ---- Calling events ----
      // Each entry is a single state transition for one call leg. We
      // upsert into whatsapp_calls keyed on wa_call_id so the same row
      // walks ringing → accepted/rejected → terminated as the events
      // land. Contact resolution best-effort: match on `from` (user's
      // wa_id for inbound) or `to` (for outbound) — if no contact
      // exists yet, the row is still saved so audit/history isn't lost.
      for (const call of value.calls ?? []) {
        const counterpartWaId =
          call.direction === "business_initiated" ? call.to : call.from;

        let contactId: string | null = null;
        let lsqOwnerEmail: string | null = null;
        if (counterpartWaId) {
          // Scope to the number that received the call. The SAME patient
          // can have one contact row per business number, so matching on
          // wa_id alone is ambiguous — .maybeSingle() throws on multiple
          // rows, which left contact_id null and the ringing banner stuck
          // on "Calling…" for any patient reachable on >1 number.
          const { data: c } = await supabase
            .from("contacts")
            .select("id, lsq_owner_email")
            .eq("wa_id", counterpartWaId)
            .eq("business_phone_number_id", businessPhoneNumberId)
            .maybeSingle();
          if (c) {
            contactId = c.id;
            lsqOwnerEmail =
              ((c as { lsq_owner_email?: string | null }).lsq_owner_email ??
                null) || null;
          } else if (call.direction !== "business_initiated") {
            // Inbound caller with no contact on THIS number yet — create
            // one, borrowing name/avatar/LSQ owner from a sibling row on
            // another number when the patient is already known there, so
            // the banner shows who's calling instead of a bare "Calling…".
            const { data: sibling } = await supabase
              .from("contacts")
              .select("name, profile_name, avatar_url, lsq_owner_email")
              .eq("wa_id", counterpartWaId)
              .order("last_message_at", { ascending: false, nullsFirst: false })
              .limit(1)
              .maybeSingle();
            const payload: Record<string, unknown> = {
              wa_id: counterpartWaId,
              business_phone_number_id: businessPhoneNumberId,
              status: "open",
            };
            if (sibling?.name) payload.name = sibling.name;
            if (sibling?.profile_name) payload.profile_name = sibling.profile_name;
            if (sibling?.avatar_url) payload.avatar_url = sibling.avatar_url;
            const { data: created } = await supabase
              .from("contacts")
              .upsert(payload, {
                onConflict: "wa_id,business_phone_number_id",
                ignoreDuplicates: false,
              })
              .select("id, lsq_owner_email")
              .single();
            contactId = created?.id ?? null;
            lsqOwnerEmail =
              (created?.lsq_owner_email ?? sibling?.lsq_owner_email ?? null) ||
              null;
          }
        }

        const ts = call.timestamp
          ? new Date(Number(call.timestamp) * 1000).toISOString()
          : new Date().toISOString();

        // Map Meta event → our status enum. `connect` is the dialing
        // / ringing state; `accept` answers; `reject` and `terminate`
        // are terminal. A bare `terminate` without prior `accept` is
        // a missed call, but we don't downgrade an `accepted` row.
        const isOffer = call.session?.sdp_type === "offer";
        const isAnswer = call.session?.sdp_type === "answer";
        const direction =
          call.direction === "business_initiated" ? "outbound" : "inbound";

        // Read existing row so we can preserve accept state across
        // a stray `terminate` webhook, AND compute talk-time off
        // accepted_at (not start_at — that includes ring time).
        // Also pulls contact_id/direction so we don't clobber the
        // values that /dial set when the operator initiated the
        // call (Meta's connect event for outbound legs sometimes
        // omits the direction field, which would flip the row to
        // "inbound" and orphan it from the contact).
        const { data: existing } = await supabase
          .from("whatsapp_calls")
          .select(
            "id, status, start_at, accepted_at, contact_id, direction, lsq_owner_email",
          )
          .eq("wa_call_id", call.id)
          .maybeSingle();

        let nextStatus: string;
        if (call.event === "connect") nextStatus = "ringing";
        else if (call.event === "accept") nextStatus = "accepted";
        else if (call.event === "reject") nextStatus = "rejected";
        else if (call.event === "terminate") {
          // The row is "accepted" if EITHER Meta sent us an accept
          // event OR our client (CallOverlay) stamped accepted_at when
          // pc.connectionState became "connected". Either way,
          // terminate after accept = completed call, not missed.
          // We deliberately DON'T treat a stray answer SDP as accept
          // — Meta sometimes ships answer SDP on the `connect` frame
          // before the patient actually picks up, which would start
          // the duration timer too early.
          const wasAccepted =
            existing?.status === "accepted" || !!existing?.accepted_at;
          nextStatus = wasAccepted ? "terminated" : "missed";
        } else nextStatus = existing?.status ?? "ringing";

        const update: Record<string, unknown> = {
          wa_call_id: call.id,
          // Prefer values already on the row (set by /dial for
          // outbound legs, or by an earlier webhook frame). Only
          // fall back to the freshly-derived ones when nothing's
          // there — otherwise an outbound call's contact_id gets
          // wiped and the history shows "Unknown caller".
          contact_id: existing?.contact_id ?? contactId,
          business_phone_number_id: businessPhoneNumberId,
          direction: (existing?.direction as "inbound" | "outbound" | undefined) ?? direction,
          status: nextStatus,
          // Snapshot the LSQ lead-owner email at ring time so the
          // active-call endpoint can route the banner to that
          // specific operator. Preserve any value already on the
          // row (a follow-up webhook frame won't clobber the
          // original snapshot if the contact got reassigned later).
          lsq_owner_email:
            (existing?.lsq_owner_email ?? lsqOwnerEmail)?.trim().toLowerCase() ?? null,
          raw_payload: call as unknown as object,
          updated_at: new Date().toISOString(),
        };
        if (isOffer && call.session?.sdp) update.sdp_offer = call.session.sdp;
        if (isAnswer && call.session?.sdp) update.sdp_answer = call.session.sdp;
        if (call.event === "connect" && !existing) update.start_at = ts;
        if (call.event === "accept" && !existing?.accepted_at) {
          update.accepted_at = ts;
          if (existing?.start_at) {
            update.ring_seconds = Math.max(
              0,
              Math.round(
                (new Date(ts).getTime() -
                  new Date(existing.start_at).getTime()) /
                  1000,
              ),
            );
          }
        }
        if (call.event === "terminate" || call.event === "reject") {
          update.end_at = ts;
          // Talk time = accepted_at → end_at when the call connected,
          // otherwise 0 (ring-only, never picked up).
          const anchor = existing?.accepted_at ?? null;
          update.duration_seconds = anchor
            ? Math.max(
                0,
                Math.round(
                  (new Date(ts).getTime() - new Date(anchor).getTime()) /
                    1000,
                ),
              )
            : 0;
        }

        const { error: callErr } = await supabase
          .from("whatsapp_calls")
          .upsert(update, { onConflict: "wa_call_id" });
        if (callErr) {
          console.error(
            `[webhook] whatsapp_calls upsert failed for ${call.id}:`,
            callErr.message,
          );
        } else {
          console.log(
            `[webhook] ✓ call ${call.id} ${call.event} → ${nextStatus}`,
          );
        }

        // LSQ activity log for ring-only outcomes — missed calls and
        // patient declines never produce a recording, so the upload
        // route's logger doesn't fire. Log them here so the lead
        // timeline still reflects the attempt. Completed (terminated
        // after accepted) calls are logged from the recording route
        // with talk-time + playback URL.
        const finalContactId = (existing?.contact_id ?? contactId) as string | null;
        if (
          finalContactId &&
          (nextStatus === "missed" || nextStatus === "rejected")
        ) {
          const label =
            nextStatus === "missed"
              ? "[WhatsApp Call · Missed]"
              : "[WhatsApp Call · Declined]";
          void import("@/lib/lsq-message-logger").then(({ logWhatsappActivityToLSQ }) =>
            logWhatsappActivityToLSQ({
              contactId: finalContactId,
              direction: direction === "outbound" ? "Outbound" : "Inbound",
              text: label,
              businessPhoneNumberId,
              timestamp: ts,
            }),
          ).catch(() => {});
        }

        if (businessPhoneNumberId) {
          dispatchOutboundWebhook({
            type: "call.event",
            business_phone_number_id: businessPhoneNumberId,
            occurred_at: ts,
            data: {
              wa_call_id: call.id,
              event: call.event,
              direction,
              status: nextStatus,
              from: call.from ?? null,
              to: call.to ?? null,
              raw: call,
            },
          }).catch((e) =>
            console.error(
              "[webhook] outbound fan-out (call) failed:",
              e instanceof Error ? e.message : e,
            ),
          );
        }
      }
    }
  }
}

// Insert the business_number row the first time we see a phone_number_id,
// pulling verified_name from Meta. No-op for repeat sightings.
async function ensureBusinessNumber(
  supabase: ReturnType<typeof createServiceRoleClient>,
  phoneNumberId: string,
  displayPhoneNumber: string | null,
) {
  const { data: existing } = await supabase
    .from("business_numbers")
    .select("phone_number_id, verified_name")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();

  if (existing && existing.verified_name) return;

  let verifiedName: string | null = existing?.verified_name ?? null;
  if (!verifiedName) {
    const details = await fetchPhoneNumberDetails(phoneNumberId);
    verifiedName = details?.verified_name ?? null;
  }

  await supabase.from("business_numbers").upsert(
    {
      phone_number_id: phoneNumberId,
      display_phone_number: displayPhoneNumber,
      verified_name: verifiedName,
    },
    { onConflict: "phone_number_id" },
  );
}

// Returns the human-readable label for a button/interactive reply, in the
// same order Meta is likely to populate fields. Falls back to null when the
// payload doesn't match any known shape.
function buttonLabel(msg: WAMessage): string | null {
  if (msg.type === "button") {
    return msg.button?.text?.trim() || msg.button?.payload?.trim() || null;
  }
  if (msg.type === "interactive") {
    const inter = msg.interactive;
    if (!inter) return null;
    if (inter.type === "button_reply") return inter.button_reply?.title?.trim() || null;
    if (inter.type === "list_reply") return inter.list_reply?.title?.trim() || null;
    if (inter.type === "call_permission_reply") {
      return inter.call_permission_reply?.response === "accept"
        ? "Call permission granted"
        : "Call permission denied";
    }
  }
  return null;
}

// True when this interactive payload is the patient's accept/reject for a
// Call Permission Request. We store these as their own message `type` so
// the dashboard can render a dedicated bubble + we can update the
// permissions table.
function isCallPermissionReply(msg: WAMessage): boolean {
  return msg.type === "interactive" && msg.interactive?.type === "call_permission_reply";
}

function callPermissionResponse(msg: WAMessage): "accept" | "reject" | null {
  const r = msg.interactive?.call_permission_reply?.response;
  return r === "accept" || r === "reject" ? r : null;
}

function previewOf(msg: WAMessage): string {
  // Prefer mime-based dispatch when the type/mime disagree — Meta
  // occasionally classifies a video as "image" (and vice versa) at
  // ingest time, leaving the chat-list with "📷 Photo" next to a
  // video bubble. The bytes don't lie, so let mime decide.
  const mime = extractMime(msg) ?? "";
  if (mime.startsWith("video/")) {
    return msg.video?.caption ? `🎥 ${msg.video.caption}` : "🎥 Video";
  }
  if (mime.startsWith("audio/")) {
    return "🎙️ Voice message";
  }
  if (mime.startsWith("image/")) {
    return msg.image?.caption ? `📷 ${msg.image.caption}` : "📷 Photo";
  }
  switch (msg.type) {
    case "text":
      return msg.text?.body?.slice(0, 120) ?? "";
    case "image":
      return msg.image?.caption ? `📷 ${msg.image.caption}` : "📷 Photo";
    case "video":
      return msg.video?.caption ? `🎥 ${msg.video.caption}` : "🎥 Video";
    case "audio":
      return "🎙️ Voice message";
    case "document":
      return msg.document?.filename ? `📄 ${msg.document.filename}` : "📄 Document";
    case "sticker":
      return "🟪 Sticker";
    case "location":
      return msg.location?.name ? `📍 ${msg.location.name}` : "📍 Location";
    case "reaction":
      return msg.reaction?.emoji ? `${msg.reaction.emoji} Reaction` : "Reaction removed";
    case "button":
    case "interactive": {
      if (isCallPermissionReply(msg)) {
        return callPermissionResponse(msg) === "accept"
          ? "📞 Call permission granted"
          : "📞 Call permission denied";
      }
      const label = buttonLabel(msg);
      return label ? `↩ ${label}` : "↩ Button reply";
    }
    default:
      return `[${msg.type}]`;
  }
}

function extractContent(msg: WAMessage): string | null {
  if (msg.type === "text") return msg.text?.body ?? null;
  if (msg.type === "image") return msg.image?.caption ?? null;
  if (msg.type === "video") return msg.video?.caption ?? null;
  if (msg.type === "document") return msg.document?.caption ?? msg.document?.filename ?? null;
  // Stickers have no caption — empty string keeps the row but nothing
  // for AI / activity-log to react to. The MessageBubble renders the
  // image from media_url instead of any text body.
  if (msg.type === "sticker") return null;
  // Customer tapped a button — store the visible label as the message
  // content so the dashboard bubble shows "Reply Now" (etc.) instead of
  // the literal "[button]" placeholder.
  if (msg.type === "button" || msg.type === "interactive") return buttonLabel(msg);
  // Location — store "📍 <label> (lat,lng)" so the bubble can parse the
  // coords into a clickable Google Maps link. Same format the Evolution +
  // Interakt webhooks use, so one renderer covers every portfolio.
  if (msg.type === "location" && msg.location) return locationContent(msg.location);
  // Reaction emoji — stored as the bubble content so MessageBubble can show
  // the actual emoji instead of a "[reaction]" placeholder. Empty = removed.
  if (msg.type === "reaction") return msg.reaction?.emoji || null;
  return null;
}

/** "📍 <name — address> (lat,lng)" — coords are what the map link needs; the
 *  label is shown above them. Used by all three provider webhooks. */
function locationContent(loc: {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
}): string {
  const label = [loc.name, loc.address]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" — ");
  if (loc.latitude == null || loc.longitude == null) {
    return label ? `📍 ${label}` : "📍 Location";
  }
  return label
    ? `📍 ${label} (${loc.latitude},${loc.longitude})`
    : `📍 (${loc.latitude},${loc.longitude})`;
}

function extractMime(msg: WAMessage): string | null {
  return (
    msg.image?.mime_type ??
    msg.video?.mime_type ??
    msg.audio?.mime_type ??
    msg.document?.mime_type ??
    msg.sticker?.mime_type ??
    null
  );
}
