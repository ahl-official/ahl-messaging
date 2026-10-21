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
  classifyWhatsAppLead,
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
  const channel = classifyWhatsAppLead(lead);

  // WhatsApp-inbox sync only. Explicit call/walk-in/etc. payloads are
  // logged (Connected badge still ticks) but do not touch contacts /
  // funnel / drips / automations.
  if (channel === "not_whatsapp") {
    return NextResponse.json({
      ok: true,
      matched_contacts: 0,
      drips_enrolled: 0,
      skipped: "not_whatsapp",
      channel,
      parsed: {
        mobile: lead.mobile,
        mobile_last10: lead.mobile ? lead.mobile.slice(-10) : null,
        prospect_id: lead.prospect_id,
        stage: lead.stage,
        source: lead.source,
        platform: lead.platform,
      },
    });
  }

  const updated = await applyLsqLeadToContacts(lead, { whatsappOnly: true });

  // Fire secondary triggers (drips, automations, distribution) asynchronously in the background
  // so the HTTP connection returns immediately and never times out the caller (e.g. Cloud Run).
  void (async () => {
    try {
      void recordSeenFieldValues(lead.fields);
      await enrollDripsForLead(lead);
      if (payload && typeof payload === "object") {
        await ingestDistributionLead(payload as Record<string, unknown>);
      }
      await runLeadAutomations(lead);
    } catch (e) {
      console.warn("[lsq-webhook] background trigger failed:", e instanceof Error ? e.message : e);
    }
  })();

  // Always 200 — a non-2xx makes CRM retry/disable the webhook. A miss
  // (lead we don't have a WhatsApp contact for) is normal, not an error.
  return NextResponse.json({
    ok: true,
    matched_contacts: updated,
    drips_enrolled: 0,
    channel,
    parsed: {
      mobile: lead.mobile,
      mobile_last10: lead.mobile ? lead.mobile.slice(-10) : null,
      prospect_id: lead.prospect_id,
      stage: lead.stage,
      source: lead.source,
      platform: lead.platform,
    },
  });
}
