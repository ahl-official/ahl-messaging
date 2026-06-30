// POST /api/cron/nightly-sync
//
// One nightly job that:
//   1. Backfills every Evolution (Baileys) number's message history
//      into our local DB — new contacts get created, dedupe is handled
//      by wa_message_id UNIQUE.
//   2. Syncs every un-synced contact (lsq_synced_at IS NULL) to LSQ via
//      /api/lsq/ensure-lead — links existing leads, creates new ones
//      using the per-number lead_defaults (Source / Sub Source).
//
// Scheduling model: a `*/5 * * * *` heartbeat hits this endpoint every 5
// minutes from VPS cron. The handler reads the operator-configured IST
// time from app_settings (`nightly_sync_time_ist`) and only runs when
// current IST is within ±5 min of that slot — so the job fires exactly
// once per night at the operator's chosen time, configurable from the UI
// without touching crontab.
//
// Auth: shared WEBHOOK_INTERNAL_TOKEN (Authorization Bearer or body).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import {
  getNightlySyncTime,
  getNightlySyncLastRun,
  setNightlySyncLastRun,
  setNightlySyncProgress,
  getNightlySyncProgress,
  type NightlySyncLastRun,
} from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Evolution backfill across multiple numbers can take a while; LSQ
// per-contact lookups are rate-limited at ~8/5s, so the LSQ phase is the
// real bottleneck. We cap at 9 min to stay below most Next/Vercel
// timeouts.
export const maxDuration = 540;

interface Body {
  token?: string;
  /** When true, bypass the ±5-min IST window check — used by the
   *  "Run now" button in the UI. */
  force?: boolean;
}

/** Bucket an Evolution-side failure into a short, operator-readable
 *  message — and drop the noisy "instance doesn't exist" 404s entirely
 *  (the operator already knows those numbers are dead; we don't need
 *  to scream about them every run). */
function classifyEvoError(
  instance: string,
  raw: string,
  httpStatus: number | null,
  bucket: Array<{ instance: string; error: string }>,
): void {
  const text = String(raw ?? "");
  const isGone =
    httpStatus === 404 ||
    /does not exist|instance.*not.*found|not\s*found/i.test(text);
  const isEvoPrismaBug =
    httpStatus === 500 ||
    /prismaRepository|invalid\b.*\binvocation/i.test(text);
  if (isGone) {
    console.warn(
      `[nightly-sync] skip dead instance ${instance}: ${text.slice(0, 120)}`,
    );
    return;
  }
  if (isEvoPrismaBug) {
    bucket.push({
      instance,
      error: "Evolution internal error — skipped",
    });
    return;
  }
  // Everything else: keep it short so the status blob stays readable.
  bucket.push({ instance, error: text.slice(0, 100) });
}

/** Current IST clock as HH:MM. Pure arithmetic — works even when the
 *  server TZ is UTC (the VPS default). */
function nowIstHhMm(): { hh: number; mm: number } {
  const utc = Date.now();
  const ist = new Date(utc + 5.5 * 60 * 60 * 1000);
  return { hh: ist.getUTCHours(), mm: ist.getUTCMinutes() };
}

function parseHhMm(s: string): { hh: number; mm: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

/** Absolute minute-distance between two HH:MM points on a 24h clock —
 *  shortest direction so 23:58 ↔ 00:02 = 4 min, not 1436. */
function minutesAway(
  a: { hh: number; mm: number },
  b: { hh: number; mm: number },
): number {
  const am = a.hh * 60 + a.mm;
  const bm = b.hh * 60 + b.mm;
  const diff = Math.abs(am - bm);
  return Math.min(diff, 24 * 60 - diff);
}

export async function POST(request: NextRequest) {
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    /* empty body is fine */
  }

  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set" },
      { status: 500 },
    );
  }
  const auth = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (auth !== expected && body.token !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const force = body.force === true;
  const configured = await getNightlySyncTime();
  if (!configured) {
    return NextResponse.json({ ok: true, skipped: "not_configured" });
  }
  const target = parseHhMm(configured);
  if (!target) {
    return NextResponse.json({ ok: true, skipped: "bad_time_format" });
  }

  if (!force) {
    const now = nowIstHhMm();
    const away = minutesAway(now, target);
    // ±5 min window matches the heartbeat cadence. Since the
    // instrumentation timer fires every minute, the window may
    // span 5-6 heartbeats — the last-run dedupe below stops repeats.
    if (away > 5) {
      return NextResponse.json({
        ok: true,
        skipped: "outside_window",
        now_ist: `${String(now.hh).padStart(2, "0")}:${String(now.mm).padStart(2, "0")}`,
        target_ist: configured,
        minutes_away: away,
      });
    }

    // Idempotency with auto-retry on errors:
    //   - status='success' within 6 h → already done, skip.
    //   - status='error' within 30 min → retry mode. Heartbeat enters
    //     the loop again, but the per-instance skip below ensures we
    //     ONLY re-attempt instances that failed last time.
    //   - status='error' older than 30 min → give up; wait for the
    //     next scheduled slot (avoids hammering Evolution all night
    //     when their server is genuinely down).
    const lastRun = await getNightlySyncLastRun();
    if (lastRun) {
      const ageMs = Date.now() - Date.parse(lastRun.last_run_at);
      const isSuccess = lastRun.status === "success";
      const isError = lastRun.status === "error";
      if (isSuccess && ageMs < 6 * 60 * 60 * 1000) {
        return NextResponse.json({
          ok: true,
          skipped: "already_ran_today",
          last_run_at: lastRun.last_run_at,
          age_minutes: Math.round(ageMs / 60_000),
        });
      }
      if (isError && ageMs > 30 * 60 * 1000 && ageMs < 6 * 60 * 60 * 1000) {
        return NextResponse.json({
          ok: true,
          skipped: "retry_window_expired",
          last_run_at: lastRun.last_run_at,
          age_minutes: Math.round(ageMs / 60_000),
        });
      }
      // success outside 6 h or error within 30 min → fall through and run.
    }
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const admin = createServiceRoleClient();
  const startedAt = new Date().toISOString();

  // ----- Phase 1: Evolution backfill (every active Evolution number) -----
  let evolutionPages = 0;
  let evolutionIngested = 0;
  const evolutionErrors: Array<{ instance: string; error: string }> = [];

  const { data: evoNumbers } = await admin
    .from("business_numbers")
    .select("phone_number_id, evolution_instance_name, is_active")
    .eq("provider", "evolution")
    .not("evolution_instance_name", "is", null);

  const activeEvoInstances = (evoNumbers ?? []).filter(
    (n) => n.is_active !== false && n.evolution_instance_name,
  );

  // Decide whether this is a FRESH slot (clear the completed list) or
  // a RETRY pass (preserve it so we only hit instances that haven't
  // finished yet). Retry-pass = previous run was 'error' AND we're
  // still inside the same nightly window. Anything else = fresh.
  const prevRun = await getNightlySyncLastRun();
  const prevProgress = await getNightlySyncProgress();
  const isRetryPass =
    !!prevRun &&
    prevRun.status === "error" &&
    Date.now() - Date.parse(prevRun.last_run_at) < 30 * 60 * 1000;
  const alreadyCompleted: string[] = isRetryPass
    ? prevProgress.completed_instances ?? []
    : [];

  const pendingInstances = activeEvoInstances.filter(
    (n) =>
      !alreadyCompleted.includes(n.evolution_instance_name as string),
  );

  await setNightlySyncProgress({
    phase: "evolution",
    started_at: startedAt,
    evo_total: activeEvoInstances.length,
    evo_done: alreadyCompleted.length,
    evo_current: null,
    evo_ingested: 0,
    lsq_total: 0,
    lsq_done: 0,
    lsq_matched: 0,
    message: isRetryPass
      ? `Retrying ${pendingInstances.length} of ${activeEvoInstances.length} unofficial numbers (others done)…`
      : `Syncing ${activeEvoInstances.length} unofficial numbers…`,
    completed_instances: alreadyCompleted,
    // Fresh run = clear any leftover cancel flag from a previous slot.
    requested_cancel: false,
  });

  let cancelled = false;

  for (const n of pendingInstances) {
    // Check before starting each instance — cancel takes effect at the
    // next instance boundary (in-flight one finishes its current page).
    if ((await getNightlySyncProgress()).requested_cancel) {
      cancelled = true;
      break;
    }
    const instance = n.evolution_instance_name as string;
    await setNightlySyncProgress({
      evo_current: instance,
      message: `Pulling history from ${instance}…`,
    });
    let instanceOk = false;
    try {
      const res = await fetch(
        `${origin}/api/evolution/instances/${encodeURIComponent(instance)}/sync-history`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${expected}`,
          },
        },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        pages_fetched?: number;
        ingested?: number;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        const raw = json.error ?? `HTTP ${res.status}`;
        classifyEvoError(instance, raw, res.status, evolutionErrors);
      } else {
        evolutionPages += json.pages_fetched ?? 0;
        evolutionIngested += json.ingested ?? 0;
        instanceOk = true;
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : "fetch failed";
      classifyEvoError(instance, raw, null, evolutionErrors);
    }
    const cur = await getNightlySyncProgress();
    const nextCompleted = instanceOk
      ? Array.from(new Set([...(cur.completed_instances ?? []), instance]))
      : cur.completed_instances ?? [];
    await setNightlySyncProgress({
      evo_done: cur.evo_done + 1,
      evo_ingested: evolutionIngested,
      evo_current: null,
      completed_instances: nextCompleted,
    });
  }

  // ----- Phase 2: LSQ ensure-lead for every un-synced contact -----
  // Drive it directly here (instead of POSTing to /api/lsq/backfill-new in
  // a loop) so we can keep going across pages within this single request.
  let lsqProcessed = 0;
  let lsqMatched = 0;
  const lsqErrors: string[] = [];

  // Stamp lsq_synced_at on each contact we attempt — so the next pass
  // doesn't re-process the same rows even if ensure-lead returns 502.
  const PAGE = 50;
  // Cap the per-run contact count so a 5000-contact backfill doesn't
  // exceed maxDuration. Anything left over will be picked up tomorrow
  // night (or by the manual backfill panel).
  const MAX_CONTACTS = 800;

  if (!cancelled && (await getNightlySyncProgress()).requested_cancel) {
    cancelled = true;
  }

  // Initialise LSQ phase progress with the actual remaining-count so the
  // live bar shows a proper denominator. Skip the whole phase if the
  // operator hit Stop during Phase 1.
  const { count: lsqRemaining } = await admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .is("lsq_synced_at", null);
  if (!cancelled) {
    await setNightlySyncProgress({
      phase: "lsq",
      lsq_total: Math.min(lsqRemaining ?? 0, MAX_CONTACTS),
      lsq_done: 0,
      lsq_matched: 0,
      message: `Syncing ${Math.min(lsqRemaining ?? 0, MAX_CONTACTS)} contacts to LSQ…`,
    });
  }

  while (!cancelled && lsqProcessed < MAX_CONTACTS) {
    // Cancel checkpoint between LSQ pages — operator can stop mid-batch.
    if ((await getNightlySyncProgress()).requested_cancel) {
      cancelled = true;
      break;
    }
    const { data: pending } = await admin
      .from("contacts")
      .select("id")
      .is("lsq_synced_at", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    const rows = (pending ?? []) as Array<{ id: string }>;
    if (rows.length === 0) break;

    for (const r of rows) {
      try {
        const res = await fetch(`${origin}/api/lsq/ensure-lead`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id: r.id, token: expected }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          prospect_id?: string;
          created?: boolean;
          error?: string;
        };
        if (res.ok && json.ok) {
          if (json.prospect_id) lsqMatched++;
        } else if (json.error) {
          lsqErrors.push(`${r.id}: ${json.error}`);
        }
      } catch (e) {
        lsqErrors.push(`${r.id}: ${e instanceof Error ? e.message : "fetch failed"}`);
      }
      lsqProcessed++;
      // Stamp lsq_synced_at so this contact drops out of the next page —
      // ensure-lead itself only stamps lsq_synced_at on success; on
      // error we still want to move past it tonight.
      await admin
        .from("contacts")
        .update({ lsq_synced_at: new Date().toISOString() })
        .eq("id", r.id)
        .is("lsq_synced_at", null);
      // Throttle progress writes to once per 5 contacts so we're not
      // hammering app_settings with 800 updates.
      if (lsqProcessed % 5 === 0 || lsqProcessed >= MAX_CONTACTS) {
        await setNightlySyncProgress({
          lsq_done: lsqProcessed,
          lsq_matched: lsqMatched,
        });
      }
      if (lsqProcessed >= MAX_CONTACTS) break;
    }
  }

  await setNightlySyncProgress({
    lsq_done: lsqProcessed,
    lsq_matched: lsqMatched,
  });

  const status: NightlySyncLastRun["status"] = cancelled
    ? "cancelled"
    : evolutionErrors.length > 0 || lsqErrors.length > 0
      ? "error"
      : "success";
  const summaryParts: string[] = [];
  if (cancelled) summaryParts.push("Cancelled by operator");
  summaryParts.push(
    `Evolution: ${alreadyCompleted.length + (cancelled ? 0 : pendingInstances.length)} / ${activeEvoInstances.length} numbers, ${evolutionIngested} msgs ingested`,
  );
  summaryParts.push(`LSQ: ${lsqProcessed} processed, ${lsqMatched} matched`);
  if (evolutionErrors.length > 0) {
    summaryParts.push(`evo errors: ${evolutionErrors.length}`);
  }
  if (lsqErrors.length > 0) {
    summaryParts.push(`lsq errors: ${lsqErrors.length}`);
  }

  const lastRun: NightlySyncLastRun = {
    last_run_at: startedAt,
    status,
    summary: summaryParts.join(" · "),
    evolution_pages: evolutionPages,
    evolution_ingested: evolutionIngested,
    lsq_processed: lsqProcessed,
    lsq_matched: lsqMatched,
    error:
      evolutionErrors.length + lsqErrors.length > 0
        ? [
            ...evolutionErrors.map((e) =>
              `${e.instance}: ${e.error}`.slice(0, 120),
            ),
            ...lsqErrors.map((s) => s.slice(0, 120)),
          ]
            .slice(0, 5)
            .join("\n")
        : undefined,
  };
  await setNightlySyncLastRun(lastRun);
  // Flip progress to "done" so the UI shows the final numbers, then
  // clears the bar on the next poll (the panel hides the bar when
  // phase === 'done' && started_at older than a few seconds).
  await setNightlySyncProgress({
    phase: "done",
    evo_current: null,
    message: lastRun.summary ?? null,
    requested_cancel: false,
  });

  console.log(
    `[cron/nightly-sync] ${lastRun.summary} status=${status}`,
    evolutionErrors.length > 0 ? { evolutionErrors } : "",
    lsqErrors.length > 0 ? { lsqSample: lsqErrors.slice(0, 3) } : "",
  );

  return NextResponse.json({ ok: true, ran: true, ...lastRun });
}
