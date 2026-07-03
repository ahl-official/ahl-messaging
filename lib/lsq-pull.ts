// Shared CRM lead-pull core — used by the /api/lsq/pull-leads route (campaign
// preview) AND the recurring-campaign daily job. Hits LeadManagement.svc/
// Leads.Get directly, runs one criterion as the LSQ query and the rest
// client-side, and normalises phones to wa_id form.

import { getLsqConfig, lsqFetch, type LsqConfig } from "@/lib/lsq";

export interface PullLeadsFilter {
  stages?: string[];
  owners?: string[];
  sources?: string[];
  sub_sources?: string[];
  brands?: string[];
  created_after?: string; // ISO
  created_before?: string; // ISO
  max?: number;
}

export interface PulledLead {
  wa_id: string;
  display_name: string;
  stage: string | null;
  source: string | null;
  sub_source: string | null;
  brand: string | null;
  owner: string | null;
  prospect_id: string | null;
}

export interface PullLeadsResult {
  ok: boolean;
  error?: string;
  leads: PulledLead[];
  total_records_in_lsq: number;
  fetched: number;
  truncated_at_cap: boolean;
}

interface LsqLead {
  ProspectID?: string;
  FirstName?: string;
  LastName?: string;
  Phone?: string;
  Mobile?: string;
  ProspectStage?: string;
  OwnerIdName?: string;
  Source?: string;
  mx_Sub_source?: string;
  mx_Brand?: string;
  CreatedOn?: string;
  [key: string]: unknown;
}
type LsqGetResponse = LsqLead[] | { RecordCount?: number; Leads?: LsqLead[]; ExceptionMessage?: string };
type LsqParam = { LookupName: string; LookupValue: string; SqlOperator: string };

const PAGE_SIZE = 200;
const MAX_PAGES = 25; // 5,000 leads ceiling

function flattenLead(l: LsqLead): LsqLead {
  const list = (l as { LeadPropertyList?: Array<{ Attribute?: string; Value?: unknown }> }).LeadPropertyList;
  if (!Array.isArray(list)) return l;
  const flat: Record<string, unknown> = { ...l };
  for (const row of list) if (row?.Attribute) flat[row.Attribute] = row.Value;
  return flat as LsqLead;
}

export async function pullLeadsFromLsq(
  body: PullLeadsFilter,
  cfg: LsqConfig = getLsqConfig(),
): Promise<PullLeadsResult> {
  const empty: PullLeadsResult = {
    ok: false,
    leads: [],
    total_records_in_lsq: 0,
    fetched: 0,
    truncated_at_cap: false,
  };
  if (!cfg.configured) return { ...empty, error: "CRM not configured" };

  const cap = Math.max(100, Math.min(10000, body.max ?? 5000));

  const fmtLsq = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };

  // Date bounds are ALWAYS applied client-side (after fetch). A 90-day window
  // can hold 5,000+ leads, so using date as the LSQ query + a 5,000 scan cap
  // would silently miss a rare stage/source beyond the cap. So we prefer the
  // most-SELECTIVE categorical criterion as the LSQ query (stage → brand →
  // source-dim → owner) and only fall back to date when nothing else is set.
  // The date range then trims the (much smaller) result client-side.
  const dateLowerMs = body.created_after ? new Date(body.created_after).getTime() : null;
  const dateUpperMs = body.created_before ? new Date(body.created_before).getTime() : null;

  // Source + Sub-source are ONE dimension: a lead matches if its Source is one
  // of the chosen sources OR its Sub-source is one of the chosen sub-sources
  // (union — selecting sub-sources ADDS leads, never subtracts). LSQ can't OR
  // two fields in a single Leads.Get, so when this dimension drives the query
  // we run both (Source IN …) and (Sub-source IN …) and union the results.
  const hasSourceDim = !!(body.sources?.length || body.sub_sources?.length);
  const sourceDimQueries: LsqParam[] = [];
  if (body.sources?.length) sourceDimQueries.push({ LookupName: "Source", LookupValue: body.sources.join(","), SqlOperator: body.sources.length > 1 ? "IN" : "=" });
  if (body.sub_sources?.length) sourceDimQueries.push({ LookupName: "mx_Sub_source", LookupValue: body.sub_sources.join(","), SqlOperator: body.sub_sources.length > 1 ? "IN" : "=" });

  let primaryQueries: LsqParam[] = [];
  let primaryKind: "date" | "stages" | "owners" | "source" | "brands" | null = null;

  if (body.stages?.length) {
    primaryQueries = [{ LookupName: "ProspectStage", LookupValue: body.stages.join(","), SqlOperator: body.stages.length > 1 ? "IN" : "=" }];
    primaryKind = "stages";
  } else if (body.brands?.length) {
    primaryQueries = [{ LookupName: "mx_Brand", LookupValue: body.brands.join(","), SqlOperator: body.brands.length > 1 ? "IN" : "=" }];
    primaryKind = "brands";
  } else if (hasSourceDim) {
    primaryQueries = sourceDimQueries;
    primaryKind = "source";
  } else if (body.owners?.length) {
    primaryQueries = [{ LookupName: "OwnerIdName", LookupValue: body.owners.join(","), SqlOperator: body.owners.length > 1 ? "IN" : "=" }];
    primaryKind = "owners";
  } else if (body.created_after) {
    primaryQueries = [{ LookupName: "CreatedOn", LookupValue: fmtLsq(body.created_after), SqlOperator: ">=" }];
    primaryKind = "date";
  } else if (body.created_before) {
    primaryQueries = [{ LookupName: "CreatedOn", LookupValue: fmtLsq(body.created_before), SqlOperator: "<=" }];
    primaryKind = "date";
  }
  if (!primaryQueries.length) return { ...empty, error: "Add at least one filter (stages, owners, source, brand, or date range)." };

  // Client-side AND for the NON-primary dimensions. Stages / brands / owners
  // are exact-set membership; the source dimension stays a Source-OR-Sub union.
  const stageSet = primaryKind !== "stages" && body.stages?.length ? new Set(body.stages) : null;
  const ownerSet = primaryKind !== "owners" && body.owners?.length ? new Set(body.owners) : null;
  const brandSet = primaryKind !== "brands" && body.brands?.length ? new Set(body.brands) : null;
  const srcSet = primaryKind !== "source" && body.sources?.length ? new Set(body.sources) : null;
  const subSet = primaryKind !== "source" && body.sub_sources?.length ? new Set(body.sub_sources) : null;
  const sourceDimActive = !!(srcSet || subSet);
  const matchesSourceDim = (src: string, subSrc: string) => {
    if (!sourceDimActive) return true;
    if (srcSet && srcSet.has(src)) return true;
    if (subSet && subSet.has(subSrc)) return true;
    return false;
  };

  const collected: PulledLead[] = [];
  const seen = new Set<string>();
  // Count of leads actually evaluated across pages. The tenant's page-1
  // RecordCount is just the page size (200), not a real total, so we report
  // what we scanned instead.
  let scanned = 0;

  // Run each primary query (source-dim may have two) and union via `seen`.
  pull: for (const primary of primaryQueries) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const resp = await lsqFetch<LsqGetResponse>(
        {
          method: "POST",
          path: "/v2/LeadManagement.svc/Leads.Get",
          body: {
            Parameter: primary,
            Columns: {
              Include_CSV:
                "ProspectID,FirstName,LastName,Phone,Mobile,ProspectStage,OwnerIdName,Source,mx_Sub_source,mx_Brand,CreatedOn",
            },
            Sorting: { ColumnName: "CreatedOn", Direction: "1" },
            Paging: { PageIndex: page, PageSize: PAGE_SIZE },
          },
          timeoutMs: 30_000,
        },
        cfg,
      );
      if (!resp.ok) {
        if (page === 1 && collected.length === 0) return { ...empty, error: resp.error ?? "CRM search failed" };
        break;
      }
      const data = resp.data;
      const rawLeads: LsqLead[] = Array.isArray(data) ? data : data?.Leads ?? [];
      const leads = rawLeads.map(flattenLead);
      if (leads.length === 0) break;
      scanned += leads.length;
      for (const l of leads) {
        if (stageSet && !stageSet.has((l.ProspectStage ?? "").toString())) continue;
        if (ownerSet && !ownerSet.has((l.OwnerIdName ?? "").toString())) continue;
        const brand = (l.mx_Brand ?? "").toString();
        if (brandSet && !brandSet.has(brand)) continue;
        const src = (l.Source ?? "").toString();
        const subSrc = (l.mx_Sub_source ?? "").toString();
        if (!matchesSourceDim(src, subSrc)) continue;
        if (dateLowerMs !== null || dateUpperMs !== null) {
          const created = new Date((l.CreatedOn ?? "").toString()).getTime();
          if (!isNaN(created)) {
            if (dateLowerMs !== null && created < dateLowerMs) continue;
            if (dateUpperMs !== null && created > dateUpperMs) continue;
          }
        }
        const phone = (l.Phone ?? l.Mobile ?? "").toString();
        const digits = phone.replace(/\D/g, "");
        if (digits.length < 10) continue;
        const last10 = digits.slice(-10);
        const wa_id = /^[6-9]\d{9}$/.test(last10) ? `91${last10}` : digits;
        if (seen.has(wa_id)) continue;
        seen.add(wa_id);
        // Real name only — never fall back to the phone number (that would
        // render "Hi +91-…" in templates and show the number twice in the
        // preview). Nameless leads get an empty display_name.
        const name = [l.FirstName, l.LastName].filter(Boolean).join(" ").trim();
        collected.push({
          wa_id,
          display_name: name,
          stage: l.ProspectStage ?? null,
          source: src || null,
          sub_source: subSrc || null,
          brand: brand || null,
          owner: l.OwnerIdName ?? null,
          prospect_id: l.ProspectID ?? null,
        });
        if (collected.length >= cap) break pull;
      }
      if (leads.length < PAGE_SIZE) break;
    }
  }

  return {
    ok: true,
    leads: collected,
    total_records_in_lsq: scanned,
    fetched: collected.length,
    truncated_at_cap: collected.length >= cap,
  };
}
