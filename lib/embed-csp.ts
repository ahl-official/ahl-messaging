// CRM-embed framing config. Pure (no server-only imports) so it's safe in
// BOTH the Edge middleware (which sets the runtime CSP header) and Node API
// routes. The list of CRM origins allowed to frame /embed lives in
// app_settings → owner edits it in Settings → Embed, NO rebuild needed.

export const EMBED_ORIGINS_KEY = "embed_allowed_origins";

// Seed used until the owner saves a list (so the iframe keeps working on a
// fresh deploy). CRM_EMBED_ORIGIN may hold several space-separated origins.
const ENV_ORIGIN = (
  process.env.CRM_EMBED_ORIGIN || "https://crm.americanhairline.com"
).trim();
export const DEFAULT_EMBED_ORIGINS = ENV_ORIGIN
  ? ENV_ORIGIN.split(/\s+/).filter(Boolean)
  : [];

// Local CRM dev server — always allowed so the widget can be tested locally
// against any build. Deliberate, accepted trade-off (a local page on :3001
// can frame the embed).
const LOCAL_DEV_ORIGIN = "http://localhost:3001";

/** Validate + normalize to a bare origin (scheme://host[:port], no path).
 *  Returns null for anything that isn't a valid http(s) origin. */
export function normalizeOrigin(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The `Content-Security-Policy: frame-ancestors …` value for /embed
 *  responses. Always includes 'self' + the local dev origin. */
export function buildFrameAncestors(origins: string[]): string {
  const cleaned = origins
    .map(normalizeOrigin)
    .filter((o): o is string => o !== null);
  const set = new Set(["'self'", ...cleaned, LOCAL_DEV_ORIGIN]);
  return `frame-ancestors ${[...set].join(" ")}`;
}
