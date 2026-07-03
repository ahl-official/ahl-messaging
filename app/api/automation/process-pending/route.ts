// GET /api/automation/process-pending
//
// Worker route — meant to be hit by cron every 2-3s on the VPS. Finds
// contacts whose `automation_pending_at` has elapsed (the client's
// debounce window closed) and fires `runAutomation` for each, ONCE.
//
// Atomic claim: the UPDATE filters on `automation_pending_at <= now()`
// AND clears it in the same statement — a parallel worker that already
// claimed the row sees NULL and bails (NULL fails the `lte` filter), so
// no double-fire.
//
// Auth: same shared `webhook_internal_token` as /process. Cron command:
//   curl -fsS -X POST -H "Content-Type: application/json" \
//        -d '{"token":"'"$WEBHOOK_INTERNAL_TOKEN"'"}' \
//        https://wa.hairmedindia.com/api/automation/process-pending

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { runAutomation } from "@/lib/automation";
import { processPendingLeadAutomations } from "@/lib/lead-automation-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BATCH = 25;

async function handle(request: NextRequest) {
  // Token in body for POST, ?token= for GET — accept either to make
  // cron setup simple.
  let token: string | null = null;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { token?: string };
      token = body.token ?? null;
    } catch {
      /* allow empty body */
    }
  }
  if (!token) {
    token = request.nextUrl.searchParams.get("token");
  }
  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set" },
      { status: 500 },
    );
  }
  if (token !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Pull a small slice of due contacts. Real claim happens per-row in
  // the loop, so the WHERE here is just a candidate filter.
  const { data: due, error } = await admin
    .from("contacts")
    .select("id")
    .lte("automation_pending_at", nowIso)
    .order("automation_pending_at", { ascending: true })
    .limit(MAX_BATCH);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!due || due.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  let processed = 0;
  let skipped = 0;
  for (const row of due) {
    // CAS: only the worker whose UPDATE matched a still-armed row gets
    // to process. Setting NULL clears the trigger so no one else picks
    // this contact.
    const { data: claimed } = await admin
      .from("contacts")
      .update({ automation_pending_at: null })
      .eq("id", row.id)
      .lte("automation_pending_at", new Date().toISOString())
      .select("id");
    if (!claimed || claimed.length === 0) {
      skipped++;
      continue;
    }

    // The trigger is the latest inbound message — that's what arrived
    // last during the window. runAutomation reads the full conversation
    // context anyway, so this is just a pointer.
    const { data: lastInbound } = await admin
      .from("messages")
      .select("id")
      .eq("contact_id", row.id)
      .eq("direction", "inbound")
      .order("timestamp", { ascending: false })
      .limit(1);
    const triggerId = lastInbound?.[0]?.id as string | undefined;
    if (!triggerId) {
      skipped++;
      continue;
    }

    // Fire and forget — keep the route fast so cron stays cheap. Errors
    // inside runAutomation already log to automation_logs.
    void runAutomation({
      contactId: row.id,
      triggerMessageId: triggerId,
    }).catch((e) => {
      console.error(
        "[process-pending] runAutomation failed:",
        e instanceof Error ? e.message : e,
      );
    });
    processed++;
  }

  // Resume any due Lead Automation "Wait" continuations (send template → wait
  // → send …). Same cron cadence, so waits fire within a few seconds of due.
  let leadAutomationResumed = 0;
  try {
    leadAutomationResumed = await processPendingLeadAutomations();
  } catch (e) {
    console.warn("[process-pending] lead automation resume failed:", e instanceof Error ? e.message : e);
  }

  return NextResponse.json({ processed, skipped, leadAutomationResumed });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
