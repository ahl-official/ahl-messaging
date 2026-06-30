// POST /api/assistant/transcribe
//
// Voice input for the home AI assistant. Receives a recorded audio
// blob (browser MediaRecorder — webm/opus on Chrome, mp4/aac on
// Safari) and forwards it to ElevenLabs Scribe (`scribe_v1`).
//
// We use ElevenLabs Scribe instead of OpenAI Whisper because the
// operator pool is Hindi/Hinglish-speaking and the same ElevenLabs
// account already powers the TTS output — one provider, one key, one
// billing line. Scribe handles code-mixed audio out of the box.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { requireCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB — generous; assistant clips stay under a few MB

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form-data" }, { status: 400 });
  }
  const file = form.get("audio");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing 'audio' file" }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: `Audio too large (${file.size} bytes, max ${MAX_AUDIO_BYTES})` },
      { status: 413 },
    );
  }

  const apiKey = await requireCredential(
    "elevenlabs_api_key",
    "ElevenLabs API key",
  );

  // ElevenLabs Scribe expects multipart/form-data with `file` + the
  // model id. Auto-detect language so a mixed Hindi/English utterance
  // doesn't get forced into one or the other.
  const upstream = new FormData();
  const filename =
    (file as File).name && (file as File).name.includes(".")
      ? (file as File).name
      : "audio.webm";
  upstream.append("file", file, filename);
  upstream.append("model_id", "scribe_v1");

  let resp: Response;
  try {
    resp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: upstream,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Network error" },
      { status: 502 },
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return NextResponse.json(
      { error: `ElevenLabs Scribe HTTP ${resp.status}: ${text.slice(0, 200)}` },
      { status: 502 },
    );
  }
  // Scribe returns { text, language_code, language_probability, words }.
  // We only need the text — caller renders + auto-sends it.
  const json = (await resp.json()) as { text?: string };
  const text = (json.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "Empty transcription" }, { status: 502 });
  }
  return NextResponse.json({ text });
}
