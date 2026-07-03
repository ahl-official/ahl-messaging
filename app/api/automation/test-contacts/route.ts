// GET  /api/automation/test-contacts  → { wa_ids: string[] }
// PUT  /api/automation/test-contacts  { wa_ids: string[] }
//
// Workspace-wide list of client WhatsApp numbers (digits-only wa_ids)
// the bot is allowed to reply to. Empty list = no gate (bot replies to
// every client on every enabled number, i.e. production). When set,
// the bot replies ONLY to messages from these client phones —
// real customers on the same connected numbers stay quiet. This is the
// safe way to live-test a freshly trained bot on your own phone + a
// couple of testers before going live to everyone.
//
// Owner / superadmin / admin can edit. Anyone can read.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import {
  getAutomationTestContactNumbers,
  setAutomationTestContactNumbers,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const wa_ids = await getAutomationTestContactNumbers();
  return NextResponse.json({ wa_ids });
}

export async function PUT(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  let body: { wa_ids?: unknown };
  try {
    body = (await request.json()) as { wa_ids?: unknown };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.wa_ids)) {
    return NextResponse.json(
      { error: "wa_ids must be an array of phone strings" },
      { status: 400 },
    );
  }
  const wa_ids = (body.wa_ids as unknown[]).map((x) =>
    String(x ?? "").replace(/\D/g, ""),
  );
  await setAutomationTestContactNumbers(wa_ids);
  return NextResponse.json({
    ok: true,
    wa_ids: wa_ids.filter((s) => s.length >= 6),
  });
}
