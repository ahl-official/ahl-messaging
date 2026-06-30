// GET  /api/messages/[id]/transcribe — read cached transcript (no LLM call)
// POST /api/messages/[id]/transcribe — run Whisper if not cached yet
//
// We call OpenAI's Whisper endpoint directly via multipart/form-data —
// the SDK isn't on this project and the wire format is small enough
// that a fetch call is clearer than pulling another dep.
//
// On success we write the transcript onto messages.transcript AND
// onto messages.content (the bot's history reader uses content), so
// the LLM sees the speech as text on its next pass without any
// special-case branching in the prompt builder.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getCredential, requireCredential } from "@/lib/credentials";

/** Allow either a logged-in team member OR the shared internal
 *  webhook token. The latter is what /api/webhook hands to us when
 *  it auto-transcribes an inbound audio (no session cookie there). */
async function authorize(request: NextRequest): Promise<boolean> {
  const headerToken = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const expected = (await getCredential("webhook_internal_token")) ?? "";
  if (expected && headerToken === expected) return true;
  // Some webhook callers omit the header — allow ?token=...
  const queryToken = new URL(request.url).searchParams.get("token")?.trim();
  if (expected && queryToken === expected) return true;
  return !!(await getCurrentMember());
}

export const runtime = "nodejs";

// messages.id is a uuid — a non-uuid (e.g. an optimistic "tmp-…" bubble)
// would make Postgres throw "invalid input syntax for type uuid".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MessageRow {
  id: string;
  type: string;
  media_url: string | null;
  media_mime_type: string | null;
  content: string | null;
  transcript: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorize(request)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: true, transcript: null, cached: false });
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("messages")
    .select("id, transcript")
    .eq("id", id)
    .maybeSingle();
  return NextResponse.json({
    ok: true,
    transcript: (data?.transcript ?? null) as string | null,
    cached: !!data?.transcript,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorize(request)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Message not found" }, { status: 404 });
  const admin = createServiceRoleClient();
  const { data: msg } = await admin
    .from("messages")
    .select("id, type, media_url, media_mime_type, content, transcript")
    .eq("id", id)
    .maybeSingle();
  if (!msg) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const m = msg as MessageRow;
  if (m.transcript) {
    // Already transcribed — just echo. POST is idempotent.
    return NextResponse.json({ ok: true, transcript: m.transcript, cached: true });
  }
  if (!m.media_url) {
    return NextResponse.json(
      { error: "Message has no media_url to transcribe" },
      { status: 400 },
    );
  }

  // Download the audio bytes from our public Supabase Storage URL.
  let buffer: Buffer;
  let mime = m.media_mime_type ?? "audio/ogg";
  try {
    const dl = await fetch(m.media_url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!dl.ok) {
      return NextResponse.json(
        { error: `Audio fetch failed (HTTP ${dl.status})` },
        { status: 502 },
      );
    }
    if (dl.headers.get("content-type")) mime = dl.headers.get("content-type")!;
    buffer = Buffer.from(await dl.arrayBuffer());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Audio fetch error" },
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

  // Whisper accepts mp3/m4a/wav/webm/ogg. WhatsApp voice notes ship
  // as ogg/opus which Whisper handles natively.
  const ext = (mime.split("/")[1] ?? "ogg").split(";")[0].trim() || "ogg";
  const filename = `${m.id}.${ext}`;
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime }),
    filename,
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Whisper call failed" },
      { status: 502 },
    );
  }

  // Write both transcript (canonical) and content (so the bot's
  // history reader picks it up on the next pass without changes).
  // Preserve any existing caption — caption + spoken text concatenate
  // with a separator so the LLM sees both.
  const merged = m.content?.trim()
    ? `${m.content.trim()}\n\n[voice note] ${transcript}`
    : `[voice note] ${transcript}`;

  await admin
    .from("messages")
    .update({ transcript: transcript || null, content: merged || null })
    .eq("id", id);

  // Now that the spoken text has landed on `content`, fire the AI
  // pipeline so the bot replies to what was actually said. The
  // webhook deliberately skipped this step for audio messages so
  // the bot wouldn't reply to an empty content. Fire-and-forget —
  // the operator-facing transcript response shouldn't block on the
  // bot's typing window.
  if (transcript) {
    const internalToken = await getCredential("webhook_internal_token");
    if (internalToken) {
      const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      // Need contact_id for the automation processor — fetch from
      // the message row we already touched.
      const { data: refreshed } = await admin
        .from("messages")
        .select("contact_id")
        .eq("id", id)
        .maybeSingle();
      if (refreshed?.contact_id) {
        void fetch(`${origin}/api/automation/process`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_id: refreshed.contact_id,
            trigger_message_id: id,
            token: internalToken,
          }),
        }).catch((e) => {
          console.error(
            "[transcribe] automation trigger failed:",
            e instanceof Error ? e.message : e,
          );
        });
      }
    }
  }

  return NextResponse.json({ ok: true, transcript, cached: false });
}
