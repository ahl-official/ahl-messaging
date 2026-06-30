"use client";

// Settings → LeadSquared → "Nightly sync".
//
// Operator picks an IST clock time. A VPS cron heartbeat hits
// /api/cron/nightly-sync every 5 min; the handler fires the job only
// when current IST is within ±5 min of the configured time, so the
// nightly run lands on the operator's slot without touching crontab.
//
// While a run is in flight (cron OR manual "Run now"), this panel polls
// /api/settings/nightly-sync every 2s and shows live progress — both
// phases (Evolution number sync + LSQ contact sync) get their own bar.
// State is server-side, so refreshing the page doesn't lose progress.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Clock,
  Loader2,
  Play,
  Save as SaveIcon,
  Square,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface LastRun {
  last_run_at: string;
  status: "success" | "error" | "skipped" | "cancelled";
  summary?: string;
  evolution_pages?: number;
  evolution_ingested?: number;
  lsq_processed?: number;
  lsq_matched?: number;
  error?: string;
}

interface Progress {
  phase: "idle" | "evolution" | "lsq" | "done";
  started_at: string | null;
  evo_total: number;
  evo_done: number;
  evo_current: string | null;
  evo_ingested: number;
  lsq_total: number;
  lsq_done: number;
  lsq_matched: number;
  message: string | null;
  requested_cancel?: boolean;
}

interface NightlyPayload {
  time: string | null;
  last_run: LastRun | null;
  progress: Progress | null;
}

export function NightlySyncPanel({ configured = true }: { configured?: boolean }) {
  const [time, setTime] = useState<string>("");
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/nightly-sync", { cache: "no-store" });
      if (!res.ok) {
        setError(`Failed to load (HTTP ${res.status})`);
        return;
      }
      const j = (await res.json()) as NightlyPayload;
      setTime(j.time ?? "");
      setLastRun(j.last_run ?? null);
      setProgress(j.progress ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live poll. Whenever a run is in flight (phase = evolution | lsq), or
  // very recently finished (phase = done within the last 10s), we poll
  // every 2 s. Idle = no poll, so the panel is cheap to keep mounted.
  useEffect(() => {
    const inFlight =
      progress?.phase === "evolution" || progress?.phase === "lsq";
    const recentlyDone =
      progress?.phase === "done" &&
      progress.started_at &&
      Date.now() - new Date(progress.started_at).getTime() < 30_000;
    const shouldPoll = triggering || inFlight || recentlyDone;
    if (!shouldPoll) return;
    pollRef.current = setInterval(() => {
      void load();
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [
    triggering,
    progress?.phase,
    progress?.started_at,
    load,
  ]);

  // When a run finishes (phase flips to done), drop the spinner.
  useEffect(() => {
    if (triggering && progress?.phase === "done") setTriggering(false);
  }, [triggering, progress?.phase]);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/nightly-sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: time || null }),
      });
      const j = (await res.json()) as { ok?: boolean; time?: string; error?: string };
      if (!res.ok || !j.ok) {
        setError(j.error ?? `HTTP ${res.status}`);
      } else {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEmpty() {
    setError(null);
    setSaving(true);
    try {
      // Disable: clear the time AND cancel any in-flight run so the
      // operator actually sees the bars stop, not just the next-night
      // schedule turn off.
      await fetch("/api/settings/nightly-sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: null, also_cancel: true }),
      });
      setTime("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleStop() {
    setError(null);
    try {
      await fetch("/api/settings/nightly-sync", { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stop failed");
    }
  }

  async function handleRunNow() {
    setError(null);
    setTriggering(true);
    try {
      const res = await fetch("/api/settings/nightly-sync", { method: "POST" });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setError(j.error ?? `HTTP ${res.status}`);
        setTriggering(false);
        return;
      }
      // Polling effect picks it up — no manual interval here.
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trigger failed");
      setTriggering(false);
    }
  }

  const inFlight =
    progress?.phase === "evolution" || progress?.phase === "lsq";
  const showProgressCard =
    inFlight ||
    (progress?.phase === "done" &&
      progress.started_at &&
      Date.now() - new Date(progress.started_at).getTime() < 30_000);

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="h-4 w-4 text-violet-600" />
          Nightly sync (Evolution → LSQ)
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Runs every night at your chosen IST time in two phases. Phase 1:
          pulls every active unofficial (Baileys) number&apos;s message history
          from Evolution into our DB — new contacts get created. Phase 2:
          pushes any contact with no LSQ link (lsq_synced_at = null) to
          LSQ via the per-number Source / Sub Source defaults.
        </p>
      </header>

      <div className="space-y-4 px-5 py-4">
        {!configured ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            LSQ host / access keys aren&apos;t set — nightly sync will still pull
            Evolution history into the local DB, but the LSQ phase will skip
            until you configure them above.
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            <span className="text-muted-foreground">Run time (IST, 24-hour)</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-9 w-32 rounded-md border bg-background px-2 text-sm tabular-nums"
            />
          </label>

          <button
            onClick={handleSave}
            disabled={saving}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent",
              saving && "opacity-60",
            )}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : savedFlash ? (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <SaveIcon className="h-3.5 w-3.5" />
            )}
            {saving ? "Saving" : savedFlash ? "Saved" : "Save"}
          </button>

          <button
            onClick={handleSaveEmpty}
            disabled={saving || !time}
            className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
            title="Disable nightly sync"
          >
            Disable
          </button>

          {inFlight ? (
            <button
              onClick={handleStop}
              disabled={progress?.requested_cancel}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-xs font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-60"
            >
              {progress?.requested_cancel ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5 fill-current" />
              )}
              {progress?.requested_cancel ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              onClick={handleRunNow}
              disabled={triggering}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
            >
              {triggering ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {triggering ? "Starting…" : "Run now"}
            </button>
          )}
        </div>

        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
            <span className="inline-flex items-start gap-1.5">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </span>
          </div>
        ) : null}

        {showProgressCard && progress ? (
          <LiveProgress progress={progress} />
        ) : null}

        <div className="rounded-lg border bg-secondary/40 px-3 py-2.5 text-[11px]">
          <div className="font-semibold text-muted-foreground">Last run</div>
          {lastRun ? (
            <div className="mt-1 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="tabular-nums text-foreground">
                  {new Date(lastRun.last_run_at).toLocaleString()}
                </span>
                <StatusPill status={lastRun.status} />
              </div>
              {lastRun.summary ? (
                <div className="text-muted-foreground">{lastRun.summary}</div>
              ) : null}
              {lastRun.error ? (
                <div className="whitespace-pre-line text-rose-700">
                  Errors:{"\n"}
                  {lastRun.error}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-1 text-muted-foreground">
              No run recorded yet — hit &ldquo;Run now&rdquo; to test.
            </div>
          )}
        </div>

        <details className="rounded-lg border bg-background px-3 py-2 text-[11px]">
          <summary className="cursor-pointer font-semibold text-muted-foreground">
            How unofficial-number sync works
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
            <li>
              For every business number where{" "}
              <span className="font-mono">provider = &apos;evolution&apos;</span> and{" "}
              <span className="font-mono">is_active</span> is true, we POST to{" "}
              <span className="font-mono">
                /api/evolution/instances/[name]/sync-history
              </span>{" "}
              with the internal token.
            </li>
            <li>
              That endpoint pulls messages straight from Evolution&apos;s own DB
              (paginated, 1000 per page, 3 pages in parallel), bulk-upserts
              contacts and messages into our DB, then flushes{" "}
              <span className="font-mono">last_message_*</span> per contact.
            </li>
            <li>
              Dedup is automatic — <span className="font-mono">wa_message_id</span> is
              UNIQUE, so re-running is safe.
            </li>
            <li>
              Any new contacts created above get picked up by Phase 2 (LSQ)
              because their <span className="font-mono">lsq_synced_at</span> is
              still null.
            </li>
          </ol>
        </details>

        <details className="rounded-lg border bg-background px-3 py-2 text-[11px]">
          <summary className="cursor-pointer font-semibold text-muted-foreground">
            VPS cron setup (one-time)
          </summary>
          <div className="mt-2 space-y-1.5 text-muted-foreground">
            <p>
              Add this line to crontab on the VPS — it pings the endpoint every
              5 minutes; the handler runs the job only when current IST matches
              the time you set above.
            </p>
            <pre className="overflow-x-auto rounded bg-foreground/5 px-2 py-1.5 text-[10.5px]">
              {`*/5 * * * * curl -fsS -X POST http://localhost:3000/api/cron/nightly-sync \\
  -H 'Content-Type: application/json' \\
  -d '{"token":"'"$WEBHOOK_INTERNAL_TOKEN"'"}' >/dev/null 2>&1`}
            </pre>
          </div>
        </details>
      </div>
    </section>
  );
}

function LiveProgress({ progress }: { progress: Progress }) {
  const evoPct =
    progress.evo_total > 0
      ? Math.round((progress.evo_done / progress.evo_total) * 100)
      : 0;
  const lsqPct =
    progress.lsq_total > 0
      ? Math.round((progress.lsq_done / progress.lsq_total) * 100)
      : 0;
  const isEvo = progress.phase === "evolution";
  const isLsq = progress.phase === "lsq";
  const isDone = progress.phase === "done";

  return (
    <div className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white px-4 py-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-violet-800">
        {isDone ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
        {isDone ? "Sync complete" : progress.message ?? "Syncing…"}
      </div>

      <div className="space-y-2.5">
        {/* Phase 1: Evolution */}
        <div>
          <div className="flex items-center justify-between text-[11px]">
            <span
              className={cn(
                "font-semibold",
                isEvo ? "text-violet-800" : "text-muted-foreground",
              )}
            >
              Phase 1 · Unofficial numbers{" "}
              {progress.evo_current ? (
                <span className="font-normal text-muted-foreground">
                  ({progress.evo_current})
                </span>
              ) : null}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {progress.evo_done} / {progress.evo_total} ·{" "}
              {progress.evo_ingested.toLocaleString()} msgs
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-violet-100">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                progress.evo_total === progress.evo_done && progress.evo_total > 0
                  ? "bg-emerald-500"
                  : "bg-violet-500",
              )}
              style={{ width: `${evoPct}%` }}
            />
          </div>
        </div>

        {/* Phase 2: LSQ */}
        <div>
          <div className="flex items-center justify-between text-[11px]">
            <span
              className={cn(
                "font-semibold",
                isLsq ? "text-violet-800" : "text-muted-foreground",
              )}
            >
              Phase 2 · LSQ lead sync
            </span>
            <span className="tabular-nums text-muted-foreground">
              {progress.lsq_done} / {progress.lsq_total} ·{" "}
              {progress.lsq_matched} matched
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-violet-100">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                isDone ? "bg-emerald-500" : "bg-violet-500",
              )}
              style={{ width: `${lsqPct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: LastRun["status"] }) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
        <Check className="h-3 w-3" /> Success
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
        Skipped
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
        <Square className="h-2.5 w-2.5 fill-current" /> Cancelled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
      <XCircle className="h-3 w-3" /> Error
    </span>
  );
}
