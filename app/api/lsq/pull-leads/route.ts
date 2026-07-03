// POST /api/lsq/pull-leads
//
// Campaign-preview wrapper around lib/lsq-pull. Hits LSQ directly to retrieve
// leads matching the operator's filter (stages / owners / sources / brands /
// date range) and returns a flat list the campaign UI previews + turns into
// recipients. The pull logic itself lives in lib/lsq-pull (shared with the
// recurring-campaign daily job).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getLsqConfig } from "@/lib/lsq";
import { pullLeadsFromLsq, type PullLeadsFilter } from "@/lib/lsq-pull";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  if (!getLsqConfig().configured) {
    return NextResponse.json(
      { error: "LSQ not configured. Set LSQ_HOST + LSQ_ACCESS_KEY + LSQ_SECRET_KEY." },
      { status: 400 },
    );
  }

  let body: PullLeadsFilter;
  try {
    body = (await request.json()) as PullLeadsFilter;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const result = await pullLeadsFromLsq(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "CRM search failed" }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    total_records_in_lsq: result.total_records_in_lsq,
    fetched: result.fetched,
    leads: result.leads.map((l) => ({
      wa_id: l.wa_id,
      display_name: l.display_name,
      stage: l.stage,
      source: l.source,
      sub_source: l.sub_source,
    })),
    truncated_at_cap: result.truncated_at_cap,
  });
}
