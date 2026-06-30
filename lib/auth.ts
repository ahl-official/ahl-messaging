// Single source of truth for the corporate-domain restriction.
// Override via NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN in .env.local (comma-separated
// for more than one domain, e.g. "americanhairline.com,alchemane.com").

export const ALLOWED_EMAIL_DOMAINS = (
  process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN || "americanhairline.com,alchemane.com"
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Back-compat: the primary domain (first in the list). Used for the Google
// account-chooser hint and any single-domain UI copy.
export const ALLOWED_EMAIL_DOMAIN = ALLOWED_EMAIL_DOMAINS[0] ?? "americanhairline.com";

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const trimmed = email.trim().toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.some((d) => trimmed.endsWith(`@${d}`));
}

export function domainNotAllowedMessage(): string {
  const list = ALLOWED_EMAIL_DOMAINS.map((d) => `@${d}`).join(" or ");
  return `Only ${list} accounts can sign in.`;
}

// Hard session cap — every login expires 12 hours after it started, regardless
// of refresh-token activity. Enforced via the SESSION_STARTED_COOKIE. Owners
// are exempt (see lib/supabase/middleware.ts).
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
export const SESSION_STARTED_COOKIE = "qht_session_started";

// Cookie must outlive the session window — otherwise it expires at the
// cap, the browser drops it, and the middleware's "missing → seed"
// path quietly grants a fresh window. 30 days is plenty.
export const sessionStartedCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 30 * 24 * 60 * 60,
};
