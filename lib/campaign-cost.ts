// Rough WhatsApp send-cost estimate, by template category. Meta's 2025
// per-message pricing for India (INR). These are list-price approximations
// — actual billing varies by volume tier / free-entry-point conversations,
// so the campaign UI labels it "est." Update here when Meta revises rates.
export const WA_MSG_RATE_INR: Record<string, number> = {
  MARKETING: 0.78,
  UTILITY: 0.12,
  AUTHENTICATION: 0.12,
  SERVICE: 0, // user-initiated service replies are free
};

export const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: "Marketing",
  UTILITY: "Utility",
  AUTHENTICATION: "Authentication",
  SERVICE: "Service",
};

/** Per-message rate for a category (falls back to Marketing — the costliest
 *  — so an unknown category never under-estimates). */
export function rateForCategory(category: string | null | undefined): number {
  const key = (category ?? "MARKETING").toUpperCase();
  return WA_MSG_RATE_INR[key] ?? WA_MSG_RATE_INR.MARKETING;
}

/** Estimated campaign cost = per-message rate × messages sent. */
export function estimateCampaignCostInr(
  category: string | null | undefined,
  sent: number,
): number {
  return rateForCategory(category) * Math.max(0, sent);
}
