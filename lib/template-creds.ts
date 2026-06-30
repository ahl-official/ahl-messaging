// Single source of truth for "which Meta WhatsApp Business Account +
// access token does a templates API call use".
//
// Templates are WABA-scoped. The bug this fixes: the list route honoured
// a number's per-number `waba_id` override (Settings → Numbers) but the
// create / edit / delete routes only used the portfolio's default
// `business_account_id` — so a template created "for number A" landed
// on a different WABA than the one its list was read from.
//
// Every templates route now resolves through here. Pass `phoneNumberId`
// whenever the UI has a number selected so create/edit/delete land on
// exactly the WABA the list was read from.

import { getCredential } from "@/lib/credentials";
import { listPortfolios } from "@/lib/portfolios";
import { createServiceRoleClient } from "@/lib/supabase/server";

export interface TemplateCreds {
  /** Portfolio (or legacy env) access token. */
  token: string;
  /** The WABA id to address — per-number override if set, else the
   *  owning portfolio's business_account_id. */
  waba: string;
  /** The portfolio's own business_account_id, BEFORE any per-number
   *  override. When a number's override points at a WABA that doesn't exist
   *  / the token can't access (Meta error #100), the templates routes retry
   *  against this so one bad override can't break the whole section.
   *  null when there's no distinct portfolio default. */
  fallbackWaba: string | null;
  /** Every active Meta portfolio's access token, resolved-token first. A
   *  freshly added number often isn't filed under the portfolio whose token
   *  can actually read its WABA (PORTFOLIO_<key>_PHONE_IDS not updated yet),
   *  so the list route probes each of these against the WABA until one is
   *  authorized — templates then show without any .env edit. */
  candidateTokens: string[];
}

export const TEMPLATE_CREDS_MISSING_MSG =
  "WhatsApp credentials missing. Set WHATSAPP_BUSINESS_ACCOUNT_ID + WHATSAPP_ACCESS_TOKEN in .env.local, or configure a portfolio under Settings → Portfolios.";

/** Pull `{{1}}`, `{{2}}` placeholders out of a template body / header and
 *  return Meta's `["sample1", "sample2", ...]` example payload shape. */
export function extractPlaceholders(text: string): string[] {
  const matches = text.matchAll(/\{\{(\d+)\}\}/g);
  const nums = new Set<number>();
  for (const m of matches) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b).map((n) => `sample${n}`);
}

export async function resolveTemplateCreds(opts: {
  phoneNumberId?: string | null;
  portfolioKey?: string | null;
}): Promise<TemplateCreds | null> {
  const phoneNumberId = opts.phoneNumberId?.trim() || null;
  let portfolioKey = opts.portfolioKey?.trim() || null;

  const portfolios = listPortfolios();

  // A selected phone number's owning portfolio is authoritative — it
  // overrides whatever portfolio_key the caller passed.
  if (phoneNumberId) {
    const owner = portfolios.find((p) =>
      p.phone_number_ids.includes(phoneNumberId),
    );
    if (owner) portfolioKey = owner.key;
  }

  let token: string | null = null;
  let waba: string | null = null;

  // 1) Resolved portfolio.
  if (portfolioKey) {
    const p = portfolios.find((x) => x.key === portfolioKey);
    if (p?.access_token) {
      token = p.access_token;
      waba = p.business_account_id ?? null;
    }
  }
  // 2) Legacy single-tenant env.
  if (!token) {
    const envToken = (await getCredential("whatsapp_access_token")) ?? null;
    if (envToken) {
      token = envToken;
      waba = (await getCredential("whatsapp_business_account_id")) ?? null;
    }
  }
  // 3) First active portfolio.
  if (!token) {
    const fb = portfolios.find(
      (p) => p.is_active && p.access_token && p.business_account_id,
    );
    if (fb?.access_token) {
      token = fb.access_token;
      waba = fb.business_account_id ?? null;
    }
  }
  if (!token) return null;

  // The portfolio's own default WABA — kept as a fallback for when a
  // per-number override below turns out to be invalid.
  const portfolioWaba = waba;

  // Per-number WABA override — a number can be pinned to its own WABA
  // (Settings → Numbers → Edit WABA) that differs from the portfolio's.
  if (phoneNumberId) {
    const admin = createServiceRoleClient();
    const { data } = await admin
      .from("business_numbers")
      .select("waba_id")
      .eq("phone_number_id", phoneNumberId)
      .maybeSingle();
    const perNumber = (data?.waba_id as string | null)?.trim();
    if (perNumber) waba = perNumber;
  }

  if (!waba) return null;
  // Only expose a fallback when it's a real, different WABA than the one
  // we're about to try (i.e. an override is in effect).
  const fallbackWaba =
    portfolioWaba && portfolioWaba !== waba ? portfolioWaba : null;

  // Resolved token first, then every other active Meta portfolio token —
  // the list route tries them in order against the WABA so a not-yet-filed
  // number still finds an authorized token.
  const candidateTokens = Array.from(
    new Set([
      token,
      ...portfolios
        .filter((p) => p.is_active && p.provider !== "interakt" && p.access_token)
        .map((p) => p.access_token),
    ]),
  ).filter(Boolean);

  return { token, waba, fallbackWaba, candidateTokens };
}
