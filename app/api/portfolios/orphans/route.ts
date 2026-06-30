// GET /api/portfolios/orphans
// Returns business_numbers rows whose phone_number_id isn't in any
// PORTFOLIO_*_PHONE_IDS env var. The dashboard shows a banner when this
// list is non-empty, prompting the owner to assign each number to a
// portfolio.

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { listPortfolios } from "@/lib/portfolios";

export const runtime = "nodejs";

interface BusinessNumberRow {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  created_at: string;
  provider?: "meta" | "evolution" | null;
}

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    // Non-owners don't need to know about orphans.
    return NextResponse.json({ orphans: [] });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name, created_at, provider");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const known = new Set<string>();
  for (const p of listPortfolios()) {
    for (const id of p.phone_number_ids) known.add(id);
  }

  // Evolution numbers are intentionally NOT part of the portfolio
  // system — their auth lives on the row itself (evolution_api_key),
  // not in PORTFOLIO_* env vars. Exclude them so the banner doesn't
  // nag owners about unofficial numbers that don't need assignment.
  const orphans = (data ?? []).filter(
    (n: BusinessNumberRow) =>
      n.provider !== "evolution" && !known.has(n.phone_number_id),
  );
  return NextResponse.json({ orphans });
}
