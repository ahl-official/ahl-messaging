// GET  /api/lsq/evolution-toggle  → { enabled: boolean }
// PUT  /api/lsq/evolution-toggle  body { enabled: boolean }
//
// Global on/off for CRM lead creation from Evolution (Baileys)
// WhatsApp numbers. Owner-only. When OFF, /api/lsq/ensure-lead skips
// every inbound on a number whose provider is 'evolution'.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import {
  getLsqEvolutionLeadCreateEnabled,
  setLsqEvolutionLeadCreateEnabled,
} from "@/lib/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner" && me.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const enabled = await getLsqEvolutionLeadCreateEnabled();
  return NextResponse.json(
    { enabled },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  let body: { enabled?: unknown };
  try {
    body = (await request.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "`enabled` must be boolean" },
      { status: 400 },
    );
  }
  await setLsqEvolutionLeadCreateEnabled(body.enabled);
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
