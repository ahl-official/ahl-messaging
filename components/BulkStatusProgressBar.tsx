"use client";

// Small floating progress widget for the in-flight "bulk post status"
// task. Renders nothing when there's no task, a compact pill (bottom-
// left) while one is running, and lingers for a few seconds after it
// finishes so the operator sees the success/failure summary even if
// they walked away from the Numbers page.
//
// State source = lib/bulk-status-task (module-level). Multiple
// instances of this widget would all sync to the same store — but we
// only mount one (in the dashboard layout).

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Square, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  dismissBulkTask,
  getBulkTaskSnapshot,
  stopBulkStatus,
  subscribeBulkTask,
  type BulkTaskState,
} from "@/lib/bulk-status-task";

export function BulkStatusProgressBar() {
  const [task, setTask] = useState<BulkTaskState | null>(() =>
    getBulkTaskSnapshot(),
  );

  useEffect(() => subscribeBulkTask((s) => setTask(s)), []);

  // Auto-hide a finished task after a few seconds so it doesn't sit
  // there forever — long enough for the operator to read the summary,
  // short enough that it doesn't feel like clutter.
  useEffect(() => {
    if (!task || task.running) return;
    const t = setTimeout(() => dismissBulkTask(), 10_000);
    return () => clearTimeout(t);
  }, [task]);

  if (!task) return null;

  const failed = task.outcomes.filter((o) => !o.ok).length;
  const succeeded = task.outcomes.length - failed;
  const pct = task.total > 0 ? Math.round((task.done / task.total) * 100) : 0;

  return (
    <div className="fixed bottom-5 left-5 z-[60] w-72 max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl ring-1 ring-border">
      <div className="flex items-center gap-2 px-3 py-2">
        {task.running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-600" />
        ) : task.status === "stopped" ? (
          <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : failed === 0 ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs font-semibold">
              {task.running
                ? `Posting ${task.kind}…`
                : task.status === "stopped"
                  ? `Stopped at ${task.done}/${task.total}${succeeded ? ` · ${succeeded} posted` : ""}`
                  : failed === 0
                    ? `Posted to ${succeeded}`
                    : `${succeeded} posted · ${failed} failed`}
            </p>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {task.done}/{task.total}
            </span>
          </div>
          {/* Per-step progress bar — emerald when in-flight, amber if
              the run finished with any failures. */}
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                task.running
                  ? "bg-emerald-500"
                  : failed === 0
                    ? "bg-emerald-500"
                    : "bg-amber-500",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {task.running ? (
          <button
            type="button"
            onClick={() => stopBulkStatus()}
            className="inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold text-rose-600 ring-1 ring-rose-200 transition hover:bg-rose-50"
            title="Stop — skip the remaining numbers"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => dismissBulkTask()}
            className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {/* Latest finished number — gives some feel for progress when a
          run takes a while. Only render while running so we don't push
          the "Posted to N" summary out of focus. */}
      {task.running && task.outcomes.length > 0 ? (
        <div className="border-t bg-secondary/30 px-3 py-1.5 text-[10px] text-muted-foreground">
          Last: {task.outcomes[task.outcomes.length - 1].label}
          {task.outcomes[task.outcomes.length - 1].ok ? null : (
            <span className="ml-1 text-rose-600">
              ({task.outcomes[task.outcomes.length - 1].error})
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
