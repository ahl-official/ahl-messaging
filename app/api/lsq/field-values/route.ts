// GET /api/lsq/field-values
//
// Returns every LSQ dropdown (Select) lead field with its option values —
// used by the drip builder so an operator can pick a Trigger field
// (Brand / NDR Reason / Source / utm…) and then pick a value from a list.
// Backed by LeadsMetaData.Get (the per-field GetDropdownValues endpoint 404s
// on this tenant). Cached 30 min — field schemas rarely change.

import { NextResponse } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getLsqConfig, lsqFetch } from "@/lib/lsq";
import { getSeenFieldValues } from "@/lib/lsq-field-suggestions";

export const runtime = "nodejs";

interface FieldMeta {
  SchemaName?: string;
  DisplayName?: string;
  DataType?: string;
  Options?: Array<{ Value?: string }> | string;
}
interface OutField {
  schema: string;
  display_name: string;
  values: string[];
  priority: boolean;
}

const TTL_MS = 30 * 60_000;
let cache: { at: number; fields: OutField[] } | null = null;

// Fields the operator filters on most — pinned to the TOP of the picker in
// this order, even if they have no dropdown options (value falls back to a
// free-text box). Everything else (Select fields with options) follows,
// alphabetical.
const PRIORITY_SCHEMAS = [
  "mx_Brand",        // Brand
  "mx_utm_source",   // Sub source
  "mx_NDR_Reason",   // Latest Source
  "SourceMedium",    // Source Medium
  "mx_Lead_City",    // City
  "mx_Lead_State",   // State
  "Source",          // Lead Source
];

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  // Union learned values (from incoming leads) into each field — gives the
  // cascading / free-text fields (Sub source, City, Source Medium) a value
  // list that LSQ's APIs don't expose.
  const withSeen = async (fields: OutField[]): Promise<OutField[]> => {
    const seen = await getSeenFieldValues();
    if (Object.keys(seen).length === 0) return fields;
    return fields.map((f) => {
      const extra = seen[f.schema.toLowerCase()] ?? [];
      if (extra.length === 0) return f;
      const merged = [...new Set([...f.values, ...extra])].sort((a, b) => a.localeCompare(b));
      return { ...f, values: merged };
    });
  };

  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ fields: await withSeen(cache.fields), cached: true });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "CRM not configured" }, { status: 400 });
  }

  const res = await lsqFetch<FieldMeta[]>({
    method: "GET",
    path: "/v2/LeadManagement.svc/LeadsMetaData.Get",
    timeoutMs: 20_000,
  });
  if (!res.ok || !Array.isArray(res.data)) {
    return NextResponse.json({ error: res.error ?? "CRM metadata fetch failed" }, { status: 502 });
  }

  const bySchema = new Map<string, OutField>();
  for (const f of res.data) {
    if (!f.SchemaName) continue;
    const isPriority = PRIORITY_SCHEMAS.some(
      (p) => p.toLowerCase() === f.SchemaName!.toLowerCase(),
    );
    // Keep Select fields with options, plus any priority field (even if it's
    // Text / has no options — the UI gives it a free-text value box).
    const isSelect = (f.DataType ?? "") === "Select";
    if (!isPriority && !isSelect) continue;
    const values = Array.isArray(f.Options)
      ? f.Options.map((o) => (o.Value ?? "").trim()).filter(Boolean) // drop blank option
      : [];
    if (!isPriority && values.length === 0) continue;
    bySchema.set(f.SchemaName.toLowerCase(), {
      schema: f.SchemaName,
      display_name: (f.DisplayName || f.SchemaName).trim(),
      values,
      priority: isPriority,
    });
  }

  // Priority fields first (in declared order), then the rest alphabetically.
  const prioritySet = new Set(PRIORITY_SCHEMAS.map((s) => s.toLowerCase()));
  const top = PRIORITY_SCHEMAS.map((s) => bySchema.get(s.toLowerCase())).filter(
    (x): x is OutField => !!x,
  );
  const rest = [...bySchema.values()]
    .filter((f) => !prioritySet.has(f.schema.toLowerCase()))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const fields = [...top, ...rest];

  cache = { at: Date.now(), fields };
  return NextResponse.json({ fields: await withSeen(fields) });
}
