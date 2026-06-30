// Cookie attributes for the CRM <iframe> embed (/embed/inbox).
//
// OPT-IN: nothing here changes until a cookie domain is configured. Without
// it, @supabase/ssr's SameSite=Lax default stays — Lax is the main app's
// CSRF barrier, so it must not be dropped on deployments that don't embed.
//
// When configured, the overlay sets SameSite=None + Secure so the Supabase
// auth cookies travel when this app renders inside an iframe, and widens
// them to COOKIE_DOMAIN (e.g. ".hairmedindia.com") so wa.hairmedindia.com
// and crm.hairmedindia.com share ONE login — the agent signs in once on
// either. The middleware's Sec-Fetch-Site guard replaces the CSRF
// protection that Lax provided.
//
// NOTE: browsers block third-party cookies inside iframes, so the embed only
// works when the CRM and this dashboard sit under the SAME parent domain
// (same-site). That's exactly what the cookie domain sets up — it must be
// the shared parent domain, not a full host. A CRM on an unrelated domain
// will NOT get a session in the iframe no matter what these attributes say.
//
// Env: set NEXT_PUBLIC_COOKIE_DOMAIN (read by BOTH this server code and
// lib/supabase/client.ts for browser-side token refreshes — one var, no
// split-brain). COOKIE_DOMAIN also works server-side but leaves the browser
// client writing host-only cookies, so prefer the NEXT_PUBLIC_ one.

import type { CookieOptions } from "@supabase/ssr";

const COOKIE_DOMAIN =
  (process.env.COOKIE_DOMAIN || process.env.NEXT_PUBLIC_COOKIE_DOMAIN)?.trim() ||
  undefined;

/** Overlay iframe-safe attributes onto whatever @supabase/ssr asks for.
 *  Identity function until a cookie domain is configured. */
export function withEmbedCookieOptions(
  options: CookieOptions = {},
): CookieOptions {
  if (!COOKIE_DOMAIN) return options;
  return {
    ...options,
    sameSite: "none",
    secure: true,
    domain: COOKIE_DOMAIN,
  };
}
