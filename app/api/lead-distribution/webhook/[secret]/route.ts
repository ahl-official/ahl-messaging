// POST /api/lead-distribution/webhook/<secret>
//
// LSQ pushes leads here (configure under Lead Distribution → Webhook URL).
// Phase 1: authenticate by secret, parse the lead, and record it. Phase 2
// adds the distribution engine (working hours → region → agent pick → LSQ
// verify → assign). GET returns 200 so LSQ's "test" probe passes.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ingestDistributionLead } from "@/lib/lead-distribution";
import { parseLsqWebhookPayload } from "@/lib/lsq-webhook";
import { runLeadAutomations } from "@/lib/lead-automation-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authed(secret: string): Promise<boolean> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("lead_distribution_config")
    .select("webhook_secret, enabled")
    .eq("id", true)
    .maybeSingle();
  return !!data?.webhook_secret && data.webhook_secret === secret;
}

export async function GET(_req: NextRequest, { params }: { params: { secret: string } }) {
  if (!(await authed(params.secret))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, message: "Lead distribution webhook is live" });
}

export async function POST(request: NextRequest, { params }: { params: { secret: string } }) {
  if (!(await authed(params.secret))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const raw = await request.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = Object.fromEntries(new URLSearchParams(raw));
  }

  // Record + assign (deduped by ProspectID; respects enabled + working hours).
  // Best-effort — a failure must never 500 the webhook back to LSQ.
  let result = null;
  try {
    result = await ingestDistributionLead(payload);
  } catch (e) {
    console.warn("[lead-distribution] ingest failed:", e instanceof Error ? e.message : e);
  }

  // Also run published Lead Automations (dedup prevents a double-send if the
  // LSQ integration webhook delivers the same event too).
  try {
    await runLeadAutomations(parseLsqWebhookPayload(payload));
  } catch (e) {
    console.warn("[lead-distribution] lead automations failed:", e instanceof Error ? e.message : e);
  }
  return NextResponse.json({
    ok: true,
    received: true,
    category: result?.category ?? null,
    assigned_to: result?.outcome?.status === "assigned" ? result.outcome.agent_email : null,
    status: result?.outcome?.status ?? "pending",
  });
}
