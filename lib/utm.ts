// Campaign attribution helpers. Two sources feed the same params bag:
//
//  1. wa.me?text=... links — the pre-filled marketing string lands in the
//     lead's FIRST message text (visible to the lead). parseUtm() pulls it.
//  2. Click-to-WhatsApp ads — Meta attaches a `referral` object to the
//     first inbound (source_id, ctwa_clid, source_url, …). Invisible to the
//     lead. buildReferralParams() normalises it.
//
// Both produce a UtmParams bag stored on contacts.utm_params, with a single
// human label (attributionLabel) on contacts.utm_source.

export interface UtmParams {
  [key: string]: string;
}

// key  =  utm_* | one of the known tracking ids
// value = up to the next whitespace / separator (& , ] ) so we don't eat
//         the rest of a sentence after a bare `utm_source: google thanks`.
const KEY_RE =
  /\b(utm_[a-z0-9_]+|source_id|sub_source|campaign_id|ad_id|adset_id|ref|ctwa_clid|fbclid|gclid)\s*[=:]\s*([^\s&,\]\)]+)/gi;

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Parse UTM / tracking params out of free text (wa.me pre-filled marker). */
export function parseUtm(text: string | null | undefined): UtmParams | null {
  if (!text) return null;
  const out: UtmParams = {};
  KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    const val = safeDecode(m[2]).trim();
    // First occurrence wins — don't let a later duplicate clobber it.
    if (val && !(key in out)) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

// Meta ad-attribution values that can be mapped to LSQ schema fields
// (Settings → CRM → Facebook Ads fields). `key` is the
// contacts.utm_params key; `label` is what the operator sees.
export const FB_AD_SOURCES = [
  { key: "source_id", label: "Source ID" },
  { key: "ctwa_clid", label: "Ad Click ID" },
  { key: "campaign_id", label: "Campaign ID" },
  { key: "campaign_name", label: "Campaign" },
  { key: "adset_name", label: "Ad set" },
  { key: "ad_name", label: "Ad" },
  { key: "source_url", label: "Source URL" },
] as const;

export type FbAdSourceKey = (typeof FB_AD_SOURCES)[number]["key"];

export const FB_AD_SOURCE_KEYS: readonly string[] = FB_AD_SOURCES.map((s) => s.key);

export interface FbAdFieldMapping {
  lsq_field: string;
  source: string;
}

/** Resolve the configured Facebook-ad → CRM field mappings against a
 *  contact's utm_params. Returns LSQ {Attribute, Value} pairs, skipping
 *  any whose source value isn't present yet (e.g. campaign names before
 *  ad-attribution has resolved). */
export function buildFbAdLeadFields(
  utmParams: Record<string, unknown> | null | undefined,
  mappings: FbAdFieldMapping[] | null | undefined,
): Array<{ Attribute: string; Value: string }> {
  if (!utmParams || !Array.isArray(mappings)) return [];
  const out: Array<{ Attribute: string; Value: string }> = [];
  for (const m of mappings) {
    const field = (m?.lsq_field ?? "").trim();
    const src = (m?.source ?? "").trim();
    if (!field || !FB_AD_SOURCE_KEYS.includes(src)) continue;
    const raw = utmParams[src];
    const value = raw == null ? "" : String(raw).trim();
    if (!value) continue;
    out.push({ Attribute: field, Value: value });
  }
  return out;
}

export interface ReferralLike {
  source_url?: string | null;
  source_id?: string | null;
  source_type?: string | null;
  headline?: string | null;
  body?: string | null;
  media_type?: string | null;
  ctwa_clid?: string | null;
}

/** Normalise a Meta Click-to-WhatsApp `referral` object into the params
 *  bag. Invisible attribution — unlike a wa.me marker it never shows up in
 *  the message the lead sends. */
export function buildReferralParams(
  ref: ReferralLike | null | undefined,
): UtmParams | null {
  if (!ref) return null;
  const out: UtmParams = {};
  const put = (k: string, v: unknown) => {
    if (v != null && String(v).trim()) out[k] = String(v).trim();
  };
  put("source_id", ref.source_id);
  put("source_type", ref.source_type);
  put("source_url", ref.source_url);
  put("ctwa_clid", ref.ctwa_clid);
  put("headline", ref.headline);
  put("body", ref.body);
  put("media_type", ref.media_type);
  return Object.keys(out).length ? out : null;
}

/** Human-readable single source label for display. Handles the wa.me text
 *  UTM (utm_source) and the CTWA referral (derive from source_url host,
 *  e.g. instagram.com → Instagram). */
export function attributionLabel(p: UtmParams | null): string | null {
  if (!p) return null;
  if (p.utm_source) return p.utm_source;
  if (p.source_url) {
    try {
      const host = new URL(p.source_url).hostname.replace(/^www\./, "");
      if (host.includes("instagram")) return "Instagram";
      if (host.includes("facebook") || host.startsWith("fb.")) return "Facebook";
      if (host.includes("youtube") || host.includes("youtu.be")) return "YouTube";
      return host;
    } catch {
      /* fall through to the id-based fallbacks */
    }
  }
  return p.source_type || p.source_id || p.ref || p.utm_campaign || null;
}
