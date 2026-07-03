// Pincode → city/state resolver + phone-prefix → country mapping.
// Used by the LSQ pipeline to auto-fill location fields without
// asking the LLM (or the client) — pincode and country code already
// uniquely identify the geography.

export interface PincodeLookup {
  ok: boolean;
  city: string | null;
  state: string | null;
  country: string | null;
  error: string | null;
}

/**
 * Resolves a 6-digit Indian PIN code via the free india.gov-backed
 * postalpincode.in API. Returns the first matching post office's
 * district + state. ~50ms response on Indian PoPs, generous rate
 * limits, no auth required.
 *
 * Sample response shape (truncated):
 *   [{
 *     "Status": "Success",
 *     "PostOffice": [
 *       { "Name": "...", "District": "Mumbai", "State": "Uttarakhand",
 *         "Country": "India", ... },
 *       ...
 *     ]
 *   }]
 */
export async function lookupIndianPincode(pincode: string): Promise<PincodeLookup> {
  const digits = pincode.replace(/\D/g, "");
  if (!/^\d{6}$/.test(digits)) {
    return {
      ok: false,
      city: null,
      state: null,
      country: null,
      error: "pincode must be 6 digits",
    };
  }

  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${digits}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        ok: false,
        city: null,
        state: null,
        country: null,
        error: `pincode API HTTP ${res.status}`,
      };
    }
    const raw = (await res.json()) as Array<{
      Status?: string;
      PostOffice?: Array<{
        District?: string;
        Block?: string;
        State?: string;
        Country?: string;
      }>;
    }>;
    const entry = Array.isArray(raw) ? raw[0] : null;
    if (!entry || entry.Status !== "Success" || !entry.PostOffice?.length) {
      return {
        ok: false,
        city: null,
        state: null,
        country: null,
        error: "no post office found for pincode",
      };
    }
    const po = entry.PostOffice[0];
    return {
      ok: true,
      city: (po.District ?? po.Block ?? "").trim() || null,
      state: (po.State ?? "").trim() || null,
      country: (po.Country ?? "India").trim() || "India",
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      city: null,
      state: null,
      country: null,
      error: e instanceof Error ? e.message : "network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Phone calling-code → country name. Conservative, hand-curated list
// covering the regions QHT actually serves (India + the diaspora). Add
// more entries as needed; the longest-prefix lookup means 3-digit codes
// like 971 match before 2-digit ones like 97.
// ---------------------------------------------------------------------------

const CALLING_CODES: Record<string, string> = {
  "1":   "United States",          // also Canada — adjust per tenant
  "7":   "Russia",
  "20":  "Egypt",
  "27":  "South Africa",
  "30":  "Greece",
  "31":  "Netherlands",
  "32":  "Belgium",
  "33":  "France",
  "34":  "Spain",
  "36":  "Hungary",
  "39":  "Italy",
  "40":  "Romania",
  "41":  "Switzerland",
  "43":  "Austria",
  "44":  "United Kingdom",
  "45":  "Denmark",
  "46":  "Sweden",
  "47":  "Norway",
  "48":  "Poland",
  "49":  "Germany",
  "51":  "Peru",
  "52":  "Mexico",
  "54":  "Argentina",
  "55":  "Brazil",
  "56":  "Chile",
  "57":  "Colombia",
  "58":  "Venezuela",
  "60":  "Malaysia",
  "61":  "Australia",
  "62":  "Indonesia",
  "63":  "Philippines",
  "64":  "New Zealand",
  "65":  "Singapore",
  "66":  "Thailand",
  "81":  "Japan",
  "82":  "South Korea",
  "84":  "Vietnam",
  "86":  "China",
  "90":  "Turkey",
  "91":  "India",
  "92":  "Pakistan",
  "93":  "Afghanistan",
  "94":  "Sri Lanka",
  "95":  "Myanmar",
  "98":  "Iran",
  "212": "Morocco",
  "234": "Nigeria",
  "254": "Kenya",
  "255": "Tanzania",
  "256": "Uganda",
  "880": "Bangladesh",
  "960": "Maldives",
  "961": "Lebanon",
  "962": "Jordan",
  "964": "Iraq",
  "965": "Kuwait",
  "966": "Saudi Arabia",
  "967": "Yemen",
  "968": "Oman",
  "971": "United Arab Emirates",
  "972": "Israel",
  "973": "Bahrain",
  "974": "Qatar",
  "977": "Nepal",
  "994": "Azerbaijan",
};

export function countryFromCallingCode(waId: string): string | null {
  const digits = waId.replace(/\D/g, "");
  // Longest-prefix wins — 971 (UAE) before 97 (Tajikistan), etc.
  for (let len = 3; len >= 1; len--) {
    const prefix = digits.slice(0, len);
    const country = CALLING_CODES[prefix];
    if (country) return country;
  }
  return null;
}
