// Authoritative fallback lists for the LSQ campaign filter UI. Merged
// with whatever master-data the LSQ API returns — defaults render first
// (in operator-curated order), then any extra values the API surfaces
// get appended below. If LSQ is unreachable / rate-limited, the UI
// still has the full set to filter against.
//
// Maintained by the QHT operations team. Add / remove entries as the
// LSQ tenant evolves.

export const LSQ_DEFAULT_STAGES: string[] = [
  // Top-of-funnel
  "Prospect",
  "Engaged",
  "Pending First Contact",

  // Photo flow
  "Photo Awaited",
  "Photos Received",
  "Photo Approved",
  "Photo Disapproved",

  // Graft / consult
  "Graft Evaluation",
  "Graft Evaluation Awaited",
  "Graft Evaluation Completed",
  "Call Back",
  "Follow Up",
  "Package Shared",
  "Consultation",
  "Consultation Done",
  "Follow up for Booking",
  "Booking Done",

  // Refunds
  "Refund Requested",
  "Refund Initiated",
  "Refund Rescued",
  "Refunded Done",

  // Buckets / branches
  "Lead Bucket",
  "Other Services",
  "Hyderabad leads",
  "DNP",

  // Surgery scheduling
  "Surgery Date Awaited",
  "Surgery Date Confirmed",
  "Surgery Date Aligned",
  "Surgery Date Postponed",
  "Not Eligible for HT",
  "Hairloss Treatment/Medication",
  "Backlog",
  "Planning for Second Session",

  // Post-surgery
  "Happy Patient",
  "HT Done",
  "HT Done/Medicine",
  "HT Care Follow Up",
  "HT Care & Medicine",

  // Medicine / Uroots flow
  "Follow_Up for Medicine",
  "Call Back for Medicine",
  "Interested To Buy for Medicine",
  "Consultation for Medicine",
  "DNP_Medicine",
  "Medicine Suggested",
  "Order Confirmed",
  "Order Received",
  "Order Placed",
  "Order Confirmed by Bot",
  "Order Conformed by WA Bot",
  "Order Discussion",
  "Order Fulfillment",
  "Repeated Order",
  "Abandoned Cart",

  // Drop reasons / cold states
  "Location Constraint",
  "Pricing Concern",
  "Invalid Number",
  "Not Enquired",
  "Hung Up",
  "Call Back Time",
  "Future Follow Up",
  "Wrong Number",
  "Language barrier",
  "L1 Fall Out",
  "Interested in HT",
  "Surgery Discussion",
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
