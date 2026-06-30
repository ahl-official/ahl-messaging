// POST /api/portfolios/assign-number
// Body: { phone_number_id: string, portfolio_key: string }
//
// Appends the phone_number_id to PORTFOLIO_<key>_PHONE_IDS in .env.local
// and updates process.env so the running server picks it up without
// restart. Owner-only. Used by the "Unassigned numbers" popup.
//
// On Vercel/Railway/etc. the file write fails (read-only fs); we still
// update process.env in-memory so the current request flow works, but
// the client gets a `persisted: false` flag so it can show a warning
// and remind the operator to set the var in the hosting dashboard.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { listPortfolios, invalidatePortfolioCache } from "@/lib/portfolios";
import { appendPhoneIdToPortfolio } from "@/lib/env-writer";

export const runtime = "nodejs";

interface Body {
  phone_number_id?: string;
  portfolio_key?: string;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const phoneNumberId = body.phone_number_id?.trim();
  const portfolioKey = body.portfolio_key?.trim();
  if (!phoneNumberId || !portfolioKey) {
    return NextResponse.json(
      { error: "phone_number_id and portfolio_key are required" },
      { status: 400 },
    );
  }

  const portfolio = listPortfolios().find((p) => p.key === portfolioKey);
  if (!portfolio) {
    return NextResponse.json(
      { error: `Unknown portfolio: ${portfolioKey}` },
      { status: 400 },
    );
  }

  const result = await appendPhoneIdToPortfolio(portfolioKey, phoneNumberId);

  // Force the next listPortfolios() call to re-read process.env, picking
  // up the just-added phone ID.
  invalidatePortfolioCache();

  return NextResponse.json({
    ok: true,
    persisted: result.persisted,
    value: result.value,
    message: result.message,
  });
}
