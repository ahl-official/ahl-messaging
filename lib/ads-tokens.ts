// Per-portfolio Meta Marketing (ads_read) tokens.
//
// Each portfolio (= one Meta Business App) has its own ad account, so the
// token that resolves a CTWA lead's source_id into campaign / ad set / ad
// names is per-portfolio. Stored in `public.portfolio_ads_tokens` so an
// owner can rotate it from Settings -> Ads / Marketing without a redeploy.
//
// Fallback: if a portfolio has no DB row, the global env META_ADS_TOKEN is
// used (keeps existing single-token setups working).
//
// Server-only — the token never leaves the server (the Settings API
// returns only a "set" / "missing" boolean).

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";

export interface AdsTokenRow {
  portfolio_key: string;
  ads_token: string | null;
  ad_account_id: string | null;
}

/** Raw row for one portfolio (no env fallback). */
export async function getAdsTokenRow(
  portfolioKey: string,
): Promise<AdsTokenRow | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("portfolio_ads_tokens")
    .select("portfolio_key, ads_token, ad_account_id")
    .eq("portfolio_key", portfolioKey)
    .maybeSingle();
  return (data as AdsTokenRow | null) ?? null;
}

/** All portfolio rows, keyed by portfolio_key — for the Settings list. */
export async function listAdsTokenRows(): Promise<Map<string, AdsTokenRow>> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("portfolio_ads_tokens")
    .select("portfolio_key, ads_token, ad_account_id");
  const map = new Map<string, AdsTokenRow>();
  for (const r of (data as AdsTokenRow[] | null) ?? []) {
    map.set(r.portfolio_key, r);
  }
  return map;
}

export interface NumberAdsRow {
  phone_number_id: string;
  ads_token: string | null;
  ad_account_id: string | null;
}

/** Raw per-number override row (no fallback). */
export async function getNumberAdsRow(
  phoneNumberId: string,
): Promise<NumberAdsRow | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("number_ads_tokens")
    .select("phone_number_id, ads_token, ad_account_id")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  return (data as NumberAdsRow | null) ?? null;
}

/** All per-number rows, keyed by phone_number_id — for the Settings list. */
export async function listNumberAdsRows(): Promise<Map<string, NumberAdsRow>> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("number_ads_tokens")
    .select("phone_number_id, ads_token, ad_account_id");
  const map = new Map<string, NumberAdsRow>();
  for (const r of (data as NumberAdsRow[] | null) ?? []) {
    map.set(r.phone_number_id, r);
  }
  return map;
}

/** Upsert a number's override (empty string clears). */
export async function saveNumberAdsToken(
  phoneNumberId: string,
  adsToken: string | null,
  adAccountId: string | null,
  updatedBy: string | null,
): Promise<void> {
  const admin = createServiceRoleClient();
  await admin.from("number_ads_tokens").upsert(
    {
      phone_number_id: phoneNumberId,
      ads_token: adsToken && adsToken.trim() ? adsToken.trim() : null,
      ad_account_id: adAccountId && adAccountId.trim() ? adAccountId.trim() : null,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "phone_number_id" },
  );
}

/** Resolve the ads token to use for a given business phone number id.
 *  The token is configured per number (Settings -> Ads / Marketing);
 *  global env META_ADS_TOKEN is the fallback. Returns null if neither is
 *  set. */
export async function resolveAdsTokenForPhoneNumberId(
  phoneNumberId: string,
): Promise<string | null> {
  const numberRow = await getNumberAdsRow(phoneNumberId);
  if (numberRow?.ads_token && numberRow.ads_token.trim()) {
    return numberRow.ads_token.trim();
  }
  return await getCredential("meta_ads_token");
}

/** Upsert a portfolio's token (empty string clears it). Owner-gated by the
 *  caller. */
export async function saveAdsToken(
  portfolioKey: string,
  adsToken: string | null,
  adAccountId: string | null,
  updatedBy: string | null,
): Promise<void> {
  const admin = createServiceRoleClient();
  await admin.from("portfolio_ads_tokens").upsert(
    {
      portfolio_key: portfolioKey,
      ads_token: adsToken && adsToken.trim() ? adsToken.trim() : null,
      ad_account_id: adAccountId && adAccountId.trim() ? adAccountId.trim() : null,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "portfolio_key" },
  );
}
