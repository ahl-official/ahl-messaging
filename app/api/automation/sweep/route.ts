// POST /api/automation/sweep
//
// Periodic "did anyone slip through the cracks?" sweep. Bot pauses when
// a human is typing or just replied — that's correct UX. But if the
// customer sends a message DURING the pause and no human follows up,
// the bot would silently leave them hanging once the pause expires.
//
// This route fixes that. It scans contacts where:
//   1. Auto-reply is configured + enabled for the contact's number
//   2. The most-recent message is inbound (i.e. customer is waiting)
//   3. That inbound is between 30 seconds and 24 hours old (not too
//      fresh — the human still has time; not too old — don't dig up
//      ancient unanswered chats)
//   4. The takeover pause has expired (no recent typing, no recent
//      human reply within human_takeover_minutes)
//   5. Automation hasn't already replied to this message — we check
//      automation_logs by trigger_message_id to avoid double-fires
//      across overlapping sweeps.
//
// For each match, fires runAutomation. Sequential to keep DB load
// predictable.
//
// Auth: shared secret from WEBHOOK_INTERNAL_TOKEN, same handshake the
// inbound webhook uses to call /api/automation/process. In production,
// Vercel Cron passes the same token in an Authorization header.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { runAutomation, AI_SENDER_EMAIL } from "@/lib/automation";

export const runtime = "nodejs";
// Run sequentially up to ~60s so the periodic call doesn't spawn
// overlapping work or stress the OpenAI quota.
export const maxDuration = 60;

interface MessageRow {
  id: string;
  contact_id: string;
  direction: "inbound" | "outbound";
  timestamp: string;
  sent_by_email: string | null;
}

interface ContactRow {
  id: string;
  business_phone_number_id: string | null;
  last_human_typing_at: string | null;
  last_message_at: string | null;
}

interface ConfigRow {
  business_phone_number_id: string;
  enabled: boolean;
  human_takeover_minutes: number;
}

// Sweep is the SAFETY NET for inbounds that slipped past the debounced
// /api/automation/process-pending worker (e.g. human-takeover pause
// expired with no new inbound). Anything fresh enough to still be in
// the debounce/LLM window is owned by process-pending — racing it
// causes double replies. Push the freshness guard well past a normal
// debounce + LLM round-trip (120s debounce cap + ~30s processing).
const FRESH_GUARD_MS = 3 * 60_000;       // wait at least 3 min before stepping in
const STALE_CUTOFF_MS = 24 * 60 * 60 * 1000; // ignore inbounds older than 24h

interface SweepResult {
  ok: boolean;
  scanned: number;
  triggered: number;
  results: Array<{ contact_id: string; status: string; reason?: string }>;
  error?: string;
}

async function authorize(request: NextRequest): Promise<{ ok: boolean; error?: string }> {
  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return { ok: false, error: "WEBHOOK_INTERNAL_TOKEN not set" };
  }
  // Accept the token in either an Authorization header (Vercel Cron) or a
  // JSON body (manual trigger from a dev script).
  const auth = request.headers.get("authorization");
  if (auth) {
    const value = auth.replace(/^Bearer\s+/i, "").trim();
    if (value === expected) return { ok: true };
  }
  try {
    const body = await request.clone().json().catch(() => null) as { token?: string } | null;
    if (body?.token === expected) return { ok: true };
  } catch {
    // ignore — auth header check above is the canonical path
  }
  return { ok: false, error: "Forbidden" };
}

export async function POST(request: NextRequest): Promise<NextResponse<SweepResult>> {
  const auth = await authorize(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, scanned: 0, triggered: 0, results: [], error: auth.error },
      { status: 403 },
    );
  }

  const admin = createServiceRoleClient();
  const now = Date.now();
  const staleCutoffIso = new Date(now - STALE_CUTOFF_MS).toISOString();

  // Pull configs once — we need takeover_minutes per number to compute
  // the pause window for each contact.
  const { data: configs } = await admin
    .from("automation_configs")
    .select("business_phone_number_id, enabled, human_takeover_minutes")
    .eq("enabled", true);
  const cfgMap = new Map<string, ConfigRow>();
  for (const c of (configs ?? []) as ConfigRow[]) {
    cfgMap.set(c.business_phone_number_id, c);
  }
  if (cfgMap.size === 0) {
    return NextResponse.json({ ok: true, scanned: 0, triggered: 0, results: [] });
  }

  // Pull contacts whose last message is recent enough to be worth
  // checking. Cap to a few hundred per sweep — anything older falls
  // outside the stale cutoff anyway.
  //
  // Critically: skip contacts where automation_pending_at is set — those
  // are owned by /api/automation/process-pending and double-firing
  // through sweep was the source of duplicate AI replies.
  const { data: contacts, error } = await admin
    .from("contacts")
    .select("id, business_phone_number_id, last_human_typing_at, last_message_at")
    .gte("last_message_at", staleCutoffIso)
    .is("automation_pending_at", null)
    .order("last_message_at", { ascending: false })
    .limit(500);
  if (error) {
    return NextResponse.json(
      { ok: false, scanned: 0, triggered: 0, results: [], error: error.message },
      { status: 500 },
    );
  }

  const results: SweepResult["results"] = [];
  let triggered = 0;
  let scanned = 0;

  for (const c of (contacts ?? []) as ContactRow[]) {
    scanned++;
    if (!c.business_phone_number_id) continue;
    const cfg = cfgMap.get(c.business_phone_number_id);
    if (!cfg) continue;

    // Fetch the most recent message for this contact. Cheap because of
    // the (contact_id, timestamp) index.
    const { data: latestRows } = await admin
      .from("messages")
      .select("id, contact_id, direction, timestamp, sent_by_email")
      .eq("contact_id", c.id)
      .order("timestamp", { ascending: false })
      .limit(1);
    const latest = (latestRows?.[0] ?? null) as MessageRow | null;
    if (!latest) continue;
    if (latest.direction !== "inbound") continue;

    const inboundAt = Date.parse(latest.timestamp);
    if (Number.isNaN(inboundAt)) continue;
    const ageMs = now - inboundAt;
    if (ageMs < FRESH_GUARD_MS) continue;     // human still has time
    if (ageMs > STALE_CUTOFF_MS) continue;    // too old

    // Pause guard — typing.
    if (c.last_human_typing_at) {
      const typingAt = Date.parse(c.last_human_typing_at);
      if (!Number.isNaN(typingAt) && now - typingAt < cfg.human_takeover_minutes * 60_000) {
        continue;
      }
    }
    // Pause guard — recent human reply (any outbound NOT from the AI
    // sentinel within the takeover window).
    const cutoffIso = new Date(now - cfg.human_takeover_minutes * 60_000).toISOString();
    const { data: humanReplies } = await admin
      .from("messages")
      .select("id, sent_by_email, timestamp")
      .eq("contact_id", c.id)
      .eq("direction", "outbound")
      .gt("timestamp", cutoffIso)
      .neq("sent_by_email", AI_SENDER_EMAIL)
      .limit(1);
    if (humanReplies && humanReplies.length > 0) continue;

    // Already-handled guard — has automation_logs already processed
    // this exact trigger message? Avoids a sweep firing twice on the
    // same inbound when two cron ticks overlap.
    const { data: priorLogs } = await admin
      .from("automation_logs")
      .select("id, status")
      .eq("trigger_message_id", latest.id)
      .in("status", ["success", "failed"])
      .limit(1);
    if (priorLogs && priorLogs.length > 0) continue;

    // All gates passed — fire the bot. We `await` so a single tick
    // doesn't blow past the maxDuration budget by spawning many
    // concurrent OpenAI calls.
    const result = await runAutomation({
      contactId: c.id,
      triggerMessageId: latest.id,
    });
    triggered++;
    results.push({
      contact_id: c.id,
      status: result.status,
      reason:
        result.status === "skipped"
          ? result.reason
          : result.status === "failed"
            ? result.error
            : undefined,
    });
  }

  return NextResponse.json({ ok: true, scanned, triggered, results });
}
