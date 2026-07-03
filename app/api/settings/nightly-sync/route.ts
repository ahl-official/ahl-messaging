// GET    /api/settings/nightly-sync  → { time, last_run, progress }
// PUT    /api/settings/nightly-sync  → body { time, also_cancel? } → save
// POST   /api/settings/nightly-sync  → manually trigger a run right now
//                                      (bypasses the ±5-min window check)
// DELETE /api/settings/nightly-sync  → request cancel of an in-flight run.
//                                      Cron loop polls between iterations
//                                      and bails as soon as it sees this.
//
// Owner-only. Drives the "Nightly sync" panel in Settings → CRM.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getCredential } from "@/lib/credentials";
import {
  getNightlySyncTime,
  setNightlySyncTime,
  getNightlySyncLastRun,
  getNightlySyncProgress,
  setNightlySyncProgress,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner" && me.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [time, last_run, progress] = await Promise.all([
    getNightlySyncTime(),
    getNightlySyncLastRun(),
    getNightlySyncProgress(),
  ]);
  return NextResponse.json(
    { time, last_run, progress },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  let body: { time?: string | null; also_cancel?: boolean };
  try {
    body = (await request.json()) as { time?: string | null; also_cancel?: boolean };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  try {
    await setNightlySyncTime(body.time ?? null);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 400 },
    );
  }
  // Disable click can ALSO request cancel of any in-flight run.
  if (body.also_cancel) {
    const cur = await getNightlySyncProgress();
    if (cur.phase === "evolution" || cur.phase === "lsq") {
      await setNightlySyncProgress({ requested_cancel: true });
    }
  }
  const time = await getNightlySyncTime();
  return NextResponse.json({ ok: true, time });
}

export async function DELETE() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const cur = await getNightlySyncProgress();
  if (cur.phase !== "evolution" && cur.phase !== "lsq") {
    return NextResponse.json({ ok: true, skipped: "nothing_running" });
  }
  await setNightlySyncProgress({
    requested_cancel: true,
    message: "Cancel requested — finishing current step…",
  });
  return NextResponse.json({ ok: true });
}

export async function POST() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const token = await getCredential("webhook_internal_token");
  if (!token) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set" },
      { status: 500 },
    );
  }
  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  // Fire-and-forget — the actual run can take minutes; we return
  // immediately and the UI polls GET to see when last_run updates.
  void fetch(`${origin}/api/cron/nightly-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, force: true }),
  }).catch((e) => {
    console.warn(
      "[settings/nightly-sync] manual trigger failed:",
      e instanceof Error ? e.message : e,
    );
  });
  return NextResponse.json({ ok: true, triggered: true });
}
