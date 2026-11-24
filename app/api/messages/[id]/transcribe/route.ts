// GET  /api/messages/[id]/transcribe — read cached transcript (no LLM call)
// POST /api/messages/[id]/transcribe — run Whisper if not cached yet

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getCredential } from "@/lib/credentials";
import { transcribeInboundAudioMessage } from "@/lib/transcribe-inbound-audio";

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
  const queryToken = new URL(request.url).searchParams.get("token")?.trim();
  if (expected && queryToken === expected) return true;
  return !!(await getCurrentMember());
}

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await authorize(request)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ ok: true, transcript: null, cached: false });
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
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "Message not found" }, { status: 404 });

  const url = new URL(request.url);
  const kickIfCached = url.searchParams.get("kick") === "1";
  const result = await transcribeInboundAudioMessage(id, { kickIfCached });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    transcript: result.transcript,
    cached: result.cached,
  });
}
