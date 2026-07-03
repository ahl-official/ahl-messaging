// CRM push-failure queue. A failed Source/Sub-source push (usually an LSQ rate
// limit) is parked here and re-tried by the 2-minute heartbeat until it lands
// or gives up. The CRM settings panel reads this to show what failed + whether
// the retry pushed. Server-only.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getLsqConfig, lsqGetLeadByLeadNumber, lsqUpdateLead } from "@/lib/lsq";

export interface PushField {
  Attribute: string;
  Value: string;
}

const RETRY_DELAY_MS = 2 * 60_000; // 2 minutes between attempts
const MAX_ATTEMPTS = 6; // ~12 min of retries, then give up (status=failed)

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Park a failed push (or bump an existing row). One row per lead_number. */
export async function recordPushFailure(input: {
  lead_number: string;
  prospect_id?: string | null;
  phone?: string | null;
  first_chat_number?: string | null;
  fields: PushField[];
  error?: string | null;
  source?: string;
}): Promise<void> {
  const admin = createServiceRoleClient();
  const { data: existing } = await admin
    .from("lsq_push_failures")
    .select("attempts")
    .eq("lead_number", input.lead_number)
    .maybeSingle();
  const attempts = ((existing?.attempts as number) ?? 0) + 1;
  await admin.from("lsq_push_failures").upsert(
    {
      lead_number: input.lead_number,
      prospect_id: input.prospect_id ?? null,
      phone: input.phone ?? null,
      first_chat_number: input.first_chat_number ?? null,
      fields: input.fields,
      status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      attempts,
      last_error: input.error ?? null,
      source: input.source ?? null,
      next_retry_at: futureIso(RETRY_DELAY_MS),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "lead_number" },
  );
}

/** A push (re)succeeded — mark the row done so the panel shows it green and
 *  the retry loop stops touching it. No-op if there's no row. */
export async function markPushSucceeded(leadNumber: string): Promise<void> {
  const admin = createServiceRoleClient();
  await admin
    .from("lsq_push_failures")
    .update({ status: "pushed", pushed_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null })
    .eq("lead_number", leadNumber);
}

/** Re-attempt every due `pending` row. Sequential + spaced so the retry pass
 *  doesn't itself trip the rate limit. Returns a small summary. */
export async function processPushRetries(opts?: { limit?: number; ignoreSchedule?: boolean }): Promise<{
  attempted: number;
  pushed: number;
  still_failing: number;
}> {
  const cfg = getLsqConfig();
  if (!cfg.configured) return { attempted: 0, pushed: 0, still_failing: 0 };

  const admin = createServiceRoleClient();
  let q = admin
    .from("lsq_push_failures")
    .select("id, lead_number, prospect_id, fields, attempts")
    .eq("status", "pending")
    .order("next_retry_at", { ascending: true })
    .limit(opts?.limit ?? 25);
  if (!opts?.ignoreSchedule) q = q.lte("next_retry_at", new Date().toISOString());
  const { data: rows } = await q;
  if (!rows || rows.length === 0) return { attempted: 0, pushed: 0, still_failing: 0 };

  let pushed = 0;
  let stillFailing = 0;
  for (const row of rows) {
    const leadNumber = row.lead_number as string;
    const fields = (Array.isArray(row.fields) ? row.fields : []) as PushField[];
    let prospectId = (row.prospect_id as string | null) ?? null;
    try {
      // Re-resolve the prospect id if we never captured it (e.g. the original
      // failure was on the lookup, not the update).
      if (!prospectId) {
        const found = await lsqGetLeadByLeadNumber(leadNumber, cfg);
        if (found.ok && found.found && found.lead?.prospect_id) {
          prospectId = found.lead.prospect_id;
          // Only fill when still blank — never overwrite a real attribution.
          if ((found.lead.source ?? "").trim()) {
            await markPushSucceeded(leadNumber); // already has a source elsewhere
            pushed++;
            continue;
          }
        }
      }
      if (!prospectId || fields.length === 0) {
        await bumpFailure(admin, row.id as string, (row.attempts as number) ?? 0, "no prospect/fields");
        stillFailing++;
        continue;
      }
      const upd = await lsqUpdateLead(prospectId, fields);
      if (upd.ok) {
        await admin
          .from("lsq_push_failures")
          .update({ status: "pushed", prospect_id: prospectId, pushed_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null })
          .eq("id", row.id as string);
        pushed++;
      } else {
        await bumpFailure(admin, row.id as string, (row.attempts as number) ?? 0, upd.error ?? "update failed", prospectId);
        stillFailing++;
      }
    } catch (e) {
      await bumpFailure(admin, row.id as string, (row.attempts as number) ?? 0, e instanceof Error ? e.message : "retry error", prospectId);
      stillFailing++;
    }
  }
  return { attempted: rows.length, pushed, still_failing: stillFailing };
}

async function bumpFailure(
  admin: ReturnType<typeof createServiceRoleClient>,
  id: string,
  attempts: number,
  error: string,
  prospectId?: string | null,
): Promise<void> {
  const next = attempts + 1;
  await admin
    .from("lsq_push_failures")
    .update({
      attempts: next,
      status: next >= MAX_ATTEMPTS ? "failed" : "pending",
      last_error: error,
      ...(prospectId ? { prospect_id: prospectId } : {}),
      next_retry_at: futureIso(RETRY_DELAY_MS),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}
