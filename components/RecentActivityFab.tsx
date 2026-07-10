"use client";

// Floating Recent Activity launcher. Previously the activity feed sat
// as a right-rail panel on the Automation page; that rail squeezed the
// number-card grid and collided with the other bottom-right widgets.
// Pulling it into a FAB keeps it accessible from any page and gives the
// Automation grid the full width back.

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Activity,
  CheckCircle2,
  Loader2,
  PauseCircle,
  RefreshCcw,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { emitFabClose, emitFabOpen, useFabsFlat } from "@/lib/fab-layout";
import {
  dockHideClasses,
  useFloatingDock,
} from "@/components/FloatingDockToggle";

interface ContactLite {
  id: string;
  display: string;
  wa_id: string;
}

interface LogRow {
  id: string;
  contact_id: string | null;
  business_phone_number_id: string | null;
  status: "success" | "skipped" | "failed" | "processing";
  skip_reason: string | null;
  model: string | null;
  cleaned_output: string | null;
  error_message: string | null;
  created_at: string;
  contact: ContactLite | null;
}

export function RecentActivityFab() {
  // Automation-only: the feed reflects /api/automation/logs, so there's
  // no point cluttering the FAB stack on Settings / Inbox / etc.
  const pathname = usePathname();
  const visible = pathname?.startsWith("/automation") ?? false;

  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const flat = useFabsFlat();
  const { collapsed: dockCollapsed, mounted: dockMounted } = useFloatingDock();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Auto-close when navigating off Automation so its emitFabOpen state
  // can't get wedged on for sibling FABs.
  useEffect(() => {
    if (!visible && open) setOpen(false);
  }, [visible, open]);

  // Notify the shared FAB layout so siblings flatten out of the way
  // when our popover is open. Gated on `visible` so closing happens
  // automatically when navigating off Automation.
  useEffect(() => {
    if (open && visible) emitFabOpen("recent-activity");
    else emitFabClose("recent-activity");
    return () => emitFabClose("recent-activity");
  }, [open, visible]);

  async function refresh() {
    setRefreshing(true);
    setErr(null);
    try {
      const res = await fetch("/api/automation/logs?limit=50", {
        cache: "no-store",
      });
      const json = (await res.json()) as { logs?: LogRow[]; error?: string };
      if (!res.ok) {
        setErr(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setLogs(json.logs ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setRefreshing(false);
    }
  }

  // Load + 15s auto-refresh only while popover is open AND visible —
  // no point polling /api/automation/logs in the background.
  useEffect(() => {
    if (!open || !visible) return;
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, 15_000);
    return () => clearInterval(id);
  }, [open, visible]);

  // Dismiss on outside click + Esc when open.
  useEffect(() => {
    if (!open || !visible) return;
    function onClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, visible]);

  // Hooks above run unconditionally on every render — the early return
  // below MUST stay after them or React's rules-of-hooks throws.
  if (!visible) return null;

  return (
    <div
      ref={wrapperRef}
      // Two positions, smoothly animated:
      //   flat (any FAB open) → bottom row, right-[17.5rem]
      //   stacked (idle)      → above NewChatFab, right-5
      className={cn(
        "fixed z-[55] hidden md:flex flex-col items-end transition-all duration-300 ease-out",
        // Topmost FAB in the idle stack on Automation. When any sibling
        // FAB's popover is open, slides into the flat row at the right
        // edge of the row.
        flat ? "bottom-5 right-[24rem]" : "bottom-[22rem] right-5",
        dockHideClasses(dockCollapsed, dockMounted),
      )}
    >
      {open ? (
        <div className="mb-3 w-[26rem] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl ring-1 ring-border">
          <header className="flex items-center justify-between gap-3 border-b bg-gradient-to-r from-primary/10 via-transparent to-[#6098FF]/10 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Recent activity</h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary ring-1 ring-inset ring-primary/25">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#6098FF] opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  Live
                </span>
              </div>
              <p className="text-[10.5px] text-muted-foreground">
                Last 50 runs · auto-refreshes every 15s
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary disabled:opacity-50"
                aria-label="Refresh"
              >
                <RefreshCcw
                  className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
                />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>
          <div className="max-h-[28rem] divide-y overflow-y-auto">
            {err ? (
              <div className="px-4 py-3 text-[11px] text-rose-700">{err}</div>
            ) : null}
            {logs === null ? (
              <div className="grid h-24 place-items-center text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : logs.length === 0 ? (
              <div className="grid h-36 place-items-center px-6 text-center">
                <div>
                  <div className="mx-auto mb-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                    <Activity className="h-4 w-4" />
                  </div>
                  <div className="text-xs font-medium">No runs yet</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Runs appear here when an automation-enabled number gets a
                    message.
                  </div>
                </div>
              </div>
            ) : (
              logs.map((l) => <CompactActivityRow key={l.id} log={l} />)
            )}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group relative inline-flex h-16 w-16 items-center justify-center rounded-full bg-card text-foreground shadow-lg ring-1 ring-border transition-all duration-300 ease-out hover:scale-105 hover:shadow-xl"
        title="Recent activity"
        aria-label="Recent activity"
        aria-pressed={open}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[-3px] rounded-full bg-gradient-to-br from-[#6098FF]/40 via-primary/40 to-[#6098FF]/40 opacity-70 blur-[6px] transition group-hover:opacity-100 group-hover:blur-[8px]"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[3px] rounded-full bg-[conic-gradient(from_200deg_at_50%_50%,#2E6DE2_0deg,#14b8a6_120deg,#0ea5e9_220deg,#6366f1_320deg,#2E6DE2_360deg)] shadow-inner"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[3px] rounded-full bg-gradient-to-b from-white/30 via-white/0 to-transparent"
        />
        <Activity
          className="relative h-7 w-7 text-white drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.4)]"
          strokeWidth={2.4}
        />
        {/* Tiny live dot — signals the auto-refreshing nature even when
            the popover is closed. */}
        <span
          aria-hidden
          className="pointer-events-none absolute right-1 top-1 flex h-2.5 w-2.5"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#6098FF] opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-card" />
        </span>
      </button>
    </div>
  );
}

function CompactActivityRow({ log }: { log: LogRow }) {
  const cfg =
    {
      success: {
        Icon: CheckCircle2,
        ring: "bg-primary/10 text-primary ring-primary/20",
      },
      failed: {
        Icon: XCircle,
        ring: "bg-rose-50 text-rose-600 ring-rose-100",
      },
      skipped: {
        Icon: PauseCircle,
        ring: "bg-secondary text-muted-foreground ring-border",
      },
      processing: {
        Icon: Loader2,
        ring: "bg-sky-50 text-sky-600 ring-sky-100",
      },
    }[log.status] ?? {
      Icon: PauseCircle,
      ring: "bg-secondary text-muted-foreground ring-border",
    };
  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      <span
        className={cn(
          "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
          cfg.ring,
        )}
      >
        <cfg.Icon className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12.5px] font-medium">
            {log.contact?.display ?? "—"}
          </span>
          <time className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
            {formatTimeShort(log.created_at)}
          </time>
        </div>
        {log.status === "success" && log.cleaned_output ? (
          <div className="mt-0.5 line-clamp-2 rounded bg-secondary/40 px-2 py-1 text-[11.5px] text-foreground/85">
            {log.cleaned_output}
          </div>
        ) : log.status === "failed" ? (
          <div className="mt-0.5 text-[11.5px] text-rose-700">
            {log.error_message ?? "Failed"}
          </div>
        ) : (
          <div className="mt-0.5 text-[11.5px] italic text-muted-foreground">
            Skipped — {log.skip_reason ?? "unknown reason"}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimeShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
