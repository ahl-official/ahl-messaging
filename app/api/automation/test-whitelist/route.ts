// GET  /api/automation/test-whitelist  → { ids: string[] }
// PUT  /api/automation/test-whitelist  { ids: string[] }
//
// A workspace-wide allow-list of business_phone_number_ids the bot is
// permitted to fire on. Empty list = no gate (per-number `enabled`
// config decides). Lets an operator turn the bot on for 1-2 numbers in
// production for a staged rollout WITHOUT having to flip every other
// number's `enabled` off and back on later.
//
// Owner / superadmin / admin can edit. Anyone can read.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import {
  getAutomationTestWhitelist,
  setAutomationTestWhitelist,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ids = await getAutomationTestWhitelist();
  return NextResponse.json({ ids });
}

export async function PUT(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  let body: { ids?: unknown };
  try {
    body = (await request.json()) as { ids?: unknown };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.ids)) {
    return NextResponse.json(
      { error: "ids must be an array of phone_number_id strings" },
      { status: 400 },
    );
  }
  const ids = (body.ids as unknown[])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  await setAutomationTestWhitelist(ids);
  return NextResponse.json({ ok: true, ids });
}
