// POST /api/cron/retention
//
// Nightly-ish prune of disposable logs so self-hosted Postgres + the VPS
// disk don't grow forever. Auth: WEBHOOK_INTERNAL_TOKEN.
//
// Keeps:
//   - lsq_webhook_events: last 50 rows (matches live ring-buffer)
//   - auth_attempts: last 24 hours
//   - evolution_disconnects: last 7 days
//   - automation_logs: last 60 days
//   - finished trigger_runs (+ cascaded vars): last 60 days
//
// Does NOT delete WhatsApp messages/contacts (chat history).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WEBHOOK_KEEP = 50;
const AUTH_KEEP_HOURS = 24;
const DISCONNECT_KEEP_DAYS = 7;
const LOG_KEEP_DAYS = 60;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export async function POST(request: NextRequest) {
  const expected = (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const auth = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (!expected || (auth !== expected && body.token !== expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceRoleClient();
  const deleted: Record<string, number> = {};

  // auth_attempts — 24h
  {
    const { count, error } = await admin
      .from("auth_attempts")
      .delete({ count: "exact" })
      .lt("created_at", isoHoursAgo(AUTH_KEEP_HOURS));
    if (!error) deleted.auth_attempts = count ?? 0;
  }

  // evolution_disconnects — 7d
  {
    const { count, error } = await admin
      .from("evolution_disconnects")
      .delete({ count: "exact" })
      .lt("occurred_at", isoDaysAgo(DISCONNECT_KEEP_DAYS));
    if (!error) deleted.evolution_disconnects = count ?? 0;
  }

  // automation_logs — 60d
  {
    const { count, error } = await admin
      .from("automation_logs")
      .delete({ count: "exact" })
      .lt("created_at", isoDaysAgo(LOG_KEEP_DAYS));
    if (!error) deleted.automation_logs = count ?? 0;
  }

  // lsq_webhook_events — keep newest 50
  {
    const { data: old } = await admin
      .from("lsq_webhook_events")
      .select("id")
      .order("received_at", { ascending: false })
      .range(WEBHOOK_KEEP, WEBHOOK_KEEP + 2000);
    if (old && old.length > 0) {
      const ids = old.map((r) => r.id as string);
      const { count, error } = await admin
        .from("lsq_webhook_events")
        .delete({ count: "exact" })
        .in("id", ids);
      if (!error) deleted.lsq_webhook_events = count ?? ids.length;
    } else {
      deleted.lsq_webhook_events = 0;
    }
  }

  // finished trigger runs older than 60d (vars cascade via FK)
  {
    const cutoff = isoDaysAgo(LOG_KEEP_DAYS);
    const { data: oldRuns } = await admin
      .from("trigger_runs")
      .select("id")
      .in("status", ["completed", "failed", "stopped"])
      .lt("started_at", cutoff)
      .limit(5000);
    if (oldRuns && oldRuns.length > 0) {
      const ids = oldRuns.map((r) => r.id as string);
      const { count, error } = await admin
        .from("trigger_runs")
        .delete({ count: "exact" })
        .in("id", ids);
      if (!error) deleted.trigger_runs = count ?? ids.length;
    } else {
      deleted.trigger_runs = 0;
    }
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  return NextResponse.json({
    ok: true,
    deleted,
    total,
    policy: {
      lsq_webhook_events: `keep last ${WEBHOOK_KEEP}`,
      auth_attempts: `${AUTH_KEEP_HOURS}h`,
      evolution_disconnects: `${DISCONNECT_KEEP_DAYS}d`,
      automation_logs: `${LOG_KEEP_DAYS}d`,
      trigger_runs: `finished older than ${LOG_KEEP_DAYS}d`,
    },
  });
}
