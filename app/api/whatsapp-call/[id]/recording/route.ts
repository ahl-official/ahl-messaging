// POST /api/whatsapp-call/[id]/recording
//
// Operator's browser uploads the mixed-audio recording (local +
// remote streams merged via Web Audio) once a call ends. Body is
// multipart/form-data with a single `file` field; we drop the bytes
// into the same `whatsapp-media` Storage bucket that messages use
// and patch the wa_call_id'd row with the public URL.
//
// `id` here is the wa_call_id (Meta's identifier), not the row UUID
// — keeps the client-side path stable even if the Postgres row is
// re-keyed.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { uploadMediaBytes } from "@/lib/storage";
import {
  getLsqConfig,
  lsqAttachToActivity,
  lsqCreateActivity,
  lsqUploadFile,
} from "@/lib/lsq";

export const runtime = "nodejs";
// Browser may upload several MB of webm/opus; bump body limit.
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: waCallId } = await params;
  if (!waCallId) {
    return NextResponse.json({ error: "wa_call_id required" }, { status: 400 });
  }

  const form = await request.formData();
  const file = form.get("file");
  const mime = (form.get("mime") as string | null) || "audio/webm";
  const durationMs = Number(form.get("duration_ms") ?? "0");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file missing" }, { status: 400 });
  }

  // Capability gate — operator can disable recording-storage per number.
  // We still let the call complete (the WebRTC stream is set up by Meta,
  // not us); we just refuse to persist the audio to storage.
  const adminGate = createServiceRoleClient();
  const { data: callForGate } = await adminGate
    .from("whatsapp_calls")
    .select("business_phone_number_id")
    .eq("wa_call_id", waCallId)
    .maybeSingle();
  if (callForGate?.business_phone_number_id) {
    const { data: cfg } = await adminGate
      .from("automation_configs")
      .select("call_recording_enabled")
      .eq("business_phone_number_id", callForGate.business_phone_number_id)
      .maybeSingle();
    if (cfg && cfg.call_recording_enabled === false) {
      return NextResponse.json({ ok: true, skipped: "call_recording_disabled" });
    }
  }

  let upload;
  let recordingBuffer: Buffer;
  try {
    recordingBuffer = Buffer.from(await file.arrayBuffer());
    upload = await uploadMediaBytes(recordingBuffer, {
      mime,
      folder: "inbound",
      suggestedName: `call-${waCallId}`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 },
    );
  }

  const admin = createServiceRoleClient();
  const patch: Record<string, unknown> = {
    recording_url: upload.publicUrl,
    recording_mime: mime,
    transcript_status: "none",
  };
  // Trust the recorder's wall-clock — it's the authoritative talk
  // time. The webhook's accepted_at→end_at math has 1-3s of jitter
  // because Meta and our /respond fire on slightly different events.
  if (durationMs > 0) {
    patch.duration_seconds = Math.round(durationMs / 1000);
  }
  const { data: callRow, error } = await admin
    .from("whatsapp_calls")
    .update(patch)
    .eq("wa_call_id", waCallId)
    .select("contact_id, business_phone_number_id, direction, duration_seconds")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Mirror the recording into the chat thread as a synthetic audio
  // message so the agent sees a playable bubble + transcript toggle
  // right where the conversation lives. We dedupe on wa_message_id
  // (`call-rec-${waCallId}`) so retries / repeat uploads don't pile
  // up duplicate bubbles.
  if (callRow?.contact_id) {
    const seconds = Math.max(0, Math.round(durationMs / 1000));
    const mm = String(Math.floor(seconds / 60)).padStart(1, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    const direction = callRow.direction === "inbound" ? "inbound" : "outbound";
    const preview = seconds > 0
      ? `📞 Call recording · ${mm}:${ss}`
      : "📞 Call recording";
    const nowIso = new Date().toISOString();
    await admin.from("messages").upsert(
      {
        contact_id: callRow.contact_id,
        wa_message_id: `call-rec-${waCallId}`,
        direction,
        type: "audio",
        content: preview,
        media_url: upload.publicUrl,
        media_mime_type: mime,
        status: direction === "outbound" ? "sent" : "delivered",
        timestamp: nowIso,
        business_phone_number_id: callRow.business_phone_number_id,
        sent_by_user_id: direction === "outbound" ? member.user_id : null,
        sent_by_email: direction === "outbound" ? member.email : null,
      },
      { onConflict: "wa_message_id" },
    );
    // Bump the contact's preview/last_message_at so the conversation
    // jumps to the top of the inbox just like a fresh message would.
    // The inbox sorts on last_message_at — without this the call
    // bubble shows in-thread but the contact stays buried under
    // unrelated newer chats.
    await admin
      .from("contacts")
      .update({
        last_message_at: nowIso,
        last_message_preview: preview,
        last_message_direction: direction,
        last_message_status: direction === "outbound" ? "sent" : "received",
      })
      .eq("id", callRow.contact_id);

    // Push the call onto LSQ as a real attachment, not just a URL in
    // the note. Sending the audio bytes through lsqUploadFile +
    // lsqAttachToActivity makes the recording appear in LSQ's
    // attachment slot — which renders an inline player on the lead
    // timeline, the same way the photo-received pipeline does.
    // Fire-and-forget so the operator's response isn't gated on LSQ.
    void pushCallRecordingToLSQ({
      contactId: callRow.contact_id,
      businessPhoneNumberId: callRow.business_phone_number_id,
      direction: direction === "inbound" ? "Inbound" : "Outbound",
      durationLabel: seconds > 0 ? `${mm}:${ss}` : null,
      timestamp: nowIso,
      buffer: recordingBuffer,
      mime,
      waCallId,
    }).catch((e) => {
      console.warn("[recording] LSQ push failed:", e instanceof Error ? e.message : e);
    });
  }

  return NextResponse.json({ ok: true, recording_url: upload.publicUrl });
}

// ---------- LSQ push: create activity + upload audio + attach ----------
//
// Mirrors the photo-received pipeline (create → upload → attach) so the
// recording shows up as a real LSQ attachment with an inline player,
// instead of a bare URL inside the activity note. Resolves the
// prospect, the configured note suffix, and the business-number
// fallback the same way logWhatsappActivityToLSQ does — kept inline
// here because we need the activity_id and the original buffer.
async function pushCallRecordingToLSQ(opts: {
  contactId: string;
  businessPhoneNumberId: string | null;
  direction: "Inbound" | "Outbound";
  durationLabel: string | null;
  timestamp: string;
  buffer: Buffer;
  mime: string;
  waCallId: string;
}): Promise<void> {
  const cfg = getLsqConfig();
  if (!cfg.configured) return;

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("lsq_prospect_id, business_phone_number_id")
    .eq("id", opts.contactId)
    .maybeSingle();
  if (!contact?.lsq_prospect_id) return;

  // Build the same suffix the chat logger uses so LSQ Smart Views
  // grouping by source number keeps working for calls too.
  const phoneNumberId =
    opts.businessPhoneNumberId ?? contact.business_phone_number_id ?? null;
  let configuredSuffix = "";
  let displayPhone = "";
  if (phoneNumberId) {
    const [{ data: cfgRow }, { data: bn }] = await Promise.all([
      admin
        .from("automation_configs")
        .select("activity_note_suffix")
        .eq("business_phone_number_id", phoneNumberId)
        .maybeSingle(),
      admin
        .from("business_numbers")
        .select("display_phone_number, phone_number_id")
        .eq("phone_number_id", phoneNumberId)
        .maybeSingle(),
    ]);
    configuredSuffix = (cfgRow?.activity_note_suffix ?? "").toString().trim();
    if (bn) {
      displayPhone =
        (bn.display_phone_number ?? "")
          .toString()
          .replace(/\D/g, "")
          .slice(-10) || bn.phone_number_id;
    }
  }
  const suffixContent =
    configuredSuffix || (displayPhone ? `WhatsApp ${displayPhone}` : "");
  const noteSuffix = suffixContent ? ` - (${suffixContent})` : "";
  const note = opts.durationLabel
    ? `[WhatsApp Call · ${opts.durationLabel}]${noteSuffix}`
    : `[WhatsApp Call]${noteSuffix}`;

  const ts = new Date(opts.timestamp).toISOString().slice(0, 19).replace("T", " ");

  // Step 1: create the activity so we have an id.
  const created = await lsqCreateActivity({
    prospectId: contact.lsq_prospect_id,
    note,
    fields: [
      { SchemaName: "mx_Custom_1", Value: ts },
      { SchemaName: "mx_Custom_2", Value: opts.direction },
    ],
  });
  if (!created.ok || !created.activity_id) {
    console.warn(`[recording→lsq] create_activity failed: ${created.error}`);
    return;
  }

  // Step 2: upload the audio bytes. LSQ's Files endpoint will return
  // a server-side path that the Attachment/Add call links to the
  // activity. mp4 / m4a renders inline; webm/opus is hit-or-miss in
  // LSQ's player so we hint the extension off the mime.
  const ext = opts.mime.includes("mp4") ? "m4a" : opts.mime.includes("ogg") ? "ogg" : "webm";
  const filename = `call-${opts.waCallId}.${ext}`;
  const uploaded = await lsqUploadFile(opts.buffer, filename, opts.mime);
  if (!uploaded.ok || !uploaded.path) {
    console.warn(`[recording→lsq] upload_file failed: ${uploaded.error}`);
    return;
  }

  // Step 3: link the upload to the freshly-created activity. FileType
  // "1" matches the photo pipeline; LSQ uses it generically for any
  // attached media.
  const attached = await lsqAttachToActivity(
    created.activity_id,
    uploaded.name ?? filename,
    uploaded.path,
  );
  if (!attached.ok) {
    console.warn(
      `[recording→lsq] attach failed (activity=${created.activity_id}): ${attached.error}`,
    );
    return;
  }
  console.log(
    `[recording→lsq] activity=${created.activity_id} attached call recording`,
  );
}
