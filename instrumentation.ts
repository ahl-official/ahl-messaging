// Next.js instrumentation hook — runs once when the server boots, both
// in dev and production. We use it to spin up a tiny in-process
// scheduler that fires the "sweep paused chats" job every 30 seconds.
//
// In production on Vercel, you'll want to switch to Vercel Cron for
// reliability (the in-process timer doesn't survive function cold-
// starts on serverless platforms). On Vercel, add a vercel.json entry:
//
//     { "crons": [{ "path": "/api/cron/sweep", "schedule": "*/1 * * * *" }] }
//
// On a long-running Node server (or local dev), this in-process timer
// works just fine and saves the operator from setting up an external
// scheduler.

const SWEEP_EVERY_MS = 30_000;
const PROFILE_PIC_EVERY_MS = 5 * 60_000;
// Nightly-sync heartbeat fires every minute; the endpoint itself
// no-ops unless the current IST minute matches the configured slot.
const NIGHTLY_EVERY_MS = 60_000;
// Recurring (dynamic) campaigns — the job itself runs each campaign at most
// once per IST day, so a 30-min heartbeat is plenty.
const RECURRING_EVERY_MS = 30 * 60_000;
// LSQ lead-data refresh — churns through linked contacts (oldest-synced first)
// to keep cached lead number / stage / owner current for search. Gentle cadence
// (every 15 min, small batch) so it doesn't eat the interactive LSQ rate budget.
const LSQ_REFRESH_EVERY_MS = 15 * 60_000;
// Retry parked LSQ Source/Sub-source pushes (rate-limit failures). The queue
// schedules each row 2 min out, so a 2-min heartbeat lines up with that.
const LSQ_PUSH_RETRY_EVERY_MS = 2 * 60_000;
const GLOBAL_KEY = "__qht_sweep_timer__";
const PROFILE_PIC_TIMER_KEY = "__qht_profile_pic_timer__";
const NIGHTLY_TIMER_KEY = "__qht_nightly_sync_timer__";
const RECURRING_TIMER_KEY = "__qht_recurring_timer__";
const LSQ_REFRESH_TIMER_KEY = "__qht_lsq_refresh_timer__";
const LSQ_PUSH_RETRY_TIMER_KEY = "__qht_lsq_push_retry_timer__";

// Cast process to a record so we can stash the timer handle without
// adding a new global. Avoids duplicate timers across Next.js HMR
// reloads in dev — register() can be called multiple times.
type GlobalWithTimer = typeof globalThis & {
  [GLOBAL_KEY]?: NodeJS.Timeout;
  [PROFILE_PIC_TIMER_KEY]?: NodeJS.Timeout;
  [NIGHTLY_TIMER_KEY]?: NodeJS.Timeout;
  [RECURRING_TIMER_KEY]?: NodeJS.Timeout;
  [LSQ_REFRESH_TIMER_KEY]?: NodeJS.Timeout;
  [LSQ_PUSH_RETRY_TIMER_KEY]?: NodeJS.Timeout;
};

export async function register() {
  // Edge runtime instances don't have access to setInterval-as-Node-timer
  // and shouldn't run our DB-backed sweep anyway.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // PM2 cluster mode runs N copies of this process — without this
  // gate, the in-process scheduler fires N times every 30 seconds and
  // hammers the DB with duplicate sweep / campaign / profile-pic
  // queries (the immediate cause of dashboard slowness on a multi-
  // core deploy). PM2 sets NODE_APP_INSTANCE to "0", "1", ... per
  // worker; we let ONLY worker 0 run the cron loops. Fork-mode + dev
  // don't set the env var, so they still run normally.
  const pmInstance = process.env.NODE_APP_INSTANCE;
  if (pmInstance !== undefined && pmInstance !== "0") {
    console.log(
      `[sweep] PM2 worker ${pmInstance} — scheduler skipped (worker 0 owns the crons)`,
    );
    return;
  }

  const g = globalThis as GlobalWithTimer;
  if (g[GLOBAL_KEY]) return; // already scheduled

  const token = (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
  if (!token) {
    console.warn(
      "[sweep] WEBHOOK_INTERNAL_TOKEN not set — skipping in-process sweep scheduler. AI auto-reply will only fire on inbound webhooks, not on resume-from-pause.",
    );
    return;
  }

  // The in-process scheduler calls its OWN server, so it must hit localhost —
  // NOT NEXT_PUBLIC_APP_URL. That env is the PUBLIC URL; on a dev box it's set
  // to the prod domain, which would make local ticks fire against prod (wrong
  // server → 500s). INTERNAL_TICK_BASE can override for unusual setups.
  const origin =
    process.env.INTERNAL_TICK_BASE || `http://127.0.0.1:${process.env.PORT || "3000"}`;

  async function tick() {
    try {
      const res = await fetch(`${origin}/api/automation/sweep`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        console.warn(`[sweep] HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { triggered?: number; scanned?: number };
      if (json.triggered && json.triggered > 0) {
        console.log(
          `[sweep] scanned=${json.scanned} triggered=${json.triggered}`,
        );
      }
    } catch (e) {
      console.warn("[sweep] tick failed:", e instanceof Error ? e.message : e);
    }
  }

  // Campaign worker tick — separate fetch so a slow campaign send
  // doesn't block the resume-from-pause sweep, and a sweep failure
  // doesn't tank the campaign worker.
  async function campaignTick() {
    try {
      const res = await fetch(`${origin}/api/campaigns/tick`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        console.warn(`[campaign-tick] HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as {
        scanned?: number;
        sent?: number;
        failed?: number;
      };
      if (json.sent || json.failed) {
        console.log(
          `[campaign-tick] scanned=${json.scanned} sent=${json.sent} failed=${json.failed}`,
        );
      }
    } catch (e) {
      console.warn(
        "[campaign-tick] tick failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Lead-distribution tick — drains the off-hours pending queue, assigning
  // queued leads to agents once the working window opens.
  async function leadDistTick() {
    try {
      const res = await fetch(`${origin}/api/lead-distribution/tick`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        console.warn(`[lead-dist-tick] HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { assigned?: number; scanned?: number };
      if (json.assigned) console.log(`[lead-dist-tick] assigned=${json.assigned} scanned=${json.scanned}`);
    } catch (e) {
      console.warn("[lead-dist-tick] tick failed:", e instanceof Error ? e.message : e);
    }
  }

  // Drip worker tick — drains due drip runs (LSQ lead-event sequences).
  async function dripTick() {
    try {
      const res = await fetch(`${origin}/api/drips/tick`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        console.warn(`[drip-tick] HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { sent?: number; failed?: number; stopped?: number };
      if (json.sent || json.failed || json.stopped) {
        console.log(`[drip-tick] sent=${json.sent} failed=${json.failed} stopped=${json.stopped}`);
      }
    } catch (e) {
      console.warn("[drip-tick] tick failed:", e instanceof Error ? e.message : e);
    }
  }

  // Recurring (dynamic) campaign daily job — pulls rolling-window LSQ leads
  // and sends the template to NEW matches (each campaign runs once per IST day).
  async function recurringTick() {
    try {
      const res = await fetch(`${origin}/api/recurring/tick`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        console.warn(`[recurring-tick] HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { ran?: number; sent?: number };
      if (json.ran || json.sent) console.log(`[recurring-tick] ran=${json.ran} sent=${json.sent}`);
    } catch (e) {
      console.warn("[recurring-tick] tick failed:", e instanceof Error ? e.message : e);
    }
  }

  // Trigger-flow timeout worker — resumes "Wait for reply" / delay nodes
  // whose timeout has elapsed (fires the node's "timeout" branch).
  async function triggersTick() {
    try {
      const res = await fetch(`${origin}/api/triggers/tick`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        console.warn(`[triggers-tick] HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { resumed?: number };
      if (json.resumed) console.log(`[triggers-tick] resumed=${json.resumed}`);
    } catch (e) {
      console.warn("[triggers-tick] tick failed:", e instanceof Error ? e.message : e);
    }
  }

  // Profile pic backfiller — every 5 minutes, picks the 5 oldest-
  // checked numbers with no cached profile pic, tries Meta directly,
  // falls back to a Baileys instance. Cron pacing keeps WhatsApp's
  // anti-spam from flagging the Evolution proxy on bulk lookups.
  async function profilePicTick() {
    try {
      const res = await fetch(
        `${origin}/api/business-numbers/profile-pic-cron`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        console.warn(`[profile-pic-cron] HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as {
        checked?: number;
        updated?: number;
      };
      if (json.checked || json.updated) {
        console.log(
          `[profile-pic-cron] checked=${json.checked} updated=${json.updated}`,
        );
      }
    } catch (e) {
      console.warn(
        "[profile-pic-cron] tick failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Nightly Evolution → LSQ sync heartbeat. The endpoint itself reads
  // the configured IST clock time from app_settings and only fires the
  // job when current IST is within ±5 min of it — so this minute-by-
  // minute tick is cheap (one DB read + an early return) until the slot
  // arrives. Means the operator can set the time from the UI without
  // touching crontab.
  async function nightlyTick() {
    try {
      const res = await fetch(`${origin}/api/cron/nightly-sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        ran?: boolean;
        skipped?: string;
        summary?: string;
      };
      if (json.ran) {
        console.log(`[nightly-sync] fired — ${json.summary ?? "ok"}`);
      }
    } catch (e) {
      console.warn(
        "[nightly-sync] tick failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // LSQ lead-data refresh — keeps each linked contact's cached lead number /
  // stage / owner current so lead-id + name search resolves locally. The
  // endpoint processes the stalest batch and rolls the cursor forward.
  async function lsqRefreshTick() {
    try {
      const res = await fetch(`${origin}/api/cron/lsq-refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { refreshed?: number; processed?: number };
      if (json.processed) console.log(`[lsq-refresh] ${json.refreshed ?? 0}/${json.processed} refreshed`);
    } catch (e) {
      console.warn("[lsq-refresh] tick failed:", e instanceof Error ? e.message : e);
    }
  }

  // Retry parked LSQ pushes (Source/Sub-source backfill failures) whose 2-min
  // cooldown has elapsed. The endpoint re-attempts each due row sequentially.
  async function lsqPushRetryTick() {
    try {
      const res = await fetch(`${origin}/api/cron/lsq-push-retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { attempted?: number; pushed?: number };
      if (json.attempted) console.log(`[lsq-push-retry] ${json.pushed ?? 0}/${json.attempted} pushed`);
    } catch (e) {
      console.warn("[lsq-push-retry] tick failed:", e instanceof Error ? e.message : e);
    }
  }

  // Run once shortly after boot so the first sweep happens within a
  // few seconds rather than the full 30s, then hand off to the
  // interval. Don't `await` — we don't want to block server startup.
  setTimeout(() => {
    void tick();
    void campaignTick();
    void dripTick();
    void triggersTick();
    void leadDistTick();
  }, 5_000);
  // First profile-pic pass after 60s so it doesn't pile on with the
  // initial sweep + campaign tick.
  setTimeout(() => {
    void profilePicTick();
  }, 60_000);
  // First nightly heartbeat after 30s.
  setTimeout(() => {
    void nightlyTick();
  }, 30_000);
  // First recurring-campaign pass after 90s.
  setTimeout(() => {
    void recurringTick();
  }, 90_000);
  // First LSQ-refresh pass after 120s (let boot traffic settle first).
  setTimeout(() => {
    void lsqRefreshTick();
  }, 120_000);
  // First push-retry pass after 90s.
  setTimeout(() => {
    void lsqPushRetryTick();
  }, 90_000);

  g[GLOBAL_KEY] = setInterval(() => {
    void tick();
    void campaignTick();
    void dripTick();
    void triggersTick();
    void leadDistTick();
  }, SWEEP_EVERY_MS);
  g[PROFILE_PIC_TIMER_KEY] = setInterval(() => {
    void profilePicTick();
  }, PROFILE_PIC_EVERY_MS);
  g[NIGHTLY_TIMER_KEY] = setInterval(() => {
    void nightlyTick();
  }, NIGHTLY_EVERY_MS);
  g[RECURRING_TIMER_KEY] = setInterval(() => {
    void recurringTick();
  }, RECURRING_EVERY_MS);
  g[LSQ_REFRESH_TIMER_KEY] = setInterval(() => {
    void lsqRefreshTick();
  }, LSQ_REFRESH_EVERY_MS);
  g[LSQ_PUSH_RETRY_TIMER_KEY] = setInterval(() => {
    void lsqPushRetryTick();
  }, LSQ_PUSH_RETRY_EVERY_MS);

  console.log(
    `[sweep] in-process scheduler armed — sweep+campaign every ${SWEEP_EVERY_MS / 1000}s, profile-pic refill every ${PROFILE_PIC_EVERY_MS / 1000}s, nightly-sync heartbeat every ${NIGHTLY_EVERY_MS / 1000}s`,
  );
}
