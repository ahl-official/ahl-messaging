// CRM field value suggestions — learned from incoming leads.
//
// Some lead fields (Sub source, City, Source Medium) have NO master dropdown
// list in LSQ on this tenant (they're cascading or free-text, and every
// GetDropdownValues endpoint 404s). So instead of a master list we LEARN the
// distinct values that actually arrive on leads via the webhook, and offer
// those as suggestions in the drip builder's value picker.
//
// Stored as one app_settings JSON row: { "<lowercased schema>": ["v1","v2"] }.

import { getAppSetting, setAppSetting } from "@/lib/app-settings";

const KEY = "lsq_field_seen_values";
const PER_FIELD_CAP = 100;

// Schemas we track (lowercased) — the drip filter fields.
const TRACK = new Set([
  "mx_brand",
  "mx_utm_source",
  "mx_ndr_reason",
  "sourcemedium",
  "mx_lead_city",
  "mx_lead_state",
  "source",
]);

type SeenMap = Record<string, string[]>;

async function load(): Promise<SeenMap> {
  const raw = await getAppSetting(KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as SeenMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Record any tracked field values present on a lead. Best-effort. */
export async function recordSeenFieldValues(fields: Record<string, string>): Promise<void> {
  try {
    let changed = false;
    const seen = await load();
    for (const [k, v] of Object.entries(fields)) {
      const key = k.toLowerCase();
      if (!TRACK.has(key)) continue;
      const val = (v ?? "").trim();
      if (!val) continue;
      const list = seen[key] ?? [];
      if (list.some((x) => x.toLowerCase() === val.toLowerCase())) continue;
      list.push(val);
      // Keep the most-recent CAP values.
      seen[key] = list.slice(-PER_FIELD_CAP);
      changed = true;
    }
    if (changed) await setAppSetting(KEY, JSON.stringify(seen));
  } catch {
    /* suggestions are non-critical */
  }
}

/** All learned values, keyed by lowercased schema. */
export async function getSeenFieldValues(): Promise<SeenMap> {
  return load();
}
