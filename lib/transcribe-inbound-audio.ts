// In-process Whisper for inbound WhatsApp voice notes.
// Called from the Meta webhook (no HTTP hop to localhost — that was
// silently failing so media_url saved but transcript/kick never ran).

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential, requireCredential } from "@/lib/credentials";

export type TranscribeResult =
  | { ok: true; transcript: string; cached: boolean }
  | { ok: false; error: string; status?: number };

/**
 * Download (or recover) audio for a message, run Whisper, write
 * transcript+content, then kick trigger/AI with the spoken text.
 */
export async function transcribeInboundAudioMessage(
  messageId: string,
  opts?: { kickIfCached?: boolean },
): Promise<TranscribeResult> {
  const admin = createServiceRoleClient();
  const { data: msg } = await admin
    .from("messages")
    .select("id, type, media_url, media_mime_type, content, transcript")
    .eq("id", messageId)
    .maybeSingle();
  if (!msg) return { ok: false, error: "Message not found", status: 404 };

  if (msg.transcript) {
    if (opts?.kickIfCached) {
      await kickWithTranscript(
        admin,
        messageId,
        String(msg.transcript),
        msg.media_url as string | null,
      );
    }
    return { ok: true, transcript: String(msg.transcript), cached: true };
  }

  let mediaUrl = (msg.media_url as string | null) ?? null;
  let mime =
    String(msg.media_mime_type ?? "audio/ogg").split(";")[0].trim() ||
    "audio/ogg";

  if (!mediaUrl) {
    const recovered = await recoverMediaUrl(admin, messageId, mime);
    if (recovered) {
      mediaUrl = recovered.url;
      mime = recovered.mime;
    }
  }
  if (!mediaUrl) {
    return { ok: false, error: "Message has no media_url to transcribe", status: 400 };
  }

  let buffer: Buffer;
  try {
    const dl = await fetch(mediaUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!dl.ok) {
      return {
        ok: false,
        error: `Audio fetch failed (HTTP ${dl.status})`,
        status: 502,
      };
    }
    const ct = dl.headers.get("content-type");
    if (ct) mime = ct.split(";")[0].trim() || mime;
    buffer = Buffer.from(await dl.arrayBuffer());
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Audio fetch error",
      status: 502,
    };
  }

  let apiKey: string;
  try {
    apiKey = await requireCredential("openai_api_key", "OpenAI API key");
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "OpenAI key missing",
      status: 500,
    };
  }

  const ext = (mime.split("/")[1] ?? "ogg").split(";")[0].trim() || "ogg";
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime }),
    `${messageId}.${ext}`,
  );
  form.append("model", "whisper-1");

  let transcript = "";
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `Whisper HTTP ${res.status}: ${raw.slice(0, 300)}`,
        status: 502,
      };
    }
    try {
      transcript = String((JSON.parse(raw) as { text?: string }).text ?? "").trim();
    } catch {
      transcript = raw.trim();
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Whisper call failed",
      status: 502,
    };
  }

  const prevContent = String(msg.content ?? "").trim();
  const merged = prevContent
    ? `${prevContent}\n\n[voice note] ${transcript}`
    : `[voice note] ${transcript}`;

  await admin
    .from("messages")
    .update({ transcript: transcript || null, content: merged || null })
    .eq("id", messageId);

  if (transcript) {
    await kickWithTranscript(admin, messageId, transcript, mediaUrl);
  }

  return { ok: true, transcript, cached: false };
}

async function recoverMediaUrl(
  admin: ReturnType<typeof createServiceRoleClient>,
  messageId: string,
  fallbackMime: string,
): Promise<{ url: string; mime: string } | null> {
  const { data: full } = await admin
    .from("messages")
    .select("raw_payload, business_phone_number_id")
    .eq("id", messageId)
    .maybeSingle();
  const raw = (full?.raw_payload ?? {}) as {
    audio?: { id?: string; url?: string; mime_type?: string };
  };
  const mediaId = String(raw.audio?.id ?? "").trim();
  const payloadUrl = String(raw.audio?.url ?? "").trim();
  const bpid = String(full?.business_phone_number_id ?? "").trim();
  if (!mediaId || !bpid) return null;

  try {
    const { resolveCredsForPhoneNumberId } = await import("@/lib/portfolios");
    const { getApiVersion } = await import("@/lib/whatsapp");
    const { normalizeMime, uploadMediaBytes } = await import("@/lib/storage");
    const creds = await resolveCredsForPhoneNumberId(bpid);
    const token = creds?.access_token;
    if (!token) return null;
    const apiVersion = await getApiVersion();

    let downloadUrl = payloadUrl;
    let mime = normalizeMime(raw.audio?.mime_type ?? fallbackMime) || "audio/ogg";
    if (!downloadUrl) {
      const metaRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/${mediaId}?fields=url,mime_type`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      );
      if (metaRes.ok) {
        const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
        downloadUrl = String(meta.url ?? "").trim();
        if (meta.mime_type) mime = normalizeMime(meta.mime_type) || mime;
      }
    }
    if (!downloadUrl) return null;

    const dlRes = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!dlRes.ok) return null;
    const bytes = await dlRes.arrayBuffer();
    const { publicUrl } = await uploadMediaBytes(bytes, {
      mime,
      folder: "inbound",
      suggestedName: mediaId,
    });
    await admin
      .from("messages")
      .update({ media_url: publicUrl, media_mime_type: mime })
      .eq("id", messageId);
    return { url: publicUrl, mime };
  } catch (e) {
    console.warn(
      "[transcribe] media recover failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function kickWithTranscript(
  admin: ReturnType<typeof createServiceRoleClient>,
  messageId: string,
  transcript: string,
  mediaUrl: string | null,
): Promise<void> {
  const { data: refreshed } = await admin
    .from("messages")
    .select("contact_id, media_url")
    .eq("id", messageId)
    .maybeSingle();
  const contactId = refreshed?.contact_id as string | undefined;
  if (!contactId) return;

  const { data: contact } = await admin
    .from("contacts")
    .select("wa_id, business_phone_number_id")
    .eq("id", contactId)
    .maybeSingle();
  const waId = String(contact?.wa_id ?? "").trim();
  const bpid = String(contact?.business_phone_number_id ?? "").trim();

  if (waId && bpid) {
    const { kickInboundAutomation } = await import("@/lib/kick-inbound-automation");
    await kickInboundAutomation({
      contactId,
      waId,
      bpid,
      inboundText: transcript,
      inboundType: "audio",
      inboundMediaUrl: (refreshed?.media_url as string | null) ?? mediaUrl,
    });
    return;
  }

  const internalToken = await getCredential("webhook_internal_token");
  if (!internalToken) return;
  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3001";
  await fetch(`${origin}/api/automation/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contact_id: contactId,
      trigger_message_id: messageId,
      token: internalToken,
    }),
  }).catch((e) => {
    console.error(
      "[transcribe] automation trigger failed:",
      e instanceof Error ? e.message : e,
    );
  });
}
