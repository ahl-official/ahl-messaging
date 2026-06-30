// POST /api/whatsapp-call/[id]/transcribe
//
// Pulls the call's recording_url, runs OpenAI Whisper, writes the
// transcript back onto whatsapp_calls.transcript. Identical pattern
// to /api/messages/[id]/transcribe — separate route because calls
// don't share the messages.id namespace.
//
// `id` is the wa_call_id (Meta identifier).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { requireCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: waCallId } = await params;
  const admin = createServiceRoleClient();

  const { data: row } = await admin
    .from("whatsapp_calls")
    .select("recording_url, recording_mime, transcript, business_phone_number_id")
    .eq("wa_call_id", waCallId)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }
  if (row.transcript) {
    return NextResponse.json({ ok: true, transcript: row.transcript, cached: true });
  }
  if (!row.recording_url) {
    return NextResponse.json(
      { error: "No recording available for this call yet" },
      { status: 400 },
    );
  }

  // Pull this number's transcription_prompt + capability flag.
  // Capability gate: operator can disable transcription on a per-number
  // basis (default on). Returns 403 with a clear reason so the UI can
  // hide / disable the Transcribe button.
  let promptHint = "";
  if (row.business_phone_number_id) {
    const { data: cfg } = await admin
      .from("automation_configs")
      .select("transcription_prompt, call_transcribe_enabled")
      .eq("business_phone_number_id", row.business_phone_number_id)
      .maybeSingle();
    if (cfg && cfg.call_transcribe_enabled === false) {
      await admin
        .from("whatsapp_calls")
        .update({ transcript_status: "failed" })
        .eq("wa_call_id", waCallId);
      return NextResponse.json(
        { error: "Transcription is disabled for this number." },
        { status: 403 },
      );
    }
    promptHint = (cfg?.transcription_prompt as string | null)?.trim() || "";
  }

  await admin
    .from("whatsapp_calls")
    .update({ transcript_status: "pending" })
    .eq("wa_call_id", waCallId);

  let buffer: Buffer;
  let mime = (row.recording_mime as string) || "audio/webm";
  try {
    const dl = await fetch(row.recording_url, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!dl.ok) throw new Error(`Audio fetch HTTP ${dl.status}`);
    if (dl.headers.get("content-type")) mime = dl.headers.get("content-type")!;
    buffer = Buffer.from(await dl.arrayBuffer());
  } catch (e) {
    await admin
      .from("whatsapp_calls")
      .update({ transcript_status: "failed" })
      .eq("wa_call_id", waCallId);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Audio fetch failed" },
      { status: 502 },
    );
  }

  let apiKey: string;
  try {
    apiKey = await requireCredential("openai_api_key", "OpenAI API key");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "OpenAI key missing" },
      { status: 500 },
    );
  }

  const ext =
    (mime.split("/")[1] ?? "webm").split(";")[0].trim() || "webm";
  const filename = `call-${waCallId}.${ext}`;
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime }),
    filename,
  );
  form.append("model", "whisper-1");
  // Whisper's `prompt` field accepts up to 224 tokens (~1000 chars) of
  // context. Trim defensively — anything longer is silently truncated
  // by OpenAI but better to send a clean payload.
  if (promptHint) {
    form.append("prompt", promptHint.slice(0, 1000));
  }

  let transcript = "";
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      await admin
        .from("whatsapp_calls")
        .update({ transcript_status: "failed" })
        .eq("wa_call_id", waCallId);
      return NextResponse.json(
        { error: `Whisper HTTP ${res.status}: ${raw.slice(0, 300)}` },
        { status: 502 },
      );
    }
    try {
      const parsed = JSON.parse(raw) as { text?: string };
      transcript = (parsed.text ?? "").trim();
    } catch {
      transcript = raw.trim();
    }
  } catch (e) {
    await admin
      .from("whatsapp_calls")
      .update({ transcript_status: "failed" })
      .eq("wa_call_id", waCallId);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Whisper call failed" },
      { status: 502 },
    );
  }

  await admin
    .from("whatsapp_calls")
    .update({
      transcript: transcript || null,
      transcript_status: transcript ? "done" : "failed",
    })
    .eq("wa_call_id", waCallId);

  return NextResponse.json({ ok: true, transcript, cached: false });
}
