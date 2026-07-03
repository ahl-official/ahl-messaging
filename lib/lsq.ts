// CRM (LSQ) CRM integration. Server-only — never import from
// a client component (would leak the secret key into the bundle).
//
// CRM authenticates every request with two query params:
//   ?accessKey=<LSQ_ACCESS_KEY>&secretKey=<LSQ_SECRET_KEY>
// The host varies by region — Indian tenants are usually
// `https://api-in21.leadsquared.com` (or similar) — set LSQ_HOST in
// .env.local to match what's shown under your LSQ Settings → API
// Access Credentials page.

export interface LsqConfig {
  host: string;
  accessKey: string;
  secretKey: string;
  /** True when all three required env vars are present. */
  configured: boolean;
  /** Human label for this CRM ("Khar West/Mumbai", "Mumbai/Khar West").
   *  Shown in the contact panel so an operator knows which CRM a lead
   *  came from. */
  label: string;
}

/** Decodes an env value that may have `%24` placeholders for `$`.
 *  Next.js' @next/env runs dotenv-expand which mangles values containing
 *  a literal `$` (it expands `$foo` as a variable reference even inside
 *  quotes), so the .env.local convention is to paste any `$` as `%24`
 *  and decode here. Safe for values that don't contain `%XX` either —
 *  decodeURIComponent is a no-op on plain ASCII without escape codes. */
function decodeEnv(raw: string): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed escape (rare). Fall back to the raw value rather than
    // crashing; the user will see an "Invalid User Details!" from LSQ
    // and can fix the env file.
    return raw;
  }
}

export function getLsqConfig(): LsqConfig {
  const host = (process.env.LSQ_HOST || "").replace(/\/$/, "").trim();
  const accessKey = decodeEnv((process.env.LSQ_ACCESS_KEY || "").trim());
  const secretKey = decodeEnv((process.env.LSQ_SECRET_KEY || "").trim());
  return {
    host,
    accessKey,
    secretKey,
    configured: !!(host && accessKey && secretKey),
    label: (process.env.LSQ_LABEL || "Mumbai/Khar West").trim(),
  };
}

/** Secondary (read-only) CRM account — separate env vars so a
 *  tenant running two LSQ CRMs (e.g. Delhi/Haridwar + Hyderabad/Gurgaon)
 *  can surface both leads in the contact panel. Only used for lead
 *  lookups; no writes / webhook / backfill go to this account. */
export function getLsqConfig2(): LsqConfig {
  const host = (process.env.LSQ2_HOST || "").replace(/\/$/, "").trim();
  const accessKey = decodeEnv((process.env.LSQ2_ACCESS_KEY || "").trim());
  const secretKey = decodeEnv((process.env.LSQ2_SECRET_KEY || "").trim());
  return {
    host,
    accessKey,
    secretKey,
    configured: !!(host && accessKey && secretKey),
    label: (process.env.LSQ2_LABEL || "Mumbai/Khar West").trim(),
  };
}

/** Public-safe view (no secrets). UI uses this to render "configured /
 *  missing" status without ever receiving the keys themselves. */
export interface LsqStatusPublic {
  host_set: boolean;
  access_key_set: boolean;
  secret_key_set: boolean;
  host_value: string;          // host URL is not secret — safe to display
  configured: boolean;
}

export function getLsqStatusPublic(): LsqStatusPublic {
  const cfg = getLsqConfig();
  return {
    host_set: !!cfg.host,
    access_key_set: !!cfg.accessKey,
    secret_key_set: !!cfg.secretKey,
    host_value: cfg.host,
    configured: cfg.configured,
  };
}

// ---------------------------------------------------------------------------
// Thin fetch wrapper. Every endpoint takes accessKey + secretKey as query
// params, so we centralise the URL build + auth here. The actual lead
// CRUD helpers can layer on top of this in subsequent phases.
// ---------------------------------------------------------------------------
export interface LsqRequestOptions {
  method?: "GET" | "POST";
  /** Path, e.g. "/v2/LeadManagement.svc/Lead.Capture". Leading slash optional. */
  path: string;
  /** Extra query params (besides the auth pair). */
  query?: Record<string, string>;
  /** JSON body for POST. */
  body?: unknown;
  /** Per-call abort timeout. Default 15s. */
  timeoutMs?: number;
  /** Internal — retry counter for rate-limit recovery. Do not set. */
  __retry?: number;
}

export interface LsqResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

// LSQ caps every account at 10 calls per 5 seconds; the 11th call comes
// back as 403 "API calls exceeded the limit of 10 in 5 second(s)". Two
// guards below:
//   1. In-process throttle — never let more than 8 in-flight calls
//      complete within any rolling 5s window (leaves buffer for retries
//      racing against our own webhook calls).
//   2. Auto-retry once on rate-limit — wait the suggested interval and
//      retry. If still 403 after that, surface the original error so the
//      operator can see it in the sync banner.
const RATE_WINDOW_MS = 5_000;
const RATE_LIMIT_PER_WINDOW = 8;
const rateTimestamps: number[] = [];

async function waitForRateSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    // Drop timestamps outside the 5s window
    while (rateTimestamps.length > 0 && now - rateTimestamps[0] > RATE_WINDOW_MS) {
      rateTimestamps.shift();
    }
    if (rateTimestamps.length < RATE_LIMIT_PER_WINDOW) {
      rateTimestamps.push(now);
      return;
    }
    // Sleep until the oldest call ages out of the window.
    const wait = RATE_WINDOW_MS - (now - rateTimestamps[0]) + 50;
    await new Promise((r) => setTimeout(r, wait));
  }
}

function isRateLimitError(status: number, errMsg: string | null): boolean {
  if (status === 429) return true;
  if (status === 403 && /exceeded the limit|rate.?limit|too many/i.test(errMsg ?? "")) {
    return true;
  }
  return false;
}

export async function lsqFetch<T = unknown>(
  opts: LsqRequestOptions,
  cfg: LsqConfig = getLsqConfig(),
): Promise<LsqResponse<T>> {
  if (!cfg.configured) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: "CRM not configured. Set LSQ_HOST + LSQ_ACCESS_KEY + LSQ_SECRET_KEY in .env.local.",
    };
  }

  await waitForRateSlot();
  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  // Auth via custom headers (`x-LSQ-AccessKey` / `x-LSQ-SecretKey`) —
  // matches the working n8n template on this tenant. We previously sent
  // creds as `?accessKey=…&secretKey=…` query params; that worked for
  // *some* endpoints but the tenant silently dropped Lead.CreateOrUpdate
  // payloads (no error, no lead created) when access keys contained a
  // literal `$`. Header-based auth sidesteps the URL-encoding tarpit
  // entirely.
  const queryPairs: string[] = [];
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    queryPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const url = queryPairs.length
    ? `${cfg.host}${path}?${queryPairs.join("&")}`
    : `${cfg.host}${path}`;

  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "x-LSQ-AccessKey": cfg.accessKey,
        "x-LSQ-SecretKey": cfg.secretKey,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      cache: "no-store",
    });
    const raw = await res.text();
    let parsed: T | null = null;
    try {
      parsed = raw ? (JSON.parse(raw) as T) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const errMsg =
        (parsed && typeof parsed === "object" && parsed !== null && "ExceptionMessage" in parsed
          ? String((parsed as { ExceptionMessage?: unknown }).ExceptionMessage)
          : null) || `HTTP ${res.status} ${res.statusText}`;

      // Rate-limit recovery — wait the full 5s window + a 200ms buffer
      // then retry once. Throttle already prevents most bursts, but a
      // surge across multiple processes can still trip LSQ's server-side
      // counter. Cap retries via __retry so we never loop forever.
      const tries = ((opts as LsqRequestOptions & { __retry?: number }).__retry ?? 0) + 1;
      if (isRateLimitError(res.status, errMsg) && tries <= 2) {
        console.warn(
          `[lsq] rate-limited on ${opts.path} (try ${tries}) — waiting ${RATE_WINDOW_MS + 200}ms`,
        );
        await new Promise((r) => setTimeout(r, RATE_WINDOW_MS + 200));
        return lsqFetch<T>({ ...opts, __retry: tries } as LsqRequestOptions, cfg);
      }

      return { ok: false, status: res.status, data: parsed, error: errMsg };
    }
    return { ok: true, status: res.status, data: parsed, error: null };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}

// Tiny ping helper — calls a lightweight endpoint to verify creds.
// LSQ doesn't have a `/health` route; we use a no-op lead lookup
// with an obviously-invalid phone which returns 200 + empty array on
// valid creds, 401/403 on bad creds.
export async function lsqPing(): Promise<LsqResponse> {
  return lsqFetch({
    method: "GET",
    path: "/v2/LeadManagement.svc/RetrieveLeadByPhoneNumber",
    query: { phone: "00-0000000000" },
  });
}

// ---------------------------------------------------------------------------
// Lead lookup by mobile number. CRM leads are usually stored with a
// "+91…" prefix; our wa_id is "91…" (no + or zero). We try a couple of
// common shapes so the UI doesn't miss matches.
// ---------------------------------------------------------------------------

/** Subset of CRM lead fields the dashboard surfaces. There are 100+
 *  fields on a real LSQ record — we pick the human-relevant ones for
 *  the contact-details panel. ProspectAutoId comes back as a string
 *  (not a number) from this endpoint despite the name. */
export interface LsqLead {
  ProspectID: string;
  ProspectAutoId: string | number | null;
  FirstName: string | null;
  LastName: string | null;
  EmailAddress: string | null;
  Phone: string | null;
  Mobile: string | null;
  DOB: string | null;
  /** Client/lead age — appears in `mx_Age` / `Age` fields depending on
   *  tenant config. Both common shapes are tried client-side. */
  Age: string | null;
  mx_Age: string | null;
  /** Some QHT tenants store age under "Client Age" custom column. */
  mx_Patient_Age: string | null;
  /** Standard LSQ `City` — many tenants leave this empty and write to
   *  custom field `mx_Lead_City` instead (matches what the field-
   *  extraction pipeline writes for QHT). Same story for State. */
  City: string | null;
  mx_Lead_City: string | null;
  State: string | null;
  mx_Lead_State: string | null;
  /** Standard LSQ `Country` field. Some tenants store country in a
   *  custom field (`mx_Country` / `mx_country_name`) instead — try
   *  the standard one first, fall back to the custom variants. */
  Country: string | null;
  mx_Country: string | null;
  mx_country_name: string | null;
  /** Tenant also stamps the country dial code on the lead — useful
   *  fallback for displaying "Country" when only the code is set. */
  mx_Country_Code: string | null;
  /** LSQ returns timestamps as `"2026-04-24 06:55:17.000"` — space
   *  separator, no timezone. Date.parse() handles this on most engines. */
  CreatedOn: string | null;
  LeadConversionDate: string | null;
  LeadLastModifiedOn: string | null;
  ModifiedOn: string | null;
  /** Lead status is `ProspectStage` in LSQ, not `Status`. */
  ProspectStage: string | null;
  Source: string | null;
  /** Channel/medium ("Whatsapp Meta Ads", "Instagram", …). */
  SourceMedium: string | null;
  /** Tenant custom-field that holds the sub-source ("Test WA URoots",
   *  "Sahil Unofficial 8476061347", etc.). Different tenants name
   *  this differently — `mx_utm_source` is the QHT convention. */
  mx_utm_source: string | null;
  mx_Sub_source: string | null;
  /** Owner display name lives in OwnerIdName when present, otherwise
   *  CreatedByName is the closest "who handles this lead" hint. */
  OwnerIdName: string | null;
  OwnerIdEmailAddress: string | null;
  OwnerId: string | null;
  CreatedByName: string | null;
  CreatedBy: string | null;
}

/** What we expose to the client — same fields, plus a derived display
 *  name and computed age (when DOB is set). All strings; dates left as
 *  ISO so the UI can format with the user's locale. */
export interface LsqLeadView {
  prospect_id: string;
  lead_number: string;            // ProspectAutoId formatted
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  age: number | null;
  dob: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  created_on: string | null;
  owner_name: string | null;
  owner_email: string | null;
  source: string | null;
  /** Channel/medium ("Whatsapp Meta Ads", "Instagram", …). */
  source_medium: string | null;
  /** Sub-source — read tolerantly from `mx_utm_source` first, then
   *  `mx_Sub_source`, so tenants using either field surface here. */
  sub_source: string | null;
  status: string | null;
  lead_url: string | null;        // deep link into LSQ UI when host is known
}

function buildCanonicalPhone(waId: string): string {
  // wa_id from Meta is digits only, e.g. "919045454045". LSQ stores in
  // the dashed `+91-9045454045` form (with leading `+`). This is the
  // *only* format we probe — every other variant returned 404/empty in
  // production logs and just burns through the 10-calls/5s rate limit.
  // If a tenant ever stores in a different shape, fix the data, not the
  // lookup.
  const digits = waId.replace(/\D/g, "");
  if (digits.length > 10) {
    const last10 = digits.slice(-10);
    const cc = digits.slice(0, digits.length - 10);
    return `+${cc}-${last10}`;
  }
  return digits;
}

function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const t = Date.parse(dob);
  if (Number.isNaN(t)) return null;
  const ageMs = Date.now() - t;
  const years = Math.floor(ageMs / (365.25 * 24 * 60 * 60 * 1000));
  if (years < 0 || years > 130) return null;
  return years;
}

function toView(lead: LsqLead, host: string): LsqLeadView {
  const fullName =
    [lead.FirstName, lead.LastName].filter(Boolean).join(" ").trim() || null;

  // LSQ deep link — strip `api-` from the API host to reach the
  // dashboard host (e.g. `api-in21.leadsquared.com` → `in21.leadsquared.com`).
  // The DIRECT lead URL goes to /LeadManagement/LeadDetails, but on a
  // fresh tab without an in21-subdomain session cookie LSQ kicks back
  // to identity.leadsquared.com for re-auth. The SEARCH URL drops the
  // operator on the LeadManagement landing page with the lead-number
  // pre-filtered — that path tends to honour an existing app-level
  // session better, so it's the operator's preferred "Visit" target.
  const dashboardHost = host ? host.replace("api-", "") : null;
  const leadUrl =
    dashboardHost && lead.ProspectID
      ? `${dashboardHost}/LeadManagement/LeadDetails?LeadID=${encodeURIComponent(lead.ProspectID)}`
      : null;

  // Age can live in three places depending on tenant config — try each.
  const ageRaw = lead.mx_Patient_Age ?? lead.mx_Age ?? lead.Age;
  const age =
    ageRaw && !Number.isNaN(Number(ageRaw))
      ? Number(ageRaw)
      : ageFromDob(lead.DOB);

  return {
    prospect_id: lead.ProspectID,
    lead_number:
      lead.ProspectAutoId != null && String(lead.ProspectAutoId).trim()
        ? String(lead.ProspectAutoId)
        : lead.ProspectID.slice(0, 8),
    full_name: fullName,
    first_name: lead.FirstName,
    last_name: lead.LastName,
    email: lead.EmailAddress,
    phone: lead.Phone || lead.Mobile,
    age,
    dob: lead.DOB,
    city: lead.City || lead.mx_Lead_City || null,
    state: lead.State || lead.mx_Lead_State || null,
    // Standard `Country` first, then tenant custom variants. Some QHT
    // tenants only populate `mx_Country` (because the standard field
    // rejects writes via Lead.CreateOrUpdate on those tenants), so the
    // panel needs to read from whichever one actually has the value.
    country:
      lead.Country ||
      lead.mx_Country ||
      lead.mx_country_name ||
      null,
    created_on: lead.CreatedOn,
    // Prefer the explicit lead-owner name; fall back to the user who
    // created the lead so the panel always shows *someone*.
    owner_name: lead.OwnerIdName || lead.CreatedByName,
    owner_email: lead.OwnerIdEmailAddress || null,
    source: lead.Source,
    source_medium: lead.SourceMedium || null,
    sub_source: lead.mx_utm_source || lead.mx_Sub_source || null,
    status: lead.ProspectStage,
    lead_url: leadUrl,
  };
}

export interface LsqLeadLookup {
  ok: boolean;
  found: boolean;
  lead: LsqLeadView | null;
  /** Raw error / status if the call didn't succeed. */
  error: string | null;
  /** Variant of the mobile that actually matched (debug aid). */
  matched_variant: string | null;
}

/** Single canonical lookup endpoint. `Leads.GetByMobileNumber` returns
 *  HTTP 404 on this tenant — only `RetrieveLeadByPhoneNumber` with the
 *  dashed `cc-last10` phone format works, and that's all we use. */
const LEAD_LOOKUP_PATH = "/v2/LeadManagement.svc/RetrieveLeadByPhoneNumber";

// ---------------------------------------------------------------------------
// Lead update — POST /v2/LeadManagement.svc/Lead.Update?leadId=<id>
// Body is an array of { Attribute, Value } pairs. Used by the AI
// pipeline to push extracted fields (name, email, age, pincode) onto
// the matching CRM lead.
// ---------------------------------------------------------------------------

export interface LsqUpdateField {
  Attribute: string;
  Value: string;
}

export interface LsqUpdateResult {
  ok: boolean;
  status: number;
  error: string | null;
  /** LSQ echoes back the updated lead id when successful. */
  lead_id: string | null;
  /** Attribute names LSQ rejected as "does not exist" on this tenant —
   *  caller should surface these so the operator fixes the schema name
   *  in Lead Defaults / Field Mappings. Empty when nothing was dropped. */
  dropped_attrs?: string[];
}

/** Parse the "Attribute(s) does not exist - X,Y" error LSQ returns
 *  when one or more field names are unknown to the tenant schema.
 *  Returns the bad attribute names so the caller can drop them and
 *  retry, instead of losing the whole payload to one typo. */
function parseUnknownAttributes(error: string | null): string[] {
  if (!error) return [];
  const match = error.match(/Attribute\(s\) does not exist\s*-\s*([^.]+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function lsqUpdateLead(
  prospectId: string,
  fields: LsqUpdateField[],
): Promise<LsqUpdateResult> {
  if (fields.length === 0) {
    return { ok: true, status: 200, error: null, lead_id: prospectId };
  }
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return { ok: false, status: 0, error: "CRM not configured", lead_id: null };
  }

  const doUpdate = async (body: LsqUpdateField[]) =>
    lsqFetch<{
      Status?: string;
      Message?: { Id?: string; AffectedRows?: number };
      ExceptionMessage?: string;
    }>({
      method: "POST",
      path: "/v2/LeadManagement.svc/Lead.Update",
      query: { leadId: prospectId },
      body,
      timeoutMs: 15_000,
    });

  let res = await doUpdate(fields);
  let droppedAttrs: string[] = [];

  // Defensive retry: LSQ rejects the whole payload if even one
  // attribute name is unknown to the tenant schema. Drop the offenders
  // and retry once so valid fields still land — only invalid ones get
  // silently skipped (with a warning so operators can fix their config).
  if (!res.ok) {
    const bad = parseUnknownAttributes(res.error);
    if (bad.length > 0) {
      droppedAttrs = bad;
      const filtered = fields.filter((f) => !bad.includes(f.Attribute));
      console.warn(
        `[lsq] Lead.Update ${prospectId} dropping unknown attrs: ${bad.join(", ")} (fix the schema names in Automation → Lead Defaults / Field Mappings)`,
      );
      if (filtered.length === 0) {
        return {
          ok: true,
          status: 200,
          error: null,
          lead_id: prospectId,
          dropped_attrs: droppedAttrs,
        };
      }
      res = await doUpdate(filtered);
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error,
      lead_id: null,
      dropped_attrs: droppedAttrs,
    };
  }
  return {
    ok: true,
    status: res.status,
    error: null,
    lead_id: res.data?.Message?.Id ?? prospectId,
    dropped_attrs: droppedAttrs,
  };
}

// ---------------------------------------------------------------------------
// Create-or-update by phone — used to bring a fresh WhatsApp inbound
// onto LSQ as a Lead the first time we see it. SearchBy=Phone makes
// the API match-or-insert in a single call. Subsequent updates can use
// the cheaper Lead.Update path (no search) once we've cached the
// prospect_id on the contact row.
//
// Phone format LSQ wants: "<countrycode>-<10digits>" — same shape we
// use for the activity / lookup endpoints.
// ---------------------------------------------------------------------------

function formatPhoneForLsq(waId: string): string {
  // Canonical LSQ phone format on this tenant: `+<cc>-<last10>`,
  // e.g. `+91-9045454045`. Same format used for create + lookup so they
  // stay in lockstep (a mismatch here is what created the duplicate
  // lead bug).
  const digits = waId.replace(/\D/g, "");
  if (digits.length > 10) {
    const cc = digits.slice(0, digits.length - 10);
    const last10 = digits.slice(-10);
    return `+${cc}-${last10}`;
  }
  return digits;
}

/**
 * Idempotent upsert by phone — DEDUP-SAFE.
 *
 * Lead.CreateOrUpdate's SearchBy=Phone does an exact-string match,
 * which means leads stored as "+91-9045454045" don't match a query
 * value of "91-9045454045" — we'd silently create a duplicate. The
 * RetrieveLeadByPhoneNumber endpoint, on the other hand, normalises
 * formatting so it always finds the lead. So our flow is:
 *
 *   1. Look up via RetrieveLeadByPhoneNumber (canonical `cc-last10`)
 *   2. If found → Lead.Update with the matched prospect_id (no search,
 *      no chance of duplicating)
 *   3. If not found → Lead.Create (insert-only — never falls back into
 *      CreateOrUpdate semantics, since a stale match there would defeat
 *      the lookup we just did)
 *
 * This is what every call site should use.
 */
export async function lsqUpsertLeadByPhone(
  waId: string,
  extraFields: LsqUpdateField[] = [],
): Promise<LsqUpdateResult & { prospect_id: string | null; created: boolean }> {
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      status: 0,
      error: "CRM not configured",
      lead_id: null,
      prospect_id: null,
      created: false,
    };
  }

  // Step 1: try every common phone-format variant via the lookup
  // endpoint. This is what made the activity-fetch flow reliable on
  // this tenant — the same logic dedupes lead creation here.
  const existing = await lsqGetLeadByMobile(waId);
  if (existing.found && existing.lead?.prospect_id) {
    if (extraFields.length === 0) {
      return {
        ok: true,
        status: 200,
        error: null,
        lead_id: existing.lead.prospect_id,
        prospect_id: existing.lead.prospect_id,
        created: false,
      };
    }
    // Step 2a: found — push the new field values onto the existing
    // lead. No SearchBy involved, so no duplicate risk.
    const upd = await lsqUpdateLead(existing.lead.prospect_id, extraFields);
    return {
      ok: upd.ok,
      status: upd.status,
      error: upd.error,
      lead_id: existing.lead.prospect_id,
      prospect_id: existing.lead.prospect_id,
      created: false,
    };
  }

  // Step 2b: not found — call Lead.Create directly. Safer than
  // Lead.CreateOrUpdate here because we've already verified there's no
  // match, so the upsert semantics aren't needed and we sidestep any
  // "lead created twice due to format drift in CreateOrUpdate's
  // internal SearchBy" pitfalls that bit us before.
  const created = await lsqCreateLeadByPhone(waId, extraFields);
  return { ...created, created: created.ok };
}

export async function lsqCreateLeadByPhone(
  waId: string,
  extraFields: LsqUpdateField[] = [],
  // When `upsert` is false the request is a PURE create — no
  // `SearchBy: Phone`, so LSQ never matches and overwrites an existing
  // lead (e.g. the source/sub-source of a lead the phone lookup missed).
  // Used when "Also update existing leads' source" is OFF: a new inbound
  // must create-only, never re-attribute an existing lead. Default true
  // keeps the upsert dedup net for callers that want it.
  opts: { upsert?: boolean } = {},
): Promise<LsqUpdateResult & { prospect_id: string | null }> {
  const upsert = opts.upsert !== false;
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      status: 0,
      error: "CRM not configured",
      lead_id: null,
      prospect_id: null,
    };
  }

  const phone = formatPhoneForLsq(waId);
  if (!phone) {
    return {
      ok: false,
      status: 0,
      error: "Invalid phone (empty after normalisation)",
      lead_id: null,
      prospect_id: null,
    };
  }

  // Body shape pinned from a working n8n template on this tenant
  // (Create Lead1 — Sahil Ayyan Channel flow):
  //   • Endpoint: Lead.CreateOrUpdate
  //   • Header auth (x-LSQ-AccessKey / x-LSQ-SecretKey)
  //   • Order: data fields first, `SearchBy: Phone` LAST
  // Duplicate prevention is guaranteed upstream by lsqUpsertLeadByPhone
  // (lookup-first), so the SearchBy here only fires when no existing
  // lead was found.
  const sanitized = extraFields.filter(
    (f) => f.Attribute !== "SearchBy" && f.Attribute !== "Phone" && f.Value,
  );
  const buildBody = (extras: LsqUpdateField[]): LsqUpdateField[] => [
    { Attribute: "Phone", Value: phone },
    ...extras,
    // SearchBy upserts (updates an existing lead matched by phone). Omit
    // it for a pure create so existing leads are never re-attributed.
    ...(upsert ? [{ Attribute: "SearchBy", Value: "Phone" }] : []),
  ];

  const doCreate = async (extras: LsqUpdateField[]) =>
    lsqFetch<{
      Status?: string;
      Message?: { Id?: string; RelatedID?: string; AffectedRows?: number };
      ExceptionMessage?: string;
    }>({
      method: "POST",
      path: "/v2/LeadManagement.svc/Lead.CreateOrUpdate",
      body: buildBody(extras),
      timeoutMs: 15_000,
    });

  let res = await doCreate(sanitized);
  let droppedAttrs: string[] = [];

  // Defensive retry: drop unknown-attribute names and try again so a
  // single bad mapping doesn't lose the whole lead. Mirror of the same
  // pattern in lsqUpdateLead — keeps the Source/etc. fields the tenant
  // actually accepts while silently skipping the typo'd ones.
  if (!res.ok) {
    const bad = parseUnknownAttributes(res.error);
    if (bad.length > 0) {
      droppedAttrs = bad;
      const filtered = sanitized.filter((f) => !bad.includes(f.Attribute));
      console.warn(
        `[lsq] Lead.CreateOrUpdate ${phone} dropping unknown attrs: ${bad.join(", ")} (fix the schema names in Automation → Lead Defaults / Field Mappings)`,
      );
      res = await doCreate(filtered);
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error,
      lead_id: null,
      prospect_id: null,
      dropped_attrs: droppedAttrs,
    };
  }

  // Lead.CreateOrUpdate returns the new/updated lead id under either
  // Message.Id (older tenants) or Message.RelatedID (newer responses).
  const leadId =
    res.data?.Message?.Id ?? res.data?.Message?.RelatedID ?? null;
  return {
    ok: true,
    status: res.status,
    error: null,
    lead_id: leadId,
    prospect_id: leadId,
    dropped_attrs: droppedAttrs,
  };
}

// ---------------------------------------------------------------------------
// Activity create — logs a WhatsApp message (inbound or outbound) onto
// a lead's activity timeline. Mirrors the n8n template QHT already
// uses, including the (Insta WA <phone>) suffix in ActivityNote so the
// LSQ reports can group by source number.
//
// Endpoint: POST /v2/ProspectActivity.svc/Create
// Body: { RelatedProspectId, ActivityEvent, ActivityNote, Fields[] }
//
// `ActivityEvent` is a tenant-specific event code (205 for QHT's
// WhatsApp activity). Override with LSQ_ACTIVITY_EVENT_WHATSAPP if
// your tenant uses a different code.
// ---------------------------------------------------------------------------

export interface LsqActivityField {
  SchemaName: string;
  Value: string;
}

export interface LsqActivityCreateInput {
  prospectId: string;
  /** Numeric LSQ event code. Defaults to env LSQ_ACTIVITY_EVENT_WHATSAPP
   *  → 205 (QHT's WhatsApp activity) when not provided. */
  activityEvent?: number;
  /** Free-form summary line — shown as the activity headline in LSQ. */
  note: string;
  /** Custom-field values for this activity. Each entry maps an LSQ
   *  schema name to a string value. */
  fields?: LsqActivityField[];
}

export interface LsqActivityCreateResult {
  ok: boolean;
  status: number;
  activity_id: string | null;
  error: string | null;
}

export async function lsqCreateActivity(
  input: LsqActivityCreateInput,
): Promise<LsqActivityCreateResult> {
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return { ok: false, status: 0, activity_id: null, error: "CRM not configured" };
  }
  if (!input.prospectId) {
    return { ok: false, status: 0, activity_id: null, error: "prospectId is required" };
  }

  const eventCode =
    input.activityEvent ??
    (Number(process.env.LSQ_ACTIVITY_EVENT_WHATSAPP || "205") || 205);

  const body = {
    RelatedProspectId: input.prospectId,
    ActivityEvent: eventCode,
    ActivityNote: input.note,
    Fields: input.fields ?? [],
  };

  const res = await lsqFetch<{
    Status?: string;
    Message?: { Id?: string };
    ExceptionMessage?: string;
  }>({
    method: "POST",
    path: "/v2/ProspectActivity.svc/Create",
    body,
    timeoutMs: 15_000,
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      activity_id: null,
      error: res.error,
    };
  }
  return {
    ok: true,
    status: res.status,
    activity_id: res.data?.Message?.Id ?? null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Activity history — same timeline LSQ shows on the lead detail page.
// Used by the contact-details panel to render an inline "Activity History"
// section so the agent doesn't have to switch to LSQ to see notes,
// WhatsApp activities, calls, tasks, etc.
// ---------------------------------------------------------------------------

/** Raw CRM activity row as returned by /v2/ProspectActivity.svc/Retrieve.
 *  The shape was reverse-engineered from a working n8n workflow against
 *  this tenant — the field names differ from older LSQ docs. `Data` is
 *  an array of `{Key, Value}` records, NOT a flat object. */
export interface LsqActivityRow {
  Id: string;
  EventCode: number;
  EventName: string | null;
  ActivityScore?: number | null;
  ActivityType?: number | null;
  Type?: string | null;
  IsEmailType?: boolean;
  SessionId?: string | null;
  RelatedProspectId?: string | null;
  CreatedOn: string | null;
  ModifiedOn?: string | null;
  Data: Array<{ Key: string; Value: string }> | null;
}

export interface LsqActivityView {
  id: string;
  event_code: number;
  event_name: string;
  note: string | null;
  created_on: string | null;
  created_by: string | null;
  /** Raw Field/Value pairs from LSQ — preserved end-to-end so the UI
   *  can render the same expandable detail table LSQ shows on its
   *  Activity History page. */
  data: Array<{ key: string; value: string }>;
}

export interface LsqActivityResult {
  ok: boolean;
  activities: LsqActivityView[];
  error: string | null;
}

/** LSQ returns timestamps as `"yyyy-MM-dd HH:mm:ss"` in UTC but without
 *  any TZ marker. JavaScript's `new Date(...)` would treat such a
 *  string as the BROWSER's local time, displaying activities 5:30
 *  hours off for IST users. Normalise to ISO-8601 with `Z` so every
 *  consumer (chat thread, sidebar timeline, detail rows) parses it
 *  correctly and `toLocaleTimeString()` renders in the operator's TZ. */
function normalizeLsqTimestamp(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Already has TZ info — leave it alone.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) return trimmed;
  return `${trimmed.replace(" ", "T")}Z`;
}

function projectActivity(row: LsqActivityRow): LsqActivityView {
  // Map raw {Key, Value} pairs to lowercase keys for the UI table.
  // Drop entries whose value is empty / null so the rendered table
  // doesn't have ugly "—" rows. Keep the original key spelling so it
  // matches what the operator sees on LSQ.
  const data = (row.Data ?? [])
    .filter((d) => d?.Key && typeof d.Value === "string" && d.Value.trim().length > 0)
    .map((d) => ({ key: d.Key, value: d.Value }));
  return {
    id: row.Id,
    event_code: row.EventCode,
    event_name: row.EventName ?? `Activity ${row.EventCode}`,
    note: extractNotePreview(row.Data, row.EventName),
    created_on: normalizeLsqTimestamp(row.CreatedOn),
    created_by: null,
    data,
  };
}

/** LSQ packs activity details into a `Data` array of `{Key, Value}`
 *  records. The keys vary by EventCode — for human-friendly display we
 *  try a priority list of known keys, then fall back to a one-line
 *  summary built from whatever non-empty Value is available. */
function extractNotePreview(
  data: Array<{ Key: string; Value: string }> | null,
  eventName: string | null,
): string | null {
  if (!data || data.length === 0) return null;
  const map = new Map<string, string>();
  for (const d of data) {
    if (d?.Key && typeof d.Value === "string") {
      map.set(d.Key, d.Value);
    }
  }

  // Highest-signal keys first.
  for (const k of [
    "ActivityNote",
    "Description",
    "ActivityDescription",
    "Comment",
    "Subject",
    "Body",
    "Message",
    "Note",
    "Status",
    "ResponseValue",
  ]) {
    const v = map.get(k);
    if (v && v.trim()) return v.trim();
  }

  // For status-change events, NewData often holds the post-change snapshot.
  // Try to surface it compactly.
  const newData = map.get("NewData");
  if (newData) {
    try {
      const parsed = JSON.parse(newData) as Record<string, unknown>;
      const status = typeof parsed.Status === "string" ? parsed.Status : null;
      if (status) return `${eventName ?? "Activity"} → ${status}`;
    } catch {
      // not JSON — show first 120 chars
      if (newData.trim()) return newData.trim().slice(0, 120);
    }
  }

  // Last-ditch: show first useful Key=Value pair. Skip metadata-only
  // keys (Event marker, CreatedBy*, modifier names) — those belong in
  // the expandable detail table, not the collapsed preview line.
  const SKIP_KEYS = new Set([
    "Event",
    "CreatedBy",
    "CreatedByName",
    "ModifiedBy",
    "ModifiedByName",
    "OwnerId",
    "RelatedProspectId",
  ]);
  for (const [k, v] of map) {
    if (SKIP_KEYS.has(k) || !v?.trim()) continue;
    return `${k}: ${v.slice(0, 100)}`;
  }
  return null;
}

interface ActivityResponse {
  RecordCount?: number;
  ProspectActivities?: LsqActivityRow[];
}

export interface LsqLeadFields {
  ok: boolean;
  /** Flat map of every scalar lead field (mx_* customs included). */
  fields: Record<string, string>;
  error: string | null;
}

/** Fetch a lead's full field set by ProspectID — used to read the
 *  package custom fields (mx_Number_Of_Graft, mx_Total_Package, …) that
 *  the "Package Shared" panel surfaces. */
export async function lsqGetLeadById(
  prospectId: string,
  cfg: LsqConfig = getLsqConfig(),
): Promise<LsqLeadFields> {
  if (!cfg.configured) {
    return { ok: false, fields: {}, error: "CRM not configured" };
  }
  const res = await lsqFetch<
    Record<string, unknown> | Array<Record<string, unknown>>
  >(
    {
      method: "GET",
      path: "/v2/LeadManagement.svc/Leads.GetById",
      query: { id: prospectId },
    },
    cfg,
  );
  if (!res.ok) return { ok: false, fields: {}, error: res.error };
  const lead = Array.isArray(res.data) ? res.data[0] : res.data;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(
    (lead ?? {}) as Record<string, unknown>,
  )) {
    if (v == null || typeof v === "object") continue;
    const val = String(v).trim();
    if (val && val !== "{}") fields[k] = val;
  }
  return { ok: true, fields, error: null };
}

/**
 * Pulls a lead's activity timeline from LSQ.
 *
 * Endpoint shape pinned from a working n8n workflow on this tenant:
 *   - POST /v2/ProspectActivity.svc/Retrieve
 *   - leadId travels as a query param (alongside accessKey/secretKey),
 *     NOT in the request body
 *   - Body holds the paging block in `Offset`/`RowCount` style — note:
 *     `RowCount` (not PageSize), zero-indexed `Offset` (not PageIndex)
 *   - Response: `{ RecordCount, ProspectActivities: [...] }`
 */
export async function lsqGetLeadActivities(
  prospectId: string,
  limit = 50,
  cfg: LsqConfig = getLsqConfig(),
): Promise<LsqActivityResult> {
  if (!cfg.configured) {
    return { ok: false, activities: [], error: "CRM not configured" };
  }

  const res = await lsqFetch<ActivityResponse>(
    {
      method: "POST",
      path: "/v2/ProspectActivity.svc/Retrieve",
      query: { leadId: prospectId },
      body: { Paging: { Offset: 0, RowCount: limit } },
      timeoutMs: 20_000,
    },
    cfg,
  );

  if (!res.ok) {
    console.warn(
      `[lsq] activities Retrieve → HTTP ${res.status}: ${res.error}`,
    );
    return { ok: false, activities: [], error: res.error };
  }

  const rows = res.data?.ProspectActivities ?? [];
  return {
    ok: true,
    activities: rows.map(projectActivity),
    error: null,
  };
}

export async function lsqGetLeadByMobile(
  waId: string,
  cfg: LsqConfig = getLsqConfig(),
): Promise<LsqLeadLookup> {
  if (!cfg.configured) {
    return { ok: false, found: false, lead: null, error: "CRM not configured", matched_variant: null };
  }

  // Single API call — `cc-last10` phone format against the canonical
  // RetrieveLeadByPhoneNumber endpoint. Used to probe a dozen variants
  // here; that burned through the 10-calls/5s rate limit and never
  // matched anything the canonical format didn't already cover.
  const phone = buildCanonicalPhone(waId);
  const tag = `[lsq] lookup ${waId} (key …${cfg.accessKey.slice(-4)})`;

  const res = await lsqFetch<LsqLead[] | { Leads?: LsqLead[]; Status?: string; ExceptionMessage?: string }>(
    {
      method: "GET",
      path: LEAD_LOOKUP_PATH,
      query: { phone },
    },
    cfg,
  );
  if (!res.ok) {
    console.warn(`${tag} phone=${phone} → HTTP ${res.status}: ${res.error}`);
    return {
      ok: false,
      found: false,
      lead: null,
      error: res.error,
      matched_variant: null,
    };
  }

  const data = res.data;
  const rows: LsqLead[] = Array.isArray(data)
    ? data
    : (data as { Leads?: LsqLead[] } | null)?.Leads ?? [];
  console.log(`${tag} phone=${phone} → ${rows.length} match(es)`);

  if (rows.length === 0) {
    return {
      ok: true,
      found: false,
      lead: null,
      error: null,
      matched_variant: null,
    };
  }

  // Pick the most-recently modified record when LSQ returns multiple
  // matches (rare but happens with duplicate leads that were never merged).
  const best = [...rows].sort((a, b) => {
    const ta = a.ModifiedOn ? Date.parse(a.ModifiedOn) : 0;
    const tb = b.ModifiedOn ? Date.parse(b.ModifiedOn) : 0;
    return tb - ta;
  })[0];
  return {
    ok: true,
    found: true,
    lead: toView(best, cfg.host),
    error: null,
    matched_variant: `phone=${phone}`,
  };
}

/**
 * Raw lead fetch by phone — returns the FULL lead as a flat, lowercased
 * `field -> string` map (every column LSQ has on the lead, including custom
 * fields like mx_Brand / mx_NDR_Reason). Used by the drip engine to read a
 * trigger field that the webhook push didn't include. Returns null on
 * miss / error. Single API call (canonical `+cc-last10` phone format).
 */
export async function lsqGetLeadRawByPhone(
  waId: string,
  cfg: LsqConfig = getLsqConfig(),
): Promise<Record<string, string> | null> {
  if (!cfg.configured) return null;
  const phone = buildCanonicalPhone(waId);
  const res = await lsqFetch<Array<Record<string, unknown>> | { Leads?: Array<Record<string, unknown>> }>(
    { method: "GET", path: LEAD_LOOKUP_PATH, query: { phone } },
    cfg,
  );
  if (!res.ok || !res.data) return null;
  const rows = Array.isArray(res.data) ? res.data : (res.data.Leads ?? []);
  if (rows.length === 0) return null;
  const best = [...rows].sort((a, b) => {
    const ta = a.ModifiedOn ? Date.parse(String(a.ModifiedOn)) : 0;
    const tb = b.ModifiedOn ? Date.parse(String(b.ModifiedOn)) : 0;
    return tb - ta;
  })[0];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(best)) {
    if (v != null && typeof v !== "object") out[k.toLowerCase()] = String(v);
  }
  return out;
}

/**
 * Look up a lead by its ProspectAutoId (the "#432029"-style lead number
 * the operator sees in LSQ). Used by the CRM-lookup modal when the
 * search query is a lead number that isn't yet synced to any local
 * contact — we hit LSQ directly so the operator can then open a chat
 * for the lead's phone without first having to add the contact manually.
 *
 * Uses the `Leads.Get` search endpoint with a single LookupName/Value
 * criterion. Tolerant of both response shapes LSQ returns (bare array
 * or `{ Leads: [...] }`).
 */
export async function lsqGetLeadByLeadNumber(
  leadNumber: string,
  cfg: LsqConfig = getLsqConfig(),
): Promise<LsqLeadLookup> {
  if (!cfg.configured) {
    return {
      ok: false,
      found: false,
      lead: null,
      error: "CRM not configured",
      matched_variant: null,
    };
  }
  const trimmed = leadNumber.trim();
  if (!trimmed) {
    return { ok: true, found: false, lead: null, error: null, matched_variant: null };
  }
  const tag = `[lsq] lookup leadNumber=${trimmed} (key …${cfg.accessKey.slice(-4)})`;

  const res = await lsqFetch<
    LsqLead[] | { Leads?: LsqLead[]; Status?: string; ExceptionMessage?: string }
  >(
    {
      method: "POST",
      path: "/v2/LeadManagement.svc/Leads.Get",
      body: {
        Parameter: {
          LookupName: "ProspectAutoId",
          LookupValue: trimmed,
          SqlOperator: "=",
        },
      },
    },
    cfg,
  );
  if (!res.ok) {
    console.warn(`${tag} → HTTP ${res.status}: ${res.error}`);
    return {
      ok: false,
      found: false,
      lead: null,
      error: res.error,
      matched_variant: null,
    };
  }
  const data = res.data;
  const rows: LsqLead[] = Array.isArray(data)
    ? data
    : (data as { Leads?: LsqLead[] } | null)?.Leads ?? [];
  console.log(`${tag} → ${rows.length} match(es)`);
  if (rows.length === 0) {
    return { ok: true, found: false, lead: null, error: null, matched_variant: null };
  }
  return {
    ok: true,
    found: true,
    lead: toView(rows[0], cfg.host),
    error: null,
    matched_variant: `leadNumber=${trimmed}`,
  };
}

// ---------------------------------------------------------------------------
// Photo / attachment pipeline.
//
// Three sequential LSQ calls (mirrors the working n8n template):
//   1. ProspectActivity.svc/Create → reserve an activity, get its Id.
//   2. files-in21.leadsquared.com/File/Upload → multipart upload of the
//      raw photo bytes; returns a file path + name.
//   3. ProspectActivity.svc/Attachment/Add → links the uploaded file
//      to the activity created in step 1.
// Auth: header-based (x-LSQ-AccessKey / x-LSQ-SecretKey) for the API
// host; the file-upload host wants creds in the query string (n8n's
// `sendQuery` mode).
// ---------------------------------------------------------------------------

/** Upload a raw image buffer to LSQ's file storage. Returns the
 *  uploaded path + canonical name as LSQ echoes them back — those are
 *  what the next call (`Attachment/Add`) needs. */
export async function lsqUploadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<{ ok: boolean; path: string | null; name: string | null; error: string | null }> {
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return { ok: false, path: null, name: null, error: "CRM not configured" };
  }

  // Files host is a sibling of the API host: api-in21 → files-in21.
  // Fall back to a brute-string replace so we don't need a separate
  // env var for it.
  const filesHost = cfg.host
    .replace("api-in21", "files-in21")
    .replace("api-in22", "files-in22")
    .replace("api-in23", "files-in23")
    .replace("//api-", "//files-");

  const query = new URLSearchParams({
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });

  // Field order matches the n8n template — `uploadFiles` (binary)
  // first, `FileType` second. Browsers don't care, but some LSQ
  // tenants reportedly do parse multipart in declaration order.
  const form = new FormData();
  form.append(
    "uploadFiles",
    new Blob([new Uint8Array(buffer)], { type: mimeType }),
    filename,
  );
  form.append("FileType", "1");

  try {
    const res = await fetch(`${filesHost}/File/Upload?${query.toString()}`, {
      method: "POST",
      headers: {
        // Header auth too, belt-and-braces; LSQ accepts either.
        "x-LSQ-AccessKey": cfg.accessKey,
        "x-LSQ-SecretKey": cfg.secretKey,
      },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* leave as null */
    }
    if (!res.ok) {
      console.warn(
        `[lsq] file upload HTTP ${res.status}: ${raw.slice(0, 300)}`,
      );
      return {
        ok: false,
        path: null,
        name: null,
        error: `HTTP ${res.status}: ${raw.slice(0, 200)}`,
      };
    }
    // Response shape varies. n8n template uses `s3FilePath` /
    // `uploadedFile`; some tenants return them inside an array
    // (`[{s3FilePath, uploadedFile, ...}]`). Log the raw shape on
    // first miss so we can see what the tenant actually sent back.
    const arr = Array.isArray(parsed) ? parsed : null;
    const obj = (arr?.[0] ?? parsed ?? {}) as Record<string, unknown>;
    const path =
      typeof obj.s3FilePath === "string"
        ? obj.s3FilePath
        : typeof obj.FilePath === "string"
          ? (obj.FilePath as string)
          : typeof obj.Path === "string"
            ? (obj.Path as string)
            : typeof obj.PhysicalFilePath === "string"
              ? (obj.PhysicalFilePath as string)
              : null;
    const name =
      typeof obj.uploadedFile === "string"
        ? obj.uploadedFile
        : typeof obj.FileName === "string"
          ? (obj.FileName as string)
          : typeof obj.UploadedFileName === "string"
            ? (obj.UploadedFileName as string)
            : filename;
    if (!path) {
      console.warn(
        `[lsq] file upload returned no recognisable path. Raw response: ${raw.slice(0, 500)}`,
      );
    }
    return { ok: !!path, path, name, error: path ? null : "No path in upload response" };
  } catch (e) {
    return {
      ok: false,
      path: null,
      name: null,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}

/** Attach a previously-uploaded file to an existing prospect activity.
 *  Body is JSON (matches the n8n template — earlier we sent
 *  form-urlencoded, which LSQ silently 200'd without actually linking
 *  the file). Auth via both the standard headers AND query string,
 *  again to match n8n exactly so any tenant-side header filtering
 *  doesn't bite us. */
export async function lsqAttachToActivity(
  activityId: string,
  attachmentName: string,
  attachmentPath: string,
  fileType: string = "1",
): Promise<{ ok: boolean; error: string | null }> {
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return { ok: false, error: "CRM not configured" };
  }

  const params = new URLSearchParams({
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });
  const body = {
    ProspectActivityId: activityId,
    AttachmentName: attachmentName,
    AttachmentFile: attachmentPath,
    FileType: fileType,
  };

  try {
    const res = await fetch(
      `${cfg.host}/v2/ProspectActivity.svc/Attachment/Add?${params.toString()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-LSQ-AccessKey": cfg.accessKey,
          "x-LSQ-SecretKey": cfg.secretKey,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const raw = await res.text();
    if (!res.ok) {
      console.warn(
        `[lsq] Attachment/Add HTTP ${res.status}: ${raw.slice(0, 300)}`,
      );
      return { ok: false, error: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
    }
    // LSQ sometimes returns 200 with `Status: "Error"` in the body,
    // so parse and surface that instead of silently treating as ok.
    try {
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if (parsed && typeof parsed === "object") {
        const status = (parsed as { Status?: unknown }).Status;
        if (typeof status === "string" && status.toLowerCase() === "error") {
          const msg =
            (parsed as { ExceptionMessage?: string }).ExceptionMessage ??
            JSON.stringify(parsed).slice(0, 200);
          console.warn(`[lsq] Attachment/Add LSQ-side error: ${msg}`);
          return { ok: false, error: msg };
        }
      }
    } catch {
      /* not JSON — assume success since HTTP was 2xx */
    }
    return { ok: true, error: null };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
}

/** Set ProspectStage on a lead. Thin wrapper over lsqUpdateLead so
 *  call sites don't have to spell out the `[{Attribute,Value}]`
 *  array. Defensive retry inherited from lsqUpdateLead. */
export async function lsqUpdateProspectStage(
  prospectId: string,
  stage: string,
): Promise<LsqUpdateResult> {
  return lsqUpdateLead(prospectId, [
    { Attribute: "ProspectStage", Value: stage },
  ]);
}

/** Look up a single lead by prospect_id and return its current
 *  ProspectStage. Used by the photo-receive flow to gate the auto-
 *  stage-transition (only fires when the lead is in one of the
 *  operator-configured stages). */
export async function lsqGetProspectStage(
  prospectId: string,
): Promise<{ ok: boolean; stage: string | null; error: string | null }> {
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return { ok: false, stage: null, error: "CRM not configured" };
  }
  const res = await lsqFetch<{ ProspectStage?: string } | LsqLead>({
    method: "GET",
    path: "/v2/LeadManagement.svc/Leads.GetById",
    query: { id: prospectId },
  });
  if (!res.ok) {
    return { ok: false, stage: null, error: res.error };
  }
  const data = res.data as { ProspectStage?: string } | LsqLead | null;
  const stage =
    data && typeof data === "object" && "ProspectStage" in data
      ? ((data as { ProspectStage?: string }).ProspectStage ?? null)
      : null;
  return { ok: true, stage, error: null };
}

// ---------------------------------------------------------------------------
// Bulk lead export — Leads.RecentlyModified.
//
// Per-contact RetrieveLeadByPhoneNumber is capped by LSQ's 10-calls/5s
// rate limit, so backfilling 11k contacts one-by-one takes hours. This
// endpoint returns leads 1000-at-a-time across the WHOLE account, so a
// full export is ~300 calls instead of ~11k — the backfill walks pages
// and matches phones locally. Each lead arrives as a `LeadPropertyList`
// of {Attribute, Value} pairs.
// ---------------------------------------------------------------------------

export interface LsqBulkLead {
  prospect_id: string | null;
  lead_number: string | null;   // ProspectAutoId
  phone: string | null;         // raw, e.g. "+91-7979723722"
  stage: string | null;         // ProspectStage
  owner_name: string | null;    // OwnerIdName
  owner_email: string | null;   // OwnerIdEmailAddress
  first_name: string | null;    // FirstName
}

export interface LsqLeadsPage {
  ok: boolean;
  error: string | null;
  /** Total leads in the account (from the API's RecordCount). */
  record_count: number;
  leads: LsqBulkLead[];
}

interface LeadProperty {
  Attribute?: string;
  Value?: string | null;
}

/** Fetch one page of leads. `pageIndex` is 1-based. A page shorter than
 *  `pageSize` means the export is exhausted. */
export async function lsqFetchLeadsPage(
  pageIndex: number,
  pageSize = 1000,
): Promise<LsqLeadsPage> {
  const res = await lsqFetch<{
    RecordCount?: number;
    Leads?: Array<{ LeadPropertyList?: LeadProperty[] }>;
  }>({
    method: "POST",
    path: "/v2/LeadManagement.svc/Leads.RecentlyModified",
    body: {
      Parameter: {
        FromDate: "2005-01-01 00:00:00",
        ToDate: new Date(Date.now() + 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " "),
      },
      Paging: { PageIndex: pageIndex, PageSize: pageSize },
      Sorting: { ColumnName: "CreatedOn", Direction: "1" },
      Columns: {
        Include_CSV:
          "ProspectID,ProspectAutoId,Phone,Mobile,ProspectStage,OwnerIdName,OwnerIdEmailAddress,FirstName",
      },
    },
    timeoutMs: 30_000,
  });

  if (!res.ok || !res.data) {
    return { ok: false, error: res.error ?? "LSQ error", record_count: 0, leads: [] };
  }

  const leads: LsqBulkLead[] = (res.data.Leads ?? []).map((row) => {
    const m = new Map<string, string>();
    for (const p of row.LeadPropertyList ?? []) {
      if (p.Attribute && p.Value != null) m.set(p.Attribute, String(p.Value));
    }
    return {
      prospect_id: m.get("ProspectID") ?? null,
      lead_number: m.get("ProspectAutoId") ?? null,
      phone: m.get("Phone") || m.get("Mobile") || null,
      stage: m.get("ProspectStage") ?? null,
      owner_name: m.get("OwnerIdName") ?? null,
      // Normalised so the assigned-only inbox filter can match it against the
      // agent's lower-cased auth email.
      owner_email: (m.get("OwnerIdEmailAddress") ?? "").trim().toLowerCase() || null,
      first_name: m.get("FirstName") ?? null,
    };
  });

  return {
    ok: true,
    error: null,
    record_count: Number(res.data.RecordCount ?? 0) || 0,
    leads,
  };
}

// ---------------------------------------------------------------------------
// User management — Users.Get returns every LSQ user (sales agents etc.) with
// their ID, name, email, role, and StatusCode. StatusCode 0 = active/present;
// any other value (e.g. deactivated) means the agent should NOT receive
// lead assignments. Used by Lead Distribution to verify an agent exists and
// is live in LSQ before assigning a lead to them.
// ---------------------------------------------------------------------------
export interface LsqUser {
  id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: string | null;
  status_code: number | null;
  /** StatusCode === 0 in LSQ. */
  active: boolean;
}

interface RawLsqUser {
  ID?: string;
  Id?: string;
  FirstName?: string | null;
  LastName?: string | null;
  EmailAddress?: string | null;
  Email?: string | null;
  Role?: string | null;
  StatusCode?: number | string | null;
}

export async function lsqGetUsers(
  cfg: LsqConfig = getLsqConfig(),
): Promise<{ ok: boolean; error: string | null; users: LsqUser[] }> {
  const res = await lsqFetch<RawLsqUser[]>(
    { method: "GET", path: "/v2/UserManagement.svc/Users.Get" },
    cfg,
  );
  if (!res.ok || !Array.isArray(res.data)) {
    return { ok: false, error: res.error ?? "Users.Get failed", users: [] };
  }
  const users: LsqUser[] = res.data.map((u) => {
    const code = u.StatusCode == null ? null : Number(u.StatusCode);
    const first = (u.FirstName ?? "").trim();
    const last = (u.LastName ?? "").trim();
    return {
      id: String(u.ID ?? u.Id ?? "").trim(),
      name: `${first} ${last}`.trim(),
      first_name: first || null,
      last_name: last || null,
      email: (u.EmailAddress ?? u.Email ?? "").trim().toLowerCase() || null,
      role: u.Role ?? null,
      status_code: Number.isFinite(code) ? code : null,
      active: code === 0,
    };
  });
  return { ok: true, error: null, users };
}
