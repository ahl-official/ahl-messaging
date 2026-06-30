// GST computation + Indian-rupee number-to-words.
//
// Clinic books a round figure inclusive of tax (e.g. ₹3,000). Tally
// back-calculates the taxable value and splits the tax. We replicate
// that exactly so the app's invoice matches the Tally voucher to the
// paise:
//
//   taxable = round(inclusive / (1 + rate/100))
//   intra-state -> CGST = SGST = round(taxable * (rate/2)/100)
//   inter-state -> IGST = round(taxable * rate/100)
//   round_off   = inclusive - (taxable + taxes)   [usually 0]
//
// Supplier is American Hairline, Mumbai (state code 27). Place of
// supply 05 -> intra-state (CGST+SGST); anything else -> inter-state
// (IGST).

export const SUPPLIER_STATE_CODE = "05";

export function round2(n: number): number {
  // Avoid binary-float drift (e.g. 71.42850000001) before fixing to 2dp.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface GstBreakup {
  gstRate: number;
  interState: boolean;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
}

/** Splits a tax-inclusive grand total into taxable value + GST. */
export function computeGstInclusive(
  inclusiveTotal: number,
  gstRatePct: number,
  interState: boolean,
): GstBreakup {
  const taxableValue = round2(inclusiveTotal / (1 + gstRatePct / 100));

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (interState) {
    igst = round2((taxableValue * gstRatePct) / 100);
  } else {
    cgst = round2((taxableValue * (gstRatePct / 2)) / 100);
    sgst = cgst;
  }

  const computed = round2(taxableValue + cgst + sgst + igst);
  const roundOff = round2(inclusiveTotal - computed);

  return {
    gstRate: gstRatePct,
    interState,
    taxableValue,
    cgst,
    sgst,
    igst,
    roundOff,
    total: round2(inclusiveTotal),
  };
}

/** True when the place of supply is outside the supplier's state. */
export function isInterState(placeOfSupplyCode: string): boolean {
  return placeOfSupplyCode.trim() !== SUPPLIER_STATE_CODE;
}

// --------------------------------------------------------------------
// Number to words — Indian system (crore/lakh/thousand), Tally phrasing.
//   3000   -> "INR Three Thousand Only"
//   142.86 -> "INR One Hundred Forty Two and Eighty Six paise Only"
// No internal "and"; the only "and" separates rupees from paise.
// --------------------------------------------------------------------

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
  "Eighty", "Ninety",
];

function twoDigit(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? " " + ONES[o] : "");
}

function threeDigit(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(ONES[h] + " Hundred");
  if (r) parts.push(twoDigit(r));
  return parts.join(" ");
}

export function intToIndianWords(n: number): string {
  if (n === 0) return "Zero";
  let rest = Math.floor(n);
  const crore = Math.floor(rest / 10000000);
  rest %= 10000000;
  const lakh = Math.floor(rest / 100000);
  rest %= 100000;
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  const hundred = rest;

  const parts: string[] = [];
  if (crore) {
    parts.push((crore > 99 ? intToIndianWords(crore) : twoDigit(crore)) + " Crore");
  }
  if (lakh) parts.push(twoDigit(lakh) + " Lakh");
  if (thousand) parts.push(twoDigit(thousand) + " Thousand");
  if (hundred) parts.push(threeDigit(hundred));
  return parts.join(" ");
}

/** Tally-style rupee amount in words, e.g. "INR Three Thousand Only". */
export function rupeesInWords(amount: number): string {
  const totalPaise = Math.round(amount * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  const rupeeWords = intToIndianWords(rupees);
  if (paise === 0) return `INR ${rupeeWords} Only`;
  return `INR ${rupeeWords} and ${intToIndianWords(paise)} paise Only`;
}
