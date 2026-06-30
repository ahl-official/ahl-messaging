// WhatsApp Embedded Signup — server helpers. Onboards a number to the
// Cloud API (or coexistence, if the Meta config has it enabled) directly
// from our own dashboard, instead of depending on a BSP's signup.
//
// Flow: the browser runs Meta's Embedded Signup popup (Facebook Login for
// Business) and hands us back an OAuth `code` + the onboarded
// `phone_number_id` / `waba_id`. We exchange the code for a business token,
// subscribe our app to the WABA's webhooks, then file the number under a
// portfolio so the existing Cloud-API pipeline picks it up.
//
// Per-app config lives on each portfolio (so multiple Meta apps are
// supported — the operator picks which portfolio/app to onboard under):
//   • PORTFOLIO_<KEY>_APP_ID            — the Meta App that owns the config
//   • PORTFOLIO_<KEY>_APP_SECRET        — that App's secret (server-only)
//   • PORTFOLIO_<KEY>_EMBEDDED_CONFIG_ID — Embedded Signup configuration id
//
// Server-only.

import { getApiVersion } from "@/lib/whatsapp";

/** Exchange the Embedded-Signup OAuth `code` for a business access token,
 *  using the onboarding app's id + secret. Returns the token (long-lived
 *  business-integration system-user token). */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
): Promise<string> {
  if (!appId || !appSecret) {
    throw new Error("Portfolio is missing APP_ID / APP_SECRET for Embedded Signup");
  }
  const v = await getApiVersion();
  const url = new URL(`https://graph.facebook.com/${v}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);

  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error?.message ?? `Code exchange HTTP ${res.status}`);
  }
  return json.access_token;
}

/** Subscribe our app to the WABA's webhooks so inbound events for its
 *  numbers reach /api/webhook. Idempotent on Meta's side. */
export async function subscribeAppToWaba(wabaId: string, token: string): Promise<void> {
  const v = await getApiVersion();
  const res = await fetch(`https://graph.facebook.com/${v}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    error?: { message?: string };
  };
  if (!res.ok || json.success === false) {
    throw new Error(json.error?.message ?? `subscribed_apps HTTP ${res.status}`);
  }
}

export interface EmbeddedPhoneMeta {
  display_phone_number: string | null;
  verified_name: string | null;
  platform_type: string | null;
  status: string | null;
}

/** Read the onboarded number's display fields + connection state using the
 *  freshly-exchanged token (the portfolio token may not have access yet). */
export async function fetchEmbeddedPhoneMeta(
  phoneNumberId: string,
  token: string,
): Promise<EmbeddedPhoneMeta> {
  const v = await getApiVersion();
  const fields = "display_phone_number,verified_name,platform_type,status";
  const res = await fetch(
    `https://graph.facebook.com/${v}/${phoneNumberId}?fields=${fields}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) },
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? `phone fetch HTTP ${res.status}`);
  return {
    display_phone_number: (json.display_phone_number as string) ?? null,
    verified_name: (json.verified_name as string) ?? null,
    platform_type: (json.platform_type as string) ?? null,
    status: (json.status as string) ?? null,
  };
}
