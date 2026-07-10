"use client";

// Failed CRM pushes — leads whose Source/Sub-source push hit an LSQ rate limit.
// A 2-minute heartbeat retries them automatically; this panel shows the queue
// + whether the retry eventually pushed, and offers a manual "Retry now".

import { useEffect, useState, useCallback } from "react";
import { Loader2, RefreshCcw, AlertTriangle } from "lucide-react";

interface Row {
  lead_number: string;
  first_chat_number: string | null;
  fields: Array<{ Attribute: string; Value: string }>;
  status: "pending" | "pushed" | "failed";
  attempts: number;
  last_error: string | null;
  source: string | null;
  next_retry_at: string | null;
  pushed_at: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  pushed: "bg-primary/15 text-primary",
  failed: "bg-rose-100 text-rose-700",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Retrying",
  pushed: "Pushed",
  failed: "Gave up",
};

function istTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

export function LsqPushFailuresPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/lsq/push-failures", { cache: "no-store" });
      const j = (await res.json()) as { rows?: Row[]; counts?: Record<string, number> };
      setRows(j.rows ?? []);
      setCounts(j.counts ?? {});
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Auto-refresh so operators see the heartbeat clear the queue live.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function retryNow() {
    setRetrying(true);
    try {
      await fetch("/api/lsq/push-failures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retry: true }),
      });
      await load();
    } finally {
      setRetrying(false);
    }
  }

  const pending = counts.pending ?? 0;
  const total = (rows ?? []).length;

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <div>
            <h2 className="text-sm font-semibold">Failed lead pushes</h2>
            <p className="text-[11px] text-muted-foreground">
              Source/Sub-source pushes jo LSQ rate-limit pe fail hue. Har 2 min me auto-retry hota hai —
              yahan dikhega push hua ya nahi.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
          >
            <RefreshCcw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
            Refresh
          </button>
          <button
            type="button"
            onClick={retryNow}
            disabled={retrying || pending === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-40"
          >
            {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            Retry now{pending > 0 ? ` (${pending})` : ""}
          </button>
        </div>
      </header>

      <div className="space-y-3 px-5 py-4">
        {Object.keys(counts).length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {(["pending", "pushed", "failed"] as const).map((s) =>
              counts[s] ? (
                <span key={s} className={"rounded-full px-2 py-0.5 text-[10px] font-semibold " + STATUS_STYLE[s]}>
                  {STATUS_LABEL[s]}: {counts[s]}
                </span>
              ) : null,
            )}
          </div>
        ) : null}

        {rows === null ? (
          <div className="grid h-16 place-items-center text-xs text-muted-foreground">Loading…</div>
        ) : total === 0 ? (
          <div className="grid h-16 place-items-center text-xs text-muted-foreground">
            Koi failed push nahi — sab clean. 🎉
          </div>
        ) : (
          <div className="max-h-80 overflow-auto rounded-lg border">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 font-semibold">Lead #</th>
                  <th className="px-2.5 py-1.5 font-semibold">First-chat number</th>
                  <th className="px-2.5 py-1.5 font-semibold">Tries</th>
                  <th className="px-2.5 py-1.5 font-semibold">Status</th>
                  <th className="px-2.5 py-1.5 font-semibold">Updated (IST)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lead_number} className="border-t align-top">
                    <td className="px-2.5 py-1.5 font-mono">{r.lead_number}</td>
                    <td className="px-2.5 py-1.5">{r.first_chat_number ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-2.5 py-1.5">{r.attempts}</td>
                    <td className="px-2.5 py-1.5">
                      <span className={"rounded-full px-2 py-0.5 text-[10px] font-semibold " + (STATUS_STYLE[r.status] ?? "")}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                      {r.status !== "pushed" && r.last_error ? (
                        <div className="mt-0.5 max-w-[220px] truncate text-[10px] text-muted-foreground" title={r.last_error}>
                          {r.last_error}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{istTime(r.pushed_at ?? r.next_retry_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
