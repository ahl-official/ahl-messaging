// GET /api/lead-distribution/lead-sources
//   → every distinct lead Source stored on contacts (lsq_source), for the
//     Lead-source filter dropdown. LSQ's metadata API doesn't expose Source
//     options, so we read what we've actually seen.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("lead_distribution_sources");
  if (error) return NextResponse.json({ error: error.message, sources: [] }, { status: 500 });
  const sources = (data ?? [])
    .map((r: { source: string | null }) => (r.source ?? "").trim())
    .filter(Boolean)
    // Drop junk sources that are just a phone number / bare digits.
    .filter((s: string) => !/^\d{5,}$/.test(s));
  return NextResponse.json({ sources });
}
