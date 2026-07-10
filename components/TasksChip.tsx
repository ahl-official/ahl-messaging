"use client";

// Compact "my tasks" chip in the TopBar — sits just left of the KRA
// ScoreBadge. Shows the operator's open count + a red pulsing dot when
// any tasks are open or overdue. Click → /tasks.

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMyOpenTasks } from "@/lib/use-my-tasks";

export function TasksChip() {
  const { open, overdue } = useMyOpenTasks();
  const hasOpen = open > 0;

  return (
    <Link
      href="/tasks"
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-bold tabular-nums ring-1 ring-inset transition hover:bg-secondary",
        hasOpen
          ? overdue > 0
            ? "text-rose-700 ring-rose-300 shadow-sm shadow-rose-200"
            : "text-primary ring-primary/30"
          : "text-muted-foreground ring-border",
      )}
      title={
        overdue > 0
          ? `${open} open · ${overdue} overdue`
          : hasOpen
            ? `${open} open task${open === 1 ? "" : "s"}`
            : "No open tasks"
      }
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Tasks</span>
      <span>{open}</span>

      {/* Red pulse dot — visible whenever the user has pending work, so
          a busy agent can't miss it from any screen. Stronger red +
          ping ring when overdue. */}
      {hasOpen ? (
        <span className="absolute -top-1 -right-1 inline-flex h-2.5 w-2.5">
          <span
            className={cn(
              "absolute inset-0 inline-flex h-full w-full animate-ping rounded-full opacity-75",
              overdue > 0 ? "bg-rose-500" : "bg-primary",
            )}
          />
          <span
            className={cn(
              "relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-background",
              overdue > 0 ? "bg-rose-600" : "bg-primary",
            )}
          />
        </span>
      ) : null}
    </Link>
  );
}
