// POST /api/whatsapp-call/[id]/connected
//
// Client-side ground-truth signal that the audio path is alive
// (pc.connectionState === "connected"). Stamps the row's status →
// accepted + accepted_at, and credits the operator who answered.
//
// Why this exists: Meta's `accept` webhook event for outbound calls
// arrives 2–5s late and is occasionally dropped entirely, leaving
// rows stuck at "ringing" → resolving to "missed" when the call
// actually connected. WebRTC's connectionState transition is the
// most reliable signal we have for "audio is flowing now".
//
// We deliberately don't call Meta's /calls endpoint — it's just a
// DB stamp. Idempotent via accepted_at guard.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: waCallId } = await params;
  if (!waCallId) {
    return NextResponse.json({ error: "wa_call_id required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("whatsapp_calls")
    .select("status, accepted_at, start_at")
    .eq("wa_call_id", waCallId)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }
  if (row.accepted_at) {
    return NextResponse.json({ ok: true, already: true });
  }

  const acceptedAt = new Date().toISOString();
  const ringSeconds = row.start_at
    ? Math.max(
        0,
        Math.round(
          (new Date(acceptedAt).getTime() -
            new Date(row.start_at).getTime()) /
            1000,
        ),
      )
    : null;

  const { error } = await admin
    .from("whatsapp_calls")
    .update({
      status: "accepted",
      accepted_at: acceptedAt,
      ring_seconds: ringSeconds,
      handled_by_user_id: member.user_id,
      handled_by_email: member.email,
    })
    .eq("wa_call_id", waCallId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
