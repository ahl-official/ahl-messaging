// GET /api/lead-distribution/lead-detail?prospectId=<id>
//   → the lead's full CRM field set (mx_utm_source, mx_NDR_Reason, mx_Brand…).
// The webhook payload only carries a subset (no mx_utm_source / mx_NDR_Reason),
// so the Executions expand view fetches the authoritative values here.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { lsqGetLeadById } from "@/lib/lsq";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const prospectId = request.nextUrl.searchParams.get("prospectId")?.trim();
  if (!prospectId) return NextResponse.json({ error: "prospectId required" }, { status: 400 });

  const res = await lsqGetLeadById(prospectId);
  if (!res.ok) return NextResponse.json({ error: res.error ?? "CRM fetch failed", fields: {} }, { status: 502 });
  return NextResponse.json({ fields: res.fields });
}
