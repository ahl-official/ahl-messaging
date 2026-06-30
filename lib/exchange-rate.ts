// Single source of truth for the USD → INR rate displayed across the
// dashboard (OpenAI usage panel, hero cost chip, reports, etc).
//
// We don't fetch a live FX feed — OpenAI bills in USD and the operator
// only needs a ballpark INR figure so they know roughly what they're
// spending in local currency. Update the constant when the rate drifts
// noticeably (typically every few months).
//
// Override at runtime by setting NEXT_PUBLIC_USD_INR (e.g. "96.5")
// without redeploying server code.

const DEFAULT_USD_INR = 96;

function parseEnvRate(): number {
  const raw = process.env.NEXT_PUBLIC_USD_INR;
  if (!raw) return DEFAULT_USD_INR;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_INR;
}

export const USD_TO_INR: number = parseEnvRate();

/** Round to ₹0.01 — money display. */
export function usdToInr(usd: number): number {
  return Math.round(usd * USD_TO_INR * 100) / 100;
}

/** Pretty-format an INR amount: "₹11.24" for small, "₹1,234" for big. */
export function formatInr(usd: number): string {
  const inr = usdToInr(usd);
  if (inr === 0) return "₹0";
  if (inr < 100) return `₹${inr.toFixed(2)}`;
  return `₹${Math.round(inr).toLocaleString("en-IN")}`;
}
