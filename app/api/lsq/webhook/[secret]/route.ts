// LSQ → dashboard webhook receiver.
//
//   POST /api/lsq/webhook/<secret>
//
// The secret sits in the path so LSQ only needs a static URL. Configure
// the URL under Settings → Data → CRM. Any CRM lead/activity
// push lands here; we mirror the lead's stage/owner/number onto the
// matching contact row(s) so the inbox reflects it in real time (the
// dashboard already subscribes to `contacts` via Supabase Realtime).
//
// GET returns 200 so LSQ's "test webhook" probe succeeds.

import { NextResponse, type NextRequest } from "next/server";
import {
  findLsqWebhookBySecret,
  recordLsqWebhookHit,
  parseLsqWebhookPayload,
  applyLsqLeadToContacts,
} from "@/lib/lsq-webhook";
import { enrollDripsForLead } from "@/lib/drip";
import { recordSeenFieldValues } from "@/lib/lsq-field-suggestions";
import { ingestDistributionLead } from "@/lib/lead-distribution";
import { runLeadAutomations } from "@/lib/lead-automation-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(secret: string): Promise<boolean> {
  return (await findLsqWebhookBySecret(secret)) !== null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { secret: string } },
) {
  if (!(await authorize(params.secret))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, message: "CRM webhook is live" });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { secret: string } },
) {
  if (!(await authorize(params.secret))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await request.text();
  // Stamp the hit first — even an unparseable body proves LSQ reached
  // us, which is what the "Connected" indicator in Settings reflects.
  await recordLsqWebhookHit(params.secret, rawBody);

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    // LSQ can also POST form-encoded — try that before giving up.
    payload = Object.fromEntries(new URLSearchParams(rawBody));
  }

  const lead = parseLsqWebhookPayload(payload);
  const updated = await applyLsqLeadToContacts(lead);
  // Learn the field values that ride along on this lead (Sub source, City,
  // Source Medium… have no master dropdown in LSQ) for the drip value picker.
  void recordSeenFieldValues(lead.fields);
  // Live drip trigger — enroll matching contacts (stage + optional source).
  let enrolled = 0;
  try {
    enrolled = await enrollDripsForLead(lead);
  } catch (e) {
    console.warn("[lsq-webhook] drip enroll failed:", e instanceof Error ? e.message : e);
  }

  // Also feed Lead Distribution — so leads on THIS webhook show up there and
  // get assigned (deduped by ProspectID; no-op when distribution is disabled).
  try {
    if (payload && typeof payload === "object") {
      await ingestDistributionLead(payload as Record<string, unknown>);
    }
  } catch (e) {
    console.warn("[lsq-webhook] distribution ingest failed:", e instanceof Error ? e.message : e);
  }

  // Run published Lead Automations — match the trigger stage, evaluate the
  // flow's If/Else, and fire actions (e.g. send a WhatsApp template).
  try {
    await runLeadAutomations(lead);
  } catch (e) {
    console.warn("[lsq-webhook] lead automations failed:", e instanceof Error ? e.message : e);
  }

  // Always 200 — a non-2xx makes LSQ retry/disable the webhook. A miss
  // (lead we don't have a contact for) is normal, not an error.
  return NextResponse.json({
    ok: true,
    matched_contacts: updated,
    drips_enrolled: enrolled,
    parsed: {
      mobile: lead.mobile,
      prospect_id: lead.prospect_id,
      stage: lead.stage,
      source: lead.source,
    },
  });
}
