// GET /api/lsq/status
// Returns whether CRM env vars are configured (booleans only —
// never sends the actual keys to the browser).

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getLsqStatusPublic } from "@/lib/lsq";

export const runtime = "nodejs";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(getLsqStatusPublic());
}
