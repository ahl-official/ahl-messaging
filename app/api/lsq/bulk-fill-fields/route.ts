// POST /api/lsq/bulk-fill-fields
//
// Per-field "create, not update" backfill. For a list of CRM leads (by Lead
// Number / ProspectAutoId) and a set of {schema: value} fields, stamp EACH
// field ONLY where the lead's current value for that field is blank — never
// overwrite an existing value. Different from /bulk-fill-source (which gates
// the whole lead on Source); here every field is checked independently.
//
// Auth: shared WEBHOOK_INTERNAL_TOKEN (script-drivable).
// Body: { token, lead_numbers: string[], fields: {schema: value, ...},
//         check?: boolean }

import { NextResponse, type NextRequest } from "next/server";
import { getCredential } from "@/lib/credentials";
import { getLsqConfig, lsqGetLeadByLeadNumber, lsqGetLeadById, lsqUpdateLead } from "@/lib/lsq";

export const runtime = "nodejs";
export const maxDuration = 800;

interface Body {
  token?: string;
  lead_numbers?: string[];
  /** Resolve straight to these LSQ ProspectIDs (skips the lead-number lookup). */
  prospect_ids?: string[];
  fields?: Record<string, string>;
  check?: boolean;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const expected = await getCredential("webhook_internal_token");
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || (auth !== expected && body.token !== expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) return NextResponse.json({ error: "CRM not configured" }, { status: 400 });

  const target = Object.entries(body.fields ?? {})
    .map(([Attribute, Value]) => ({ Attribute: Attribute.trim(), Value: String(Value).trim() }))
    .filter((f) => f.Attribute && f.Value);

  // Items to process: either lead numbers (need a lookup) or prospect IDs.
  const byProspect = (body.prospect_ids ?? []).length > 0;
  const items = byProspect
    ? [...new Set((body.prospect_ids ?? []).map((n) => String(n).trim()).filter(Boolean))]
    : [...new Set((body.lead_numbers ?? []).map((n) => String(n).trim()).filter(Boolean))];
  if (items.length === 0 || target.length === 0) {
    return NextResponse.json({ error: "lead_numbers (or prospect_ids) and fields are required" }, { status: 400 });
  }

  const result = {
    listed: items.length,
    updated: 0,
    already_complete: 0,
    not_found: [] as string[],
    errors: 0,
    error_leads: [] as string[],
    filled: {} as Record<string, string[]>, // key → fields stamped
    checked: [] as Array<{ key: string; missing: string[] }>,
  };

  const POOL = 3;
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const key = items[idx++];
      try {
        let prospectId = key;
        if (!byProspect) {
          const found = await lsqGetLeadByLeadNumber(key, cfg);
          if (!found.ok) { result.errors++; result.error_leads.push(key); continue; }
          if (!found.found || !found.lead?.prospect_id) { result.not_found.push(key); continue; }
          prospectId = found.lead.prospect_id;
        }

        // Current non-empty fields (lsqGetLeadById omits blanks).
        const cur = await lsqGetLeadById(prospectId, cfg);
        if (!cur.ok) { result.errors++; result.error_leads.push(key); continue; }
        const present = new Set(Object.keys(cur.fields).map((k) => k.toLowerCase()));

        // Only the target fields that are currently blank.
        const patch = target.filter((f) => !present.has(f.Attribute.toLowerCase()));
        const missing = patch.map((f) => f.Attribute);

        if (body.check) { result.checked.push({ key, missing }); continue; }
        if (patch.length === 0) { result.already_complete++; continue; }

        const upd = await lsqUpdateLead(prospectId, patch);
        if (upd.ok) { result.updated++; result.filled[key] = missing; }
        else { result.errors++; result.error_leads.push(key); }
      } catch {
        result.errors++;
        result.error_leads.push(key);
      }
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));

  return NextResponse.json({ ok: true, ...result });
}
