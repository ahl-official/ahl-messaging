// POST /api/campaigns/tick
// Internal endpoint called by the in-process scheduler every 30s. Runs
// one campaign-worker tick — picks scheduled campaigns, sends a batch
// of recipients each. Auth via WEBHOOK_INTERNAL_TOKEN (same handshake
// the automation sweep uses).

import { NextResponse, type NextRequest } from "next/server";
import { getCredential } from "@/lib/credentials";
import { runCampaignTick } from "@/lib/campaigns";

export const runtime = "nodejs";
// Each tick sends up to a handful of messages — give it room.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (auth !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await runCampaignTick();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "tick failed" },
      { status: 500 },
    );
  }
}
