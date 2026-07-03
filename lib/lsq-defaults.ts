// Authoritative fallback lists for the LSQ campaign filter UI. Merged
// with whatever master-data the CRM API returns — defaults render first
// (in operator-curated order), then any extra values the API surfaces
// get appended below. If LSQ is unreachable / rate-limited, the UI
// still has the full set to filter against.
//
// Maintained by the QHT operations team. Add / remove entries as the
// LSQ tenant evolves.

export const LSQ_DEFAULT_STAGES: string[] = [
  "New Lead",
  "Contacted",
  "Follow Up",
  "NBD Booked",
  "NBD Not Visited",
  "NBD Done",
  "Not Booked",
  "Order Booked",
  "Lost Lead",
];

export const LSQ_DEFAULT_SOURCES: string[] = [
  // Channels
  "Social Media",
  "Referral Sites",
  "Direct Traffic",
  "Organic Search",
  "Webinar",
  "Camp",

  // Communication
  "Inbound Email",
  "Inbound Phone call",
  "Outbound Phone call",
  "Inbound DA Call",

  // Paid ads
  "Pay per Click Ads",
  "Google Ads",
  "Meta Ads",
  "Uroots FB ads",

  // YouTube + creators
  "YOUTUBE",
  "YOUTUBE INTERNATIONAL",
  "Sahil Ayyan Channel",
  "Shahid Youtuber",
  "Junaid Youtuber",
  "Mohit Youtuber Pune",

  // Owned digital
  "QHT_Website",
  "Qhtclinic.com - Contactus",
  "Shopify Integration",
  "Unofficial Whatsapp",

  // Brand / line of business
  "URoots",
  "Medicine",
  "HT Done Support",
];

// Sub-sources — populate as the team confirms the canonical list. Until
// then the UI falls back entirely to LSQ master-data.
export const LSQ_DEFAULT_SUB_SOURCES: string[] = [];

/** Merge defaults + LSQ master-data while preserving the operator-curated
 *  order on the defaults (master-only extras get appended at the end). */
export function mergeWithDefaults(defaults: string[], fromLsq: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of defaults) {
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  for (const s of fromLsq) {
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
