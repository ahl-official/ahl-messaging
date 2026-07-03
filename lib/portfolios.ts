// Portfolios — read from .env.local only. No DB. No UI mutations.
// Each portfolio is one Meta Business App (URoots, QHT Salon, …).
//
// Env shape:
//   PORTFOLIO_KEYS=UROOTS,QHT_CLINIC
//
//   PORTFOLIO_UROOTS_NAME="URoots by QHT"
//   PORTFOLIO_UROOTS_ACCESS_TOKEN=EAA...
//   PORTFOLIO_UROOTS_APP_ID=1686...
//   PORTFOLIO_UROOTS_BUSINESS_ACCOUNT_ID=2338...
//   PORTFOLIO_UROOTS_VERIFY_TOKEN=uroots_verify_xyz
//   PORTFOLIO_UROOTS_PHONE_IDS=1186098484633497,1234567890
//   PORTFOLIO_UROOTS_DISPLAY_NAME=URoots
//
//   PORTFOLIO_QHT_CLINIC_NAME="QHT Salon"
//   …
//
// Server-only — never import from a client component.

export interface Portfolio {
  key: string;
  name: string;
  access_token: string;
  app_id: string | null;
  /** App secret — only needed for Embedded Signup code exchange. */
  app_secret: string | null;
  /** Facebook Login for Business "Embedded Signup" configuration id. When
   *  set, this portfolio's app can onboard new numbers from our dashboard. */
  embedded_config_id: string | null;
  business_account_id: string | null;
  verify_token: string;
  phone_number_ids: string[];
  display_name: string | null;
  is_active: boolean;
  /** 'meta' (default) or 'interakt'. */
  provider: string;
}

/** Subset returned to UI — secrets stripped (app_secret never leaves server). */
export interface PortfolioPublic {
  key: string;
  name: string;
  app_id: string | null;
  embedded_config_id: string | null;
  business_account_id: string | null;
  display_name: string | null;
  phone_number_ids: string[];
  is_active: boolean;
  provider: string;
}

let cache: Portfolio[] | null = null;

function envOr(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function loadFromEnv(): Portfolio[] {
  const keys = envOr("PORTFOLIO_KEYS")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  return keys.map((key) => {
    const env = (suffix: string) => envOr(`PORTFOLIO_${key}_${suffix}`);
    return {
      key,
      name: env("NAME") || key,
      access_token: env("ACCESS_TOKEN"),
      app_id: env("APP_ID") || null,
      app_secret: env("APP_SECRET") || null,
      embedded_config_id: env("EMBEDDED_CONFIG_ID") || null,
      business_account_id: env("BUSINESS_ACCOUNT_ID") || null,
      verify_token: env("VERIFY_TOKEN"),
      phone_number_ids: env("PHONE_IDS")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      display_name: env("DISPLAY_NAME") || null,
      is_active: env("ACTIVE").toLowerCase() !== "false",
      provider: env("PROVIDER").toLowerCase() || "meta",
    };
  });
}

export function listPortfolios(): Portfolio[] {
  if (!cache) cache = loadFromEnv();
  return cache;
}

export function publicView(p: Portfolio): PortfolioPublic {
  return {
    key: p.key,
    name: p.name,
    app_id: p.app_id,
    embedded_config_id: p.embedded_config_id,
    business_account_id: p.business_account_id,
    display_name: p.display_name,
    phone_number_ids: p.phone_number_ids,
    is_active: p.is_active,
    provider: p.provider,
  };
}

export function invalidatePortfolioCache(): void {
  cache = null;
}

export function getPortfolioByKey(key: string): Portfolio | null {
  return listPortfolios().find((p) => p.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Per-number lookup — the hot path. Send/receive code asks "what
// credentials should I use for this phone_number_id?".
// ---------------------------------------------------------------------------
export async function getPortfolioByPhoneNumberId(
  phoneNumberId: string,
): Promise<Portfolio | null> {
  return (
    listPortfolios().find((p) => p.phone_number_ids.includes(phoneNumberId)) ?? null
  );
}

// ---------------------------------------------------------------------------
// Verify-token lookup — used by the webhook GET handshake. Meta sends
// `hub.verify_token=XXX`; we match it against any active portfolio.
// ---------------------------------------------------------------------------
export async function getPortfolioByVerifyToken(
  token: string,
): Promise<Portfolio | null> {
  return (
    listPortfolios().find((p) => p.verify_token === token && p.is_active) ?? null
  );
}

// ---------------------------------------------------------------------------
// Resolved credentials for a phone_number_id — preferred entry point for
// every fetch to graph.facebook.com.
// ---------------------------------------------------------------------------
export interface ResolvedNumberCreds {
  access_token: string;
  app_id: string | null;
  business_account_id: string | null;
  portfolio: Portfolio;
}

export async function resolveCredsForPhoneNumberId(
  phoneNumberId: string,
): Promise<ResolvedNumberCreds | null> {
  const portfolio = await getPortfolioByPhoneNumberId(phoneNumberId);
  if (!portfolio || !portfolio.access_token) return null;
  return {
    access_token: portfolio.access_token,
    app_id: portfolio.app_id,
    business_account_id: portfolio.business_account_id,
    portfolio,
  };
}

/** Throwing variant — use when the call must succeed or fail fast. */
export async function requireCredsForPhoneNumberId(
  phoneNumberId: string,
): Promise<ResolvedNumberCreds> {
  const creds = await resolveCredsForPhoneNumberId(phoneNumberId);
  if (!creds) {
    throw new Error(
      `No portfolio found for phone_number_id ${phoneNumberId}. Add it to PORTFOLIO_<key>_PHONE_IDS in .env.local and restart the server.`,
    );
  }
  return creds;
}
