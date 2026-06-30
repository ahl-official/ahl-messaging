// Phone-number display helpers.
//
// WhatsApp wa_ids are stored as bare E.164 digits (no `+`, no country
// code separator) — e.g. "919520883331". Everywhere we show a number to
// an operator it should read as `+<country code>-<national number>`,
// e.g. "+91-9520883331". These helpers split the country code off using
// the real calling-code list and format consistently.

// Every real calling code (1-3 digits), inlined as a static list so the
// 7.7MB country-state-city dataset never enters the always-loaded inbox
// bundle (phone.ts is imported widely — ChatWindow, lib/types, etc.).
// Generated once from that lib's Country.getAllCountries() phonecodes
// (leading code only); these codes don't change at runtime. splitPhone
// only ever tests 1-3 digit prefixes, so the few longer entries here are
// harmless dead weight kept for an exact match to the old behaviour.
const CALLING_CODES: Set<string> = new Set([
  "0", "1", "7", "20", "27", "30", "31", "32", "33", "34", "35", "36", "39",
  "40", "41", "43", "44", "45", "46", "47", "48", "49", "51", "52", "53", "54",
  "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82",
  "84", "86", "90", "91", "92", "93", "94", "95", "98", "211", "212", "213",
  "216", "218", "220", "221", "222", "223", "224", "225", "226", "227", "228",
  "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239",
  "240", "241", "242", "243", "244", "245", "246", "248", "249", "250", "251",
  "252", "253", "254", "255", "256", "257", "258", "260", "261", "262", "263",
  "264", "265", "266", "267", "268", "269", "290", "291", "297", "298", "299",
  "350", "351", "352", "353", "354", "355", "356", "357", "358", "359", "370",
  "371", "372", "373", "374", "375", "376", "377", "378", "379", "380", "381",
  "382", "383", "385", "386", "387", "389", "420", "421", "423", "441", "500",
  "501", "502", "503", "504", "505", "506", "507", "508", "509", "590", "591",
  "592", "593", "594", "595", "596", "597", "598", "599", "670", "672", "673",
  "674", "675", "676", "677", "678", "679", "680", "681", "682", "683", "685",
  "686", "687", "688", "689", "690", "691", "692", "850", "852", "853", "855",
  "856", "870", "880", "886", "960", "961", "962", "963", "964", "965", "966",
  "967", "968", "970", "971", "972", "973", "974", "975", "976", "977", "992",
  "993", "994", "995", "996", "998", "17871", "18091",
]);

/** Split a raw number into { country code, national number }. Returns an
 *  empty `cc` when no calling code can be confidently identified. */
export function splitPhone(raw: string | null | undefined): {
  cc: string;
  national: string;
} {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return { cc: "", national: "" };
  // Longest valid prefix wins; keep at least 4 national digits.
  for (let len = Math.min(3, digits.length - 4); len >= 1; len--) {
    const cc = digits.slice(0, len);
    if (CALLING_CODES.has(cc)) return { cc, national: digits.slice(len) };
  }
  return { cc: "", national: digits };
}

/** "+91-9520883331" — country code, dash, national number. */
export function formatPhone(raw: string | null | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";
  const { cc, national } = splitPhone(digits);
  return cc ? `+${cc}-${national}` : `+${digits}`;
}

/** Masked variant — keeps the country code + last 2 digits visible. */
export function formatPhoneMasked(raw: string | null | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  const { cc, national } = splitPhone(digits);
  const body = national || digits;
  const masked = "•".repeat(Math.max(4, body.length - 2)) + body.slice(-2);
  return cc ? `+${cc}-${masked}` : `+${masked}`;
}

/** Does this wa_id look like a real, dialable phone number, or is it
 *  a WhatsApp synthetic identifier (LID / privacy / business ID, etc.)
 *  we should NEVER push to LSQ as a "lead"?
 *
 *  Real phone numbers are 7-14 E.164 digits with a known country code.
 *  WhatsApp LIDs reliably show up as 15 digits with no real cc prefix
 *  — `splitPhone` returns cc="" for those. */
export function isWaIdLikelyReal(raw: string | null | undefined): boolean {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 14) return false;
  const { cc } = splitPhone(digits);
  return cc !== "";
}
