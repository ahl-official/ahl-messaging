// GET /api/team/monitors
//
// Lower-cased emails of the workspace's "monitor" members (watch-only
// users whose owned leads count as unassigned). The inbox's Unassigned
// filter reads this so the count + live list stay accurate without the
// client knowing the whole team table. Any signed-in member may read it.

import { NextResponse } from "next/server";
import { getCurrentMember, getMonitorEmails } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const emails = await getMonitorEmails();
  return NextResponse.json(
    { emails },
    { headers: { "Cache-Control": "no-store" } },
  );
}
