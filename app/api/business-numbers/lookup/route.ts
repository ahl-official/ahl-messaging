// GET /api/business-numbers/lookup?phone_number_id=...&portfolio_key=...
// Hits Meta Graph API to fetch display_phone_number + verified_name for a
// phone_number_id that's not yet registered in our DB. Used by the
// "Add WhatsApp number" dialog to auto-fill those fields.
//
// If portfolio_key is given, uses that portfolio's access token. Otherwise
// it tries every active portfolio's token until one returns 200 — so the
// user can autofill before picking a portfolio.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { listPortfolios } from "@/lib/portfolios";
import { getApiVersion } from "@/lib/whatsapp";

export const runtime = "nodejs";

interface MetaPhoneFields {
  display_phone_number?: string;
  verified_name?: string;
  id?: string;
}

async function fetchOnce(
  apiVersion: string,
  phoneNumberId: string,
  token: string,
): Promise<MetaPhoneFields | null> {
  try {
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as MetaPhoneFields;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner" && member.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const phoneNumberId = request.nextUrl.searchParams.get("phone_number_id")?.trim();
  if (!phoneNumberId || !/^\d{6,}$/.test(phoneNumberId)) {
    return NextResponse.json(
      { error: "phone_number_id must be a numeric Meta ID" },
      { status: 400 },
    );
  }

  const requestedKey = request.nextUrl.searchParams.get("portfolio_key")?.trim() || null;
  const apiVersion = await getApiVersion();
  const portfolios = listPortfolios().filter((p) => p.is_active && p.access_token);
  if (portfolios.length === 0) {
    return NextResponse.json(
      { error: "No active portfolios with access tokens configured" },
      { status: 400 },
    );
  }

  // If a portfolio is selected, try only that one (clear failure mode for UI).
  if (requestedKey) {
    const p = portfolios.find((x) => x.key === requestedKey);
    if (!p) {
      return NextResponse.json(
        { error: `Unknown portfolio: ${requestedKey}` },
        { status: 400 },
      );
    }
    const data = await fetchOnce(apiVersion, phoneNumberId, p.access_token);
    if (!data || !data.display_phone_number) {
      return NextResponse.json(
        {
          error: `Couldn't fetch from Meta using "${p.name}". Check that this number belongs to that WABA.`,
        },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      display_phone_number: data.display_phone_number,
      verified_name: data.verified_name ?? null,
      portfolio_key: p.key,
    });
  }

  // No portfolio chosen — try them all and return the first hit.
  for (const p of portfolios) {
    const data = await fetchOnce(apiVersion, phoneNumberId, p.access_token);
    if (data && data.display_phone_number) {
      return NextResponse.json({
        ok: true,
        display_phone_number: data.display_phone_number,
        verified_name: data.verified_name ?? null,
        portfolio_key: p.key,
      });
    }
  }

  return NextResponse.json(
    {
      error:
        "Couldn't fetch from any portfolio. Number ID may be wrong, or it lives in a WABA we don't have a token for.",
    },
    { status: 404 },
  );
}
