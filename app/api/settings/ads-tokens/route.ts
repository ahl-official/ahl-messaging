// GET / PATCH /api/settings/ads-tokens
//
// Per-number Meta Marketing (ads_read) tokens for resolving a
// Click-to-WhatsApp lead's source_id into campaign / ad set / ad NAMES.
// Owner-only. Each number carries its own token + ad account (grouped by
// portfolio in the UI). Resolution at read time: number -> env
// META_ADS_TOKEN.
//
// IMPORTANT: token values never leave the server. GET returns only a
// "set" boolean (+ the non-secret ad account id).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { listPortfolios } from "@/lib/portfolios";
import { getNumberAdsRow, listNumberAdsRows, saveNumberAdsToken } from "@/lib/ads-tokens";

export const runtime = "nodejs";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  const numberRows = await listNumberAdsRows();

  // Number labels live in business_numbers (env only has the ids).
  const admin = createServiceRoleClient();
  const { data: bnRows } = await admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name, nickname");
  const labels = new Map<string, { number: string; label: string }>();
  for (const r of (bnRows as Array<{
    phone_number_id: string;
    display_phone_number: string | null;
    verified_name: string | null;
    nickname: string | null;
  }> | null) ?? []) {
    labels.set(r.phone_number_id, {
      number: r.display_phone_number || r.phone_number_id,
      label: r.nickname || r.verified_name || r.display_phone_number || r.phone_number_id,
    });
  }

  const portfolios = listPortfolios()
    // Meta portfolios only — Interakt has no Meta ad account.
    .filter((p) => (p.provider || "meta") === "meta")
    .map((p) => ({
      key: p.key,
      name: p.name,
      display_name: p.display_name,
      numbers: p.phone_number_ids.map((pid) => {
        const nrow = numberRows.get(pid);
        const meta = labels.get(pid);
        return {
          phone_number_id: pid,
          number: meta?.number ?? pid,
          label: meta?.label ?? pid,
          token_set: !!(nrow?.ads_token && nrow.ads_token.trim()),
          ad_account_id: nrow?.ad_account_id ?? null,
        };
      }),
    }));

  return NextResponse.json({ portfolios });
}

interface PatchBody {
  phone_number_id?: string;
  ads_token?: string | null;
  ad_account_id?: string | null;
}

export async function PATCH(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const pid = body.phone_number_id?.trim();
  if (!pid) {
    return NextResponse.json({ error: "phone_number_id is required" }, { status: 400 });
  }
  if (!listPortfolios().some((p) => p.phone_number_ids.includes(pid))) {
    return NextResponse.json({ error: `Unknown number "${pid}"` }, { status: 400 });
  }

  // undefined = keep existing; "" = clear; string = set. The form sends
  // only the fields it changed, so the ad account can be edited without
  // re-typing the token (the token is never sent back to the browser).
  const existing = await getNumberAdsRow(pid);
  const token =
    body.ads_token === undefined ? existing?.ads_token ?? null : body.ads_token;
  const acct =
    body.ad_account_id === undefined
      ? existing?.ad_account_id ?? null
      : body.ad_account_id;
  await saveNumberAdsToken(pid, token, acct, member.user_id);
  return NextResponse.json({ ok: true });
}
