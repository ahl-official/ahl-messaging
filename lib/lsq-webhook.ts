// LeadSquared → dashboard webhook plumbing. Server-only.
//
// LSQ pushes lead/activity updates to a static URL that carries a secret
// in its path (`/api/lsq/webhook/<secret>`). The handler parses whatever
// shape LSQ sends, pulls out the lead's stage / owner / number, and
// mirrors it onto the matching `contacts` row(s) — so the inbox stage
// chip + filter strip stay correct without anyone opening the chat.
//
// All state lives in `app_settings` (key/value) — no dedicated table.

import { randomBytes } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAppSetting, setAppSetting } from "@/lib/app-settings";

// The whole webhook list lives in ONE app_settings row as JSON. LSQ
// fires a separate webhook per event type (Stage Change, Ownership
// Change, …), so the operator creates one named endpoint per event —
// each with its own secret/URL and its own event counter.
const LSQ_WEBHOOKS_KEY = "lsq_webhooks";
export const LSQ_WEBHOOK_LAST_PAYLOAD_KEY = "lsq_webhook_last_payload";

// Legacy single-webhook keys — migrated into the list on first read so
// a URL already pasted into LSQ keeps working.
const LEGACY_SECRET_KEY = "lsq_webhook_secret";
const LEGACY_LAST_RECEIVED_KEY = "lsq_webhook_last_received_at";
const LEGACY_EVENT_COUNT_KEY = "lsq_webhook_event_count";

export interface LsqWebhookEntry {
  id: string;
  name: string;
  secret: string;
  created_at: string;
  last_received_at: string | null;
  event_count: number;
  /** This webhook's OWN last payload (truncated) + when. The global
   *  lsq_webhook_last_payload is shared across all webhooks and gets
   *  overwritten on every hit, so we keep a per-webhook copy too. */
  last_payload?: string | null;
  last_payload_at?: string | null;
}

async function saveWebhooks(list: LsqWebhookEntry[]): Promise<void> {
  await setAppSetting(LSQ_WEBHOOKS_KEY, JSON.stringify(list));
}

/** All configured webhooks. Migrates a pre-existing single webhook into
 *  the list the first time it runs. */
export async function listLsqWebhooks(): Promise<LsqWebhookEntry[]> {
  const raw = await getAppSetting(LSQ_WEBHOOKS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LsqWebhookEntry[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to migration / empty */
    }
  }
  // Migrate the legacy single secret, if any.
  const legacy = (await getAppSetting(LEGACY_SECRET_KEY))?.trim();
  if (legacy) {
    const [recv, count] = await Promise.all([
      getAppSetting(LEGACY_LAST_RECEIVED_KEY),
      getAppSetting(LEGACY_EVENT_COUNT_KEY),
    ]);
    const migrated: LsqWebhookEntry[] = [
      {
        id: randomBytes(5).toString("hex"),
        name: "Default",
        secret: legacy,
        created_at: new Date().toISOString(),
        last_received_at: recv?.trim() || null,
        event_count: Number.parseInt(count ?? "0", 10) || 0,
      },
    ];
    await saveWebhooks(migrated);
    return migrated;
  }
  return [];
}

/** Create a new named webhook with a fresh secret. */
export async function addLsqWebhook(name: string): Promise<LsqWebhookEntry> {
  const list = await listLsqWebhooks();
  const entry: LsqWebhookEntry = {
    id: randomBytes(5).toString("hex"),
    name: name.trim() || "Webhook",
    secret: randomBytes(24).toString("hex"), // 48 hex chars
    created_at: new Date().toISOString(),
    last_received_at: null,
    event_count: 0,
  };
  await saveWebhooks([...list, entry]);
  return entry;
}

/** Remove a webhook by id. Its URL stops working immediately. */
export async function deleteLsqWebhook(id: string): Promise<void> {
  const list = await listLsqWebhooks();
  await saveWebhooks(list.filter((w) => w.id !== id));
}

export async function findLsqWebhookBySecret(
  secret: string,
): Promise<LsqWebhookEntry | null> {
  const list = await listLsqWebhooks();
  return list.find((w) => w.secret === secret) ?? null;
}

/** Stamp that an event landed on a given webhook — drives the
 *  "Connected" badge + per-webhook event count. Best-effort
 *  read-modify-write; a lost increment under a race is acceptable. */
export async function recordLsqWebhookHit(
  secret: string,
  rawBody: string,
): Promise<void> {
  const list = await listLsqWebhooks();
  const hit = list.find((w) => w.secret === secret);
  if (hit) {
    const now = new Date().toISOString();
    hit.last_received_at = now;
    hit.event_count += 1;
    // Per-webhook copy of the payload so each endpoint's last event can be
    // inspected independently (the global key below is overwritten by ANY hit).
    hit.last_payload = rawBody.slice(0, 6000);
    hit.last_payload_at = now;
    await saveWebhooks(list);
  }
  // Keep the latest payload (truncated) so we can eyeball the real LSQ
  // shape and tighten the parser if a field is being missed.
  await setAppSetting(LSQ_WEBHOOK_LAST_PAYLOAD_KEY, rawBody.slice(0, 6000));

  // Log the FULL payload to the event table (ring-buffered) so form
  // submissions can be inspected later. Best-effort — never breaks the hit.
  await logWebhookEventToDb(hit ?? null, rawBody).catch(() => {});
}

const EVENTS_KEEP_PER_HOOK = 50;

/** Append the full payload to lsq_webhook_events and trim that webhook's rows
 *  to the most recent EVENTS_KEEP_PER_HOOK. Swallows all errors (e.g. the
 *  table not existing yet pre-migration) so the webhook keeps working. */
async function logWebhookEventToDb(
  hook: LsqWebhookEntry | null,
  rawBody: string,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = { _raw: rawBody.slice(0, 20000) };
  }
  // Change events arrive as { Before, After }; others are flat. Prefer After.
  const obj = (payload ?? {}) as Record<string, unknown>;
  const after = (obj.After as Record<string, unknown> | undefined) ?? obj;
  const str = (v: unknown) => (v == null ? null : String(v).trim() || null);

  const admin = createServiceRoleClient();
  const { error } = await admin.from("lsq_webhook_events").insert({
    webhook_id: hook?.id ?? null,
    webhook_name: hook?.name ?? null,
    received_at: new Date().toISOString(),
    notable_event: str(after.NotableEvent ?? obj.NotableEvent),
    activity: str(after.ProspectActivityName_Max ?? obj.ProspectActivityName_Max),
    prospect_id: str(after.ProspectID ?? obj.ProspectID),
    prospect_auto_id: str(after.ProspectAutoId ?? obj.ProspectAutoId),
    phone: str(after.Phone ?? after.Mobile ?? obj.Phone),
    stage: str(after.ProspectStage ?? obj.ProspectStage),
    source: str(after.Source ?? obj.Source),
    payload,
  });
  if (error || !hook?.id) return;

  // Ring-buffer: drop this webhook's rows beyond the newest N.
  const { data: old } = await admin
    .from("lsq_webhook_events")
    .select("id")
    .eq("webhook_id", hook.id)
    .order("received_at", { ascending: false })
    .range(EVENTS_KEEP_PER_HOOK, EVENTS_KEEP_PER_HOOK + 500);
  if (old && old.length > 0) {
    await admin.from("lsq_webhook_events").delete().in("id", old.map((o) => o.id as string));
  }
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

export interface ParsedLsqLead {
  mobile: string | null;       // digits only
  prospect_id: string | null;
  stage: string | null;
  lead_number: string | null;
  owner_name: string | null;
  owner_email: string | null;
  first_name: string | null;
  source: string | null;       // LSQ Source (drives drip source-filter)
  sub_source: string | null;   // LSQ Sub source
  /** Every flattened leaf from the push, keyed by lowercased field name.
   *  Lets the drip engine match on ANY LSQ field (mx_Brand, mx_NDR_Reason…). */
  fields: Record<string, string>;
}

/** Flatten any nested object/array into a `lastKeyLowercased -> value`
 *  map of primitive leaves. Lets us field-match LSQ payloads without
 *  knowing the exact envelope shape upfront. Later keys win. */
function flattenLeaves(input: unknown, out: Map<string, string>): void {
  if (input == null) return;
  if (Array.isArray(input)) {
    for (const item of input) flattenLeaves(item, out);
    return;
  }
  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v != null && typeof v === "object") {
        flattenLeaves(v, out);
      } else if (v != null && (typeof v === "string" || typeof v === "number")) {
        const key = k.trim().toLowerCase();
        const val = String(v).trim();
        if (val.length > 0) out.set(key, val);
      }
    }
  }
}

/** LSQ "field" payloads sometimes arrive as [{Attribute, Value}, ...]
 *  instead of {Attribute: Value}. Normalise that pattern too. */
function flattenAttributePairs(input: unknown, out: Map<string, string>): void {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (item == null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const attr = rec.Attribute ?? rec.attribute ?? rec.SchemaName ?? rec.Key;
    const value = rec.Value ?? rec.value;
    if (typeof attr === "string" && (typeof value === "string" || typeof value === "number")) {
      const v = String(value).trim();
      if (v.length > 0) out.set(attr.trim().toLowerCase(), v);
    }
  }
}

function firstMatch(map: Map<string, string>, candidates: string[]): string | null {
  for (const c of candidates) {
    const v = map.get(c);
    if (v && v.length > 0) return v;
  }
  return null;
}

/** Best-effort extraction of the lead fields we mirror. Defensive — LSQ
 *  webhook bodies vary by how the automation/connector is configured. */
export function parseLsqWebhookPayload(payload: unknown): ParsedLsqLead {
  const map = new Map<string, string>();
  flattenLeaves(payload, map);
  // If the body has a `Fields` / `LeadFields` array of {Attribute,Value},
  // overlay those too (they're authoritative when present).
  if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    flattenAttributePairs(rec.Fields ?? rec.fields, map);
    flattenAttributePairs(rec.LeadFields ?? rec.leadfields, map);
    flattenAttributePairs(rec.LeadPropertyList ?? rec.leadpropertylist, map);
    // Stage-change automations send a {Before, After} envelope. Flatten After
    // LAST so the NEW stage / current values win regardless of key order.
    flattenLeaves(rec.After ?? rec.after, map);
  }

  const rawMobile = firstMatch(map, [
    "phone",
    "mobile",
    "mobilenumber",
    "phonenumber",
    "mx_phone",
    "primaryphone",
    "leadmobile",
  ]);
  const mobile = rawMobile ? rawMobile.replace(/[^\d]/g, "") : null;

  return {
    mobile: mobile && mobile.length >= 7 ? mobile : null,
    prospect_id: firstMatch(map, ["prospectid", "leadid", "prospect_id", "id"]),
    stage: firstMatch(map, [
      "prospectstage",
      "stage",
      "leadstage",
      "currentstage",
      "status",
      "leadstatus",
    ]),
    lead_number: firstMatch(map, [
      "prospectautoid",
      "leadnumber",
      "autoid",
      "lead_number",
    ]),
    owner_name: firstMatch(map, [
      "owneridname",
      "ownername",
      "leadowner",
      "owner",
    ]),
    owner_email: firstMatch(map, [
      "owneridemailaddress",
      "owneremail",
      "leadowneremailaddress",
    ]),
    first_name: firstMatch(map, [
      "firstname",
      "first name",
      "first_name",
      "mx_first_name",
    ]),
    source: firstMatch(map, [
      "source",
      "mx_source",
      "prospectsource",
      "leadsource",
      "mx_lead_source",
      "leadorigin",
      "origin",
    ]),
    sub_source: firstMatch(map, [
      "subsource",
      "sub_source",
      "mx_sub_source",
      "mx_subsource",
      "prospectsubsource",
      "leadsubsource",
    ]),
    fields: Object.fromEntries(map),
  };
}

// ---------------------------------------------------------------------------
// Apply to contacts
// ---------------------------------------------------------------------------

/** Mirror a parsed lead onto every matching contact row. Matches on
 *  `lsq_prospect_id` first, then falls back to the last-10-digits of the
 *  mobile (so siblings of the same customer across business numbers all
 *  stay in sync). Returns how many rows were updated. */
export async function applyLsqLeadToContacts(
  lead: ParsedLsqLead,
): Promise<number> {
  if (!lead.stage && !lead.prospect_id && !lead.owner_name && !lead.first_name) {
    return 0;
  }
  const admin = createServiceRoleClient();

  // Build the contact set to update — id + current name.
  const byId = new Map<string, { name: string | null }>();
  if (lead.prospect_id) {
    const { data } = await admin
      .from("contacts")
      .select("id, name")
      .eq("lsq_prospect_id", lead.prospect_id);
    for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
      byId.set(r.id, { name: r.name });
    }
  }
  if (lead.mobile) {
    // wa_id is digits-only with country code; LSQ mobile may or may not
    // carry it. Match on the trailing 10 digits — the national part.
    const last10 = lead.mobile.slice(-10);
    const { data } = await admin
      .from("contacts")
      .select("id, name")
      .ilike("wa_id", `%${last10}`);
    for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
      byId.set(r.id, { name: r.name });
    }
  }
  if (byId.size === 0) return 0;
  const allIds = Array.from(byId.keys());

  const patch: Record<string, unknown> = {
    lsq_synced_at: new Date().toISOString(),
  };
  if (lead.stage) patch.lsq_stage = lead.stage;
  if (lead.lead_number) patch.lsq_lead_number = lead.lead_number;
  if (lead.owner_name) patch.lsq_owner_name = lead.owner_name;
  // Normalised so the assigned-only inbox filter matches the agent's email.
  if (lead.owner_email) patch.lsq_owner_email = lead.owner_email.trim().toLowerCase();
  if (lead.prospect_id) patch.lsq_prospect_id = lead.prospect_id;
  if (lead.source) patch.lsq_source = lead.source;
  if (lead.sub_source) patch.lsq_sub_source = lead.sub_source;
  // Conversion values — captured from the push if it carries them (LSQ
  // automation can be configured to send these custom fields). Missing ones
  // are backfilled by the conversions endpoint on demand.
  const toNum = (v: string | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v.toString().replace(/[^\d.-]/g, ""));
    return isNaN(n) ? null : n;
  };
  const f = lead.fields ?? {};
  const pkg = toNum(f["mx_total_package"]) ?? toNum(f["mx_booking_amount"]);
  const ord = toNum(f["revenue"]) ?? toNum(f["mx_total_order"]);
  const booking = toNum(f["mx_booking_amount"]);
  const bookingDate = f["mx_booking_date"] || f["booking_date"] || f["mx_booking__date"] || null;
  if (pkg !== null) patch.lsq_total_package = pkg;
  if (ord !== null) patch.lsq_order_value = ord;
  if (booking !== null) patch.lsq_booking_amount = booking;
  if (bookingDate) patch.lsq_booking_date = bookingDate;
  if (f["mx_sales_notes"]) patch.lsq_sales_notes = f["mx_sales_notes"];

  const { error } = await admin.from("contacts").update(patch).in("id", allIds);
  if (error) return 0;

  // Fill a blank contact name from the lead — never overwrite a name
  // the contact already has.
  const lsqName = (lead.first_name ?? "").trim();
  if (lsqName) {
    const nameless = allIds.filter(
      (id) => !(byId.get(id)?.name ?? "").trim(),
    );
    if (nameless.length > 0) {
      await admin.from("contacts").update({ name: lsqName }).in("id", nameless);
    }
  }
  return byId.size;
}
