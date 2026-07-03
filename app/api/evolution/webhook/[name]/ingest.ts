// Shared Evolution ingest helpers.
//
// These live OUTSIDE route.ts on purpose: a Next.js App Router `route.ts`
// may only export HTTP method handlers (+ config). Exporting helpers from
// it fails the production type-check (`next build`). The webhook route, the
// manual sync-history endpoint and group-history all import the SAME ingest
// path from here so real-time and backfill never drift.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { jidToWaId } from "@/lib/evolution";
import { persistEvolutionMedia } from "@/lib/evolution-media";
import { broadcastInbox } from "@/lib/realtime-inbox";
import { isEphemeralWhatsAppMedia } from "@/lib/media-url";

type Admin = ReturnType<typeof createServiceRoleClient>;

export interface EvoMessageData {
  key?: {
    remoteJid?: string;
    fromMe?: boolean;
    id?: string;
    participant?: string;
  };
  pushName?: string;
  message?: Record<string, unknown>;
  messageType?: string;
  messageTimestamp?: number | string;
  status?: string; // PENDING / SERVER_ACK / DELIVERY_ACK / READ / PLAYED
}

interface DecodedMessage {
  type: string;
  content: string;
  mediaUrl: string | null;
  mediaMime: string | null;
}

// Exported so the manual sync-history endpoint can re-use the EXACT
// same ingest path the webhook uses — no risk of behavior drift between
// real-time and backfill code paths.
export async function handleMessageUpsert(
  admin: Admin,
  bpid: string,
  data: Record<string, unknown> | undefined,
  /** Evolution creds — when present, inbound media is downloaded and
   *  persisted to Storage so it doesn't expire off WhatsApp's CDN. */
  evo?: { instanceName: string; apiKey: string } | null,
): Promise<void> {
  if (!data) return;
  // Evolution sometimes wraps the message inside a `messages: [...]`
  // array, sometimes posts a single message object directly.
  const list: EvoMessageData[] = Array.isArray(data.messages)
    ? (data.messages as EvoMessageData[])
    : [data as EvoMessageData];

  for (const m of list) {
    const remoteJid = m.key?.remoteJid;
    const id = m.key?.id;
    const fromMe = m.key?.fromMe ?? false;
    if (!remoteJid || !id) continue;

    // Only ingest genuine 1:1 customer chats. Allowlist the individual
    // JID domains and skip everything else — groups (@g.us), WhatsApp
    // privacy/linked IDs (@lid), broadcast/status (@broadcast) and
    // channels (@newsletter). @lid-routed junk would otherwise leak in
    // as garbage 15-digit "numbers".
    const isGroup = remoteJid.endsWith("@g.us");
    const isDirect =
      remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@c.us");
    if (!isGroup && !isDirect) continue;

    const waId = jidToWaId(remoteJid);
    const direction = fromMe ? "outbound" : "inbound";
    const tsNum =
      typeof m.messageTimestamp === "string"
        ? parseInt(m.messageTimestamp, 10)
        : (m.messageTimestamp ?? Math.floor(Date.now() / 1000));
    const tsIso = new Date(tsNum * 1000).toISOString();

    const { type, content, mediaUrl, mediaMime } = decodeMessage(m);

    // Upsert contact first so the FK on messages always resolves.
    //
    // pushName rules:
    //  - INBOUND  → pushName is the CUSTOMER's WhatsApp name → store it
    //               in profile_name.
    //  - OUTBOUND → pushName is the BUSINESS account itself (often the
    //               locale self-label like "Você") → never touch the
    //               contact name with it.
    //  - GROUP    → pushName is the participant, not the group → skip;
    //               the group subject arrives via chats.update.
    // `name` is operator-owned (the contact panel editor) — the webhook
    // never writes it, so manual names are never clobbered.
    const baseContact = {
      wa_id: waId,
      business_phone_number_id: bpid,
      status: "open" as const,
    };
    const contactPayload = isGroup
      ? { ...baseContact, is_group: true }
      : direction === "inbound" && m.pushName
        ? { ...baseContact, profile_name: m.pushName }
        : baseContact;
    const { data: contact, error: cErr } = await admin
      .from("contacts")
      .upsert(contactPayload, {
        onConflict: "wa_id,business_phone_number_id",
        ignoreDuplicates: false,
      })
      .select("id")
      .single();
    if (cErr || !contact) {
      console.error("[evolution-webhook] contact upsert failed:", cErr?.message);
      continue;
    }

    // Idempotency: skip if we already have a row for this wa_message_id.
    const { data: existing } = await admin
      .from("messages")
      .select("id")
      .eq("wa_message_id", id)
      .maybeSingle();
    if (existing) continue;

    const status = mapEvolutionStatus(m.status, direction);

    // Persist media to Supabase Storage so it survives WhatsApp's
    // ~3-week CDN expiry. The url Baileys gives us is encrypted +
    // expiring; without this, old photos 404 forever. Falls back to
    // the raw url if the download/upload fails for any reason.
    let storedMediaUrl = mediaUrl;
    if (evo && mediaUrl && isEphemeralWhatsAppMedia(mediaUrl)) {
      const persisted = await persistEvolutionMedia({
        instanceName: evo.instanceName,
        apiKey: evo.apiKey,
        wamid: id,
        mime: mediaMime ?? "application/octet-stream",
        direction,
      });
      if (persisted) storedMediaUrl = persisted;
    }

    // Use upsert + ignoreDuplicates so the duplicate-key race
    // (two webhook deliveries for the same wa_message_id arriving
    // before either has committed) silently no-ops instead of
    // logging an error. The pre-check above already handles the
    // common case; this catches the tiny race window.
    const { error: mErr } = await admin
      .from("messages")
      .upsert(
        {
          contact_id: contact.id,
          wa_message_id: id,
          direction,
          type,
          content,
          media_url: storedMediaUrl,
          media_mime_type: mediaMime,
          status,
          timestamp: tsIso,
          business_phone_number_id: bpid,
          sender_name:
            isGroup && direction === "inbound" ? (m.pushName ?? null) : null,
        },
        { onConflict: "wa_message_id", ignoreDuplicates: true },
      );
    if (mErr) {
      // Real failures (RLS, FK violation, etc.) still surface. Duplicate-
      // key would have been swallowed by ignoreDuplicates above, so any
      // mErr at this point is genuinely worth logging.
      console.error("[evolution-webhook] message insert failed:", mErr.message);
      continue;
    }

    // Mirror last_message_* on the contact for the inbox preview.
    await admin
      .from("contacts")
      .update({
        last_message_at: tsIso,
        last_message_preview: (content || `[${type}]`).slice(0, 120),
        last_message_direction: direction,
        last_message_status: status,
        // Opens/extends the 24h window — only on inbound (client) messages.
        ...(direction === "inbound" ? { last_inbound_at: tsIso } : {}),
      })
      .eq("id", contact.id);

    // Live-push the inbox (both directions — covers messages you send from
    // the linked phone too). See lib/realtime-inbox.
    void broadcastInbox({
      business_phone_number_id: bpid,
      contact_id: contact.id,
      direction: direction as "inbound" | "outbound",
    });
  }
}

/** Translate Evolution's `message` payload (Baileys shape) into the
 *  flat shape our `messages` table uses. We don't proactively download
 *  media here — that's Phase 3. We just stash whatever URL Evolution
 *  surfaces and the mime so the bubble at least shows the right tag. */
export function decodeMessage(m: EvoMessageData): DecodedMessage {
  const msg = m.message ?? {};

  if (typeof msg.conversation === "string") {
    return { type: "text", content: msg.conversation, mediaUrl: null, mediaMime: null };
  }
  if (
    msg.extendedTextMessage &&
    typeof (msg.extendedTextMessage as { text?: string }).text === "string"
  ) {
    return {
      type: "text",
      content: (msg.extendedTextMessage as { text: string }).text,
      mediaUrl: null,
      mediaMime: null,
    };
  }
  if (msg.imageMessage) {
    const im = msg.imageMessage as { caption?: string; mimetype?: string; url?: string };
    return {
      type: "image",
      content: im.caption ?? "",
      mediaUrl: im.url ?? null,
      mediaMime: im.mimetype ?? "image/jpeg",
    };
  }
  if (msg.videoMessage) {
    const vm = msg.videoMessage as { caption?: string; mimetype?: string; url?: string };
    return {
      type: "video",
      content: vm.caption ?? "",
      mediaUrl: vm.url ?? null,
      mediaMime: vm.mimetype ?? "video/mp4",
    };
  }
  if (msg.audioMessage) {
    const am = msg.audioMessage as { mimetype?: string; url?: string };
    return {
      type: "audio",
      content: "",
      mediaUrl: am.url ?? null,
      mediaMime: am.mimetype ?? "audio/ogg",
    };
  }
  if (msg.documentMessage) {
    const dm = msg.documentMessage as {
      fileName?: string;
      mimetype?: string;
      url?: string;
    };
    return {
      type: "document",
      content: dm.fileName ?? "",
      mediaUrl: dm.url ?? null,
      mediaMime: dm.mimetype ?? "application/octet-stream",
    };
  }
  if (msg.stickerMessage) {
    const sm = msg.stickerMessage as { mimetype?: string; url?: string };
    return {
      type: "sticker",
      content: "",
      mediaUrl: sm.url ?? null,
      mediaMime: sm.mimetype ?? "image/webp",
    };
  }
  if (msg.locationMessage) {
    const lm = msg.locationMessage as {
      degreesLatitude?: number;
      degreesLongitude?: number;
      name?: string;
      address?: string;
    };
    // type "location" + "📍 <label> (lat,lng)" — same format as the Meta +
    // Interakt webhooks so MessageBubble renders one clickable map link.
    const label = [lm.name, lm.address]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" — ");
    const hasCoords =
      lm.degreesLatitude != null && lm.degreesLongitude != null;
    const content = hasCoords
      ? label
        ? `📍 ${label} (${lm.degreesLatitude},${lm.degreesLongitude})`
        : `📍 (${lm.degreesLatitude},${lm.degreesLongitude})`
      : label
        ? `📍 ${label}`
        : "📍 Location";
    return { type: "location", content, mediaUrl: null, mediaMime: null };
  }
  if (msg.contactMessage) {
    const cm = msg.contactMessage as { displayName?: string; vcard?: string };
    return {
      type: "text",
      content: `👤 ${cm.displayName ?? "Contact"}\n${cm.vcard ?? ""}`,
      mediaUrl: null,
      mediaMime: null,
    };
  }
  if (msg.reactionMessage) {
    const rm = msg.reactionMessage as {
      text?: string;
      key?: { id?: string };
    };
    return {
      type: "text",
      content: `Reacted ${rm.text ?? ""} to ${rm.key?.id ?? ""}`,
      mediaUrl: null,
      mediaMime: null,
    };
  }

  // Fallback — store the message type at least so the bubble doesn't
  // silently swallow it.
  return {
    type: m.messageType ?? "unsupported",
    content: "",
    mediaUrl: null,
    mediaMime: null,
  };
}

export function mapEvolutionStatus(
  s: string | number | undefined,
  direction: "inbound" | "outbound",
): "sent" | "delivered" | "read" | "failed" | "received" {
  if (direction === "inbound") return "received";
  // Baileys uses a numeric MessageStatus enum (Proto WAMessageStatus):
  //   0 ERROR · 1 PENDING · 2 SERVER_ACK · 3 DELIVERY_ACK · 4 READ · 5 PLAYED
  // Different Evolution builds forward either the enum number, the
  // string name, or the lowercase variant. Normalise all three.
  if (typeof s === "number") {
    if (s === 4 || s === 5) return "read";
    if (s === 3) return "delivered";
    if (s === 2 || s === 1) return "sent";
    if (s === 0) return "failed";
    return "sent";
  }
  if (!s) return "sent";
  const key = String(s).toUpperCase();
  switch (key) {
    case "PENDING":
    case "SERVER_ACK":
    case "SENT":
      return "sent";
    case "DELIVERY_ACK":
    case "DELIVERED":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    case "ERROR":
    case "FAILED":
      return "failed";
    default:
      return "sent";
  }
}
