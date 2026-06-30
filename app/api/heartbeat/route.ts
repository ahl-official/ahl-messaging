// POST /api/heartbeat
//
// Called by the HeartbeatTracker every ~30s while a tab is focused.
// Updates user_activity_days for today's row, keeping:
//   • first_seen_at  (set on the first ping of the day)
//   • last_seen_at   (bumped on every ping)
//   • active_seconds (+= secondsSinceLast, capped to keep stale tabs
//                     from inflating activity time)
//   • window_seconds (last_seen - first_seen)
//
// Caller passes `secondsSinceLast` so we don't have to maintain
// server-side per-tab state; if the client missed beats (sleep, lost
// network) it can decide how much to credit.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { pingSession, SESSION_COOKIE_NAME } from "@/lib/user-sessions";

export const runtime = "nodejs";

const MAX_INTERVAL_SECONDS = 90; // anything bigger = assume idle / sleep

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Heartbeat fires from the dashboard layout which already requires
    // auth; an unauthenticated ping likely means the session just
    // ended → silent 401 keeps logs clean.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Refresh the user_sessions row alongside user_activity_days so
  // "this device last seen 2 min ago" stays accurate on the Profile +
  // Team sessions list. Fire-and-forget — failure shouldn't block
  // the activity-day update below.
  try {
    const store = await cookies();
    const sessionId = store.get(SESSION_COOKIE_NAME)?.value;
    if (sessionId) void pingSession(sessionId);
  } catch {
    /* silent */
  }
  let body: { secondsSinceLast?: number } = {};
  try {
    body = (await request.json()) as { secondsSinceLast?: number };
  } catch {
    /* empty body fine */
  }
  // Clamp the increment so a misbehaving client can't lie its way to
  // a million active seconds in a single ping.
  const incRaw = Number(body.secondsSinceLast ?? 30);
  const inc = Number.isFinite(incRaw) ? Math.max(0, Math.min(incRaw, MAX_INTERVAL_SECONDS)) : 30;

  const admin = createServiceRoleClient();
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // Fetch the existing row (if any) so we can compute new totals atomically.
  const { data: existing } = await admin
    .from("user_activity_days")
    .select("id, first_seen_at, active_seconds")
    .eq("user_id", user.id)
    .eq("day", today)
    .maybeSingle();

  if (!existing) {
    const { error } = await admin.from("user_activity_days").insert({
      user_id: user.id,
      email: user.email ?? null,
      day: today,
      first_seen_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      active_seconds: inc,
      window_seconds: 0,
    });
    if (error) {
      // Race: another tab inserted between the SELECT and INSERT —
      // fall through to the UPDATE branch.
      if (!/duplicate key|23505/.test(error.message)) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    } else {
      return NextResponse.json({ ok: true, today, active_seconds: inc });
    }
  }

  const firstSeen = existing?.first_seen_at
    ? new Date(existing.first_seen_at)
    : now;
  const windowSec = Math.max(
    0,
    Math.floor((now.getTime() - firstSeen.getTime()) / 1000),
  );
  const activeSec = (existing?.active_seconds ?? 0) + inc;
  const { error: uErr } = await admin
    .from("user_activity_days")
    .update({
      last_seen_at: now.toISOString(),
      active_seconds: activeSec,
      window_seconds: windowSec,
    })
    .eq("user_id", user.id)
    .eq("day", today);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    today,
    active_seconds: activeSec,
    window_seconds: windowSec,
  });
}
