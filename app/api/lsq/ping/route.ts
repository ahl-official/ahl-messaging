// POST /api/lsq/ping — owner-triggered "Test connection" probe. Calls
// the Leads.GetByMobileNumber endpoint with a dummy mobile to verify
// LSQ_HOST + LSQ_ACCESS_KEY + LSQ_SECRET_KEY actually authenticate.
// Returns the raw status / error message so the UI can surface useful
// debugging info ("invalid secret key", "host unreachable", etc.).

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { lsqPing } from "@/lib/lsq";

export const runtime = "nodejs";

export async function POST() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  const result = await lsqPing();
  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    error: result.error,
  });
}
