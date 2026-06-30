// POST /api/assistant/tts
//
// Text-to-speech for the home AI assistant. Forwards the supplied text
// to ElevenLabs (multilingual model, configured voice id) and streams
// the resulting audio back to the browser as audio/mpeg.
//
// We pick ElevenLabs over OpenAI TTS / browser SpeechSynthesis because
// the operator pool speaks Hindi/Hinglish — ElevenLabs' multilingual
// v2 model handles code-mixed text far more naturally than either
// alternative, and the voice id stays configurable per workspace.

import { type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { requireCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TEXT_LEN = 4000; // safety cap — assistant replies stay well under this

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  let body: { text?: string };
  try {
    body = (await request.json()) as { text?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "Missing 'text'" }), {
      status: 400,
    });
  }
  if (text.length > MAX_TEXT_LEN) {
    return new Response(
      JSON.stringify({
        error: `Text too long (${text.length} chars, max ${MAX_TEXT_LEN}).`,
      }),
      { status: 413 },
    );
  }

  const apiKey = await requireCredential("elevenlabs_api_key", "ElevenLabs API key");
  const voiceId = await requireCredential(
    "elevenlabs_voice_id",
    "ElevenLabs voice id",
  );

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          // turbo_v2_5 ships with significantly more natural prosody
          // in Hindi than v2 (released after our initial wiring) and
          // also halves first-byte latency, which matters since this
          // streams straight into the operator's headphones.
          model_id: "eleven_turbo_v2_5",
          // Tuned for a calm professional delivery:
          //   - higher stability → less robotic, fewer pitch swings
          //   - higher similarity_boost → closer to the cloned voice
          //   - very low style → don't over-perform; we want assistant,
          //     not narrator
          //   - speaker_boost on for clearer phonemes on Hindi consonants
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.85,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Network error",
      }),
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: `ElevenLabs HTTP ${upstream.status}: ${errText.slice(0, 200)}`,
      }),
      { status: 502 },
    );
  }
  if (!upstream.body) {
    return new Response(JSON.stringify({ error: "Empty TTS response" }), {
      status: 502,
    });
  }

  // Pipe the audio body straight through to the client so playback can
  // start as soon as the first chunk arrives.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
