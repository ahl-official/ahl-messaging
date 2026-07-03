"use client";

// Resumable CRM stage backfill — progress card.
//
// Drives /api/lsq/backfill, which bulk-exports CRM leads (1000 per call)
// and matches them against local contacts — a full account syncs in a
// few minutes instead of hours. The card loops POSTs until done and
// shows leads scanned + contacts updated. Resumable: progress is
// persisted server-side, so closing the tab and reopening continues.
//
// Used both on the CRM page and in Settings → Data.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Pause, Play, RotateCcw, Users } from "lucide-react";
import { cn } from "@/lib/utils";

interface BackfillStats {
  pages_done: number;
  total_pages: number;
  leads_scanned: number;
  total_leads: number;
  contacts_updated: number;
}

interface BackfillProgress {
  stats: BackfillStats;
  done: boolean;
  started: boolean;
}

export function LsqBackfillPanel({
  configured = true,
}: {
  configured?: boolean;
}) {
  const [bf, setBf] = useState<BackfillProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  // "Sync new" — per-contact sync of just the un-synced (freshly
  // imported) contacts, without re-scanning the whole LSQ export.
  const [newRemaining, setNewRemaining] = useState<number | null>(null);
  const [newStats, setNewStats] = useState({ processed: 0, matched: 0 });
  const [newRunning, setNewRunning] = useState(false);
  const newRunningRef = useRef(false);

  const loadBackfill = useCallback(async () => {
    try {
      const res = await fetch("/api/lsq/backfill", { cache: "no-store" });
      const j = (await res.json()) as BackfillProgress & { error?: string };
      if (res.ok) setBf(j);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadNewSync = useCallback(async () => {
    try {
      const res = await fetch("/api/lsq/backfill-new", { cache: "no-store" });
      const j = (await res.json()) as {
        remaining?: number;
        stats?: { processed: number; matched: number };
      };
      if (res.ok) {
        setNewRemaining(j.remaining ?? 0);
        if (j.stats) setNewStats(j.stats);
      }
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadBackfill();
    loadNewSync();
  }, [loadBackfill, loadNewSync]);

  async function runBackfill(restart: boolean) {
    setError(null);
    setRunning(true);
    runningRef.current = true;
    let first = restart;
    while (runningRef.current) {
      try {
        const res = await fetch("/api/lsq/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restart: first }),
        });
        const j = (await res.json()) as BackfillProgress & { error?: string };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        first = false;
        setBf(j);
        if (j.done) break;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Backfill failed");
        break;
      }
    }
    runningRef.current = false;
    setRunning(false);
  }

  function stopBackfill() {
    runningRef.current = false;
    setRunning(false);
  }

  async function runNewSync() {
    setError(null);
    setNewRunning(true);
    newRunningRef.current = true;
    let first = true;
    while (newRunningRef.current) {
      try {
        const res = await fetch("/api/lsq/backfill-new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reset: first }),
        });
        const j = (await res.json()) as {
          stats?: { processed: number; matched: number };
          remaining?: number;
          done?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        first = false;
        if (j.stats) setNewStats(j.stats);
        setNewRemaining(j.remaining ?? 0);
        if (j.done) break;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sync failed");
        break;
      }
    }
    newRunningRef.current = false;
    setNewRunning(false);
  }

  function stopNewSync() {
    newRunningRef.current = false;
    setNewRunning(false);
  }

  const stats = bf?.stats;
  const totalLeads = stats?.total_leads ?? 0;
  const scanned = stats?.leads_scanned ?? 0;
  const updated = stats?.contacts_updated ?? 0;
  const pct =
    totalLeads > 0
      ? Math.min(100, Math.round((scanned / totalLeads) * 100))
      : 0;

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Backfill stage on all contacts</h2>
            <p className="text-[11px] text-muted-foreground">
              Bulk-exports LSQ leads and caches stage / lead # / owner on
              matching contacts. Takes a few minutes — resumable.
            </p>
          </div>
        </div>
        {running ? (
          <button
            type="button"
            onClick={stopBackfill}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-secondary"
          >
            <Pause className="h-3.5 w-3.5" />
            Pause
          </button>
        ) : (
          <div className="flex items-center gap-2">
            {/* Started but not finished — offer a clean restart from
                page 1 (e.g. to re-pull after adding a new field). */}
            {bf?.started && !bf.done ? (
              <button
                type="button"
                onClick={() => runBackfill(true)}
                disabled={!configured}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Start over
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => runBackfill(bf?.done === true || !bf?.started)}
              disabled={!configured}
              className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
              {bf?.started && !bf.done ? "Resume" : "Sync all"}
            </button>
          </div>
        )}
      </header>

      <div className="px-5 py-3.5">
        {!configured ? (
          <p className="text-xs text-muted-foreground">
            Configure the LSQ connection above to enable backfill.
          </p>
        ) : (
          <>
            {/* Counters */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <span className="font-semibold text-foreground">
                  {updated.toLocaleString()}
                </span>
                <span className="text-muted-foreground">contacts updated</span>
              </span>
              <span className="text-muted-foreground">
                {scanned.toLocaleString()}
                {totalLeads > 0 ? ` / ${totalLeads.toLocaleString()}` : ""} LSQ
                leads scanned
              </span>
            </div>

            {/* Progress bar */}
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  bf?.done ? "bg-emerald-500" : "bg-violet-500",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 text-[11px]">
              <span className="font-semibold text-muted-foreground">{pct}%</span>
              {running ? (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Syncing — keep this tab open
                </span>
              ) : null}
              {bf?.done && !running ? (
                <span className="inline-flex items-center gap-1 font-semibold text-emerald-600">
                  <Check className="h-3.5 w-3.5" />
                  {updated.toLocaleString()} contacts synced
                </span>
              ) : null}
              {bf?.done && !running ? (
                <button
                  type="button"
                  onClick={() => runBackfill(true)}
                  className="font-semibold text-muted-foreground underline-offset-2 hover:underline"
                >
                  Run again
                </button>
              ) : null}
              {error ? <span className="text-destructive">{error}</span> : null}
            </div>

            {/* Sync new — per-contact sync of freshly imported contacts
                only, without re-scanning the whole LSQ export. */}
            <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div className="min-w-0 text-xs">
                <span className="font-semibold text-foreground">
                  New / imported contacts
                </span>
                <span className="ml-2 text-muted-foreground">
                  {newRemaining === null
                    ? "…"
                    : `${newRemaining.toLocaleString()} not synced yet`}
                </span>
                {newRunning || newStats.processed > 0 ? (
                  <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    {newRunning ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    {newStats.processed.toLocaleString()} synced ·{" "}
                    {newStats.matched.toLocaleString()} matched in LSQ
                  </span>
                ) : null}
              </div>
              {newRunning ? (
                <button
                  type="button"
                  onClick={stopNewSync}
                  className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-secondary"
                >
                  <Pause className="h-3.5 w-3.5" />
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={runNewSync}
                  disabled={running || newRemaining === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play className="h-3.5 w-3.5" />
                  Sync new
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
