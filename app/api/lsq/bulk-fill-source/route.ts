// POST /api/lsq/bulk-fill-source
//
// One-off operational backfill: for a list of LSQ leads (given by Lead
// Number / ProspectAutoId), stamp Source / Sub Source ONLY where the
// lead's Source is currently blank — never overwrite an existing
// attribution ("create, not update").
//
// Each lead number is resolved straight against LSQ (Leads.Get by
// ProspectAutoId) so leads that aren't cached in our DB are still handled.
//
// Auth: shared WEBHOOK_INTERNAL_TOKEN (so it can be driven from a script).
//
// Body: { token, lead_numbers: string[], fields: {schema: value, ...},
//         check?: boolean }

import { NextResponse, type NextRequest } from "next/server";
import { getCredential } from "@/lib/credentials";
import { getLsqConfig, lsqGetLeadByLeadNumber, lsqUpdateLead } from "@/lib/lsq";
import { recordPushFailure, markPushSucceeded } from "@/lib/lsq-push-failures";

export const runtime = "nodejs";
export const maxDuration = 800;

interface Body {
  token?: string;
  lead_numbers?: string[];
  fields?: Record<string, string>;
  /** Read-only: report each lead's current Source, no writes. */
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
  if (!cfg.configured) {
    return NextResponse.json({ error: "LSQ not configured" }, { status: 400 });
  }

  const leadNumbers = [...new Set(
    (body.lead_numbers ?? []).map((n) => String(n).trim()).filter(Boolean),
  )];
  const fields = body.fields ?? {};
  const fieldPairs = Object.entries(fields)
    .map(([Attribute, Value]) => ({ Attribute: Attribute.trim(), Value: String(Value).trim() }))
    .filter((f) => f.Attribute && f.Value);
  if (leadNumbers.length === 0 || (!body.check && fieldPairs.length === 0)) {
    return NextResponse.json({ error: "lead_numbers and fields are required" }, { status: 400 });
  }

  const result = {
    listed: leadNumbers.length,
    filled: 0,
    skipped_has_source: 0,
    not_found: [] as string[],
    errors: 0,
    error_leads: [] as string[],
    checked: [] as Array<Record<string, string | null>>,
  };

  // Throttled — LSQ rate-limits (~10 calls / 5s). Small pool keeps us under.
  const POOL = 3;
  let idx = 0;
  async function worker() {
    while (idx < leadNumbers.length) {
      const leadNumber = leadNumbers[idx++];
      try {
        const found = await lsqGetLeadByLeadNumber(leadNumber, cfg);
        if (!found.ok) {
          result.errors++;
          result.error_leads.push(leadNumber);
          continue;
        }
        if (!found.found || !found.lead?.prospect_id) {
          result.not_found.push(leadNumber);
          continue;
        }
        const currentSource = (found.lead.source ?? "").trim();
        if (body.check) {
          result.checked.push({ lead_number: leadNumber, Source: currentSource || null });
          continue;
        }
        // Has a Source already → leave it untouched.
        if (currentSource) {
          result.skipped_has_source++;
          continue;
        }
        const upd = await lsqUpdateLead(found.lead.prospect_id, fieldPairs);
        if (upd.ok) {
          result.filled++;
          await markPushSucceeded(leadNumber);
        } else {
          result.errors++;
          result.error_leads.push(leadNumber);
          await recordPushFailure({
            lead_number: leadNumber,
            prospect_id: found.lead.prospect_id,
            phone: found.lead.phone,
            fields: fieldPairs,
            error: upd.error ?? `LSQ ${upd.status}`,
            source: "bulk_source",
          });
        }
      } catch {
        result.errors++;
        result.error_leads.push(leadNumber);
      }
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));

  return NextResponse.json({ ok: true, ...result });
}
