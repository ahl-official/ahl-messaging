"use client";

// KRA score chip in the TopBar.
//
// Trigger: pulsing dot + numeric score with tier-coloured ring.
//   • ≥ 95 → green   (On track)
//   • ≥ 75 → amber   (Below pace)
//   • < 75 → rose    (At risk)
//
// Popover layout:
//   1. Hero band with a circular SVG progress ring around the score and
//      the tier label.
//   2. "X of Y targets met" summary + "Show details" toggle.
//   3. Per-metric breakdown rendered ONLY after the toggle is clicked,
//      each row with an icon, count, and a coloured progress bar.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  LayoutTemplate,
  LogIn,
  MessageSquare,
  Moon,
  PhoneCall,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface MeResponse {
  day: string;
  score: number;
  tier: "green" | "amber" | "rose" | "yellow" | "red";
  targets: Record<string, number>;
  actuals: Record<string, number>;
  contributors: Array<{
    label: string;
    target: number;
    actual: number;
    ratio: number;
  }>;
}

// Normalise legacy tier names (the API still emits "yellow" / "red").
type Tier = "green" | "amber" | "rose";
function tierOf(raw: MeResponse["tier"]): Tier {
  if (raw === "yellow") return "amber";
  if (raw === "red") return "rose";
  return raw as Tier;
}

const TIER_THEME: Record<
  Tier,
  {
    label: string;
    text: string;
    ring: string;
    dot: string;
    pulse: string;
    chipBg: string;
    chipText: string;
    stroke: string;
    track: string;
    bgGrad: string;
  }
> = {
  green: {
    label: "On track",
    text: "text-primary",
    ring: "ring-primary/25",
    dot: "bg-primary",
    pulse: "bg-primary/60",
    chipBg: "bg-primary/10",
    chipText: "text-primary",
    stroke: "#2E6DE2", // emerald-500
    track: "#d9e6ff",  // emerald-100
    bgGrad: "from-primary/10 via-card to-card",
  },
  amber: {
    label: "Below pace",
    text: "text-amber-700",
    ring: "ring-amber-200",
    dot: "bg-amber-500",
    pulse: "bg-amber-500/60",
    chipBg: "bg-amber-50",
    chipText: "text-amber-800",
    stroke: "#f59e0b", // amber-500
    track: "#fef3c7",  // amber-100
    bgGrad: "from-amber-50 via-card to-card",
  },
  rose: {
    label: "At risk",
    text: "text-rose-700",
    ring: "ring-rose-200",
    dot: "bg-rose-500",
    pulse: "bg-rose-500/60",
    chipBg: "bg-rose-50",
    chipText: "text-rose-800",
    stroke: "#f43f5e", // rose-500
    track: "#ffe4e6",  // rose-100
    bgGrad: "from-rose-50 via-card to-card",
  },
};

const METRIC_ICONS: Record<string, LucideIcon> = {
  "Magic messages": Sparkles,
  Calls: PhoneCall,
  "Text replies": MessageSquare,
  "Template sends": LayoutTemplate,
  "Login hours": LogIn,
  "Idle hours": Moon,
};

export function ScoreBadge() {
  const [data, setData] = useState<MeResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/reports/me", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as MeResponse;
        if (!cancelled) setData(json);
      } catch {
        /* keep last value */
      }
    }
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowDetails(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setShowDetails(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const summary = useMemo(() => {
    if (!data) return null;
    const met = data.contributors.filter((c) => c.ratio >= 0.95).length;
    return { met, total: data.contributors.length };
  }, [data]);

  if (!data) {
    return <div className="w-[68px]" aria-hidden />;
  }

  const tier = tierOf(data.tier);
  const theme = TIER_THEME[tier];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-bold tabular-nums ring-1 ring-inset transition hover:bg-secondary",
          theme.ring,
          theme.text,
        )}
        title={`KRA score · ${data.score}/100`}
      >
        <span className="relative inline-flex h-2 w-2">
          <span
            className={cn(
              "absolute inset-0 inline-flex h-full w-full animate-ping rounded-full",
              theme.pulse,
            )}
          />
          <span className={cn("relative inline-flex h-2 w-2 rounded-full", theme.dot)} />
        </span>
        {data.score}
        <span className="text-muted-foreground">/100</span>
      </button>

      {open ? (
        <div
          role="dialog"
          className="absolute right-0 top-full z-50 mt-2 w-[340px] overflow-hidden rounded-2xl border bg-card shadow-2xl shadow-primary/10 ring-1 ring-border animate-in fade-in-0 zoom-in-95"
        >
          {/* Hero */}
          <header
            className={cn(
              "relative overflow-hidden bg-gradient-to-br px-5 py-5",
              theme.bgGrad,
            )}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-40 blur-2xl"
              style={{ background: theme.stroke }}
            />
            <div className="relative flex items-center gap-4">
              <ScoreRing score={data.score} stroke={theme.stroke} track={theme.track} />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  KRA score · today
                </div>
                <div className="mt-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
                      theme.chipBg,
                      theme.chipText,
                      theme.ring,
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", theme.dot)} />
                    {theme.label}
                  </span>
                </div>
                {summary ? (
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    <span className="font-semibold text-foreground">
                      {summary.met}
                    </span>{" "}
                    of {summary.total} target{summary.total === 1 ? "" : "s"} met
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          {/* Collapsible breakdown toggle */}
          {data.contributors.length === 0 ? (
            <div className="px-5 py-4 text-center text-xs text-muted-foreground">
              No targets set for your role yet.
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="flex w-full items-center justify-between px-5 py-3 text-[11px] font-semibold text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
                aria-expanded={showDetails}
              >
                <span>{showDetails ? "Hide breakdown" : "Show breakdown"}</span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    showDetails && "rotate-180",
                  )}
                />
              </button>

              {showDetails ? (
                <ul className="divide-y border-t">
                  {data.contributors.map((c) => {
                    const pct = Math.max(2, Math.round(c.ratio * 100));
                    const Icon = METRIC_ICONS[c.label] ?? Sparkles;
                    const barColor =
                      c.ratio >= 0.95
                        ? "bg-primary"
                        : c.ratio >= 0.75
                          ? "bg-amber-500"
                          : "bg-rose-500";
                    return (
                      <li key={c.label} className="px-5 py-2.5">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="flex items-center gap-1.5">
                            <Icon className="h-3 w-3 text-muted-foreground" />
                            <span className="font-medium">{c.label}</span>
                          </span>
                          <span className="tabular-nums">
                            <span className="font-bold text-foreground">
                              {c.actual.toLocaleString()}
                            </span>
                            <span className="text-muted-foreground/70">
                              {" "}/ {c.target.toLocaleString()}
                            </span>
                          </span>
                        </div>
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
                          <div
                            className={cn("h-full transition-[width] duration-500", barColor)}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// SVG progress ring. Stroke + track come from the active tier theme.
function ScoreRing({
  score,
  stroke,
  track,
}: {
  score: number;
  stroke: string;
  track: string;
}) {
  const size = 72;
  const r = 30;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * c;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={track}
          strokeWidth={6}
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray 600ms ease-out" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold tabular-nums leading-none" style={{ color: stroke }}>
          {score}
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          / 100
        </span>
      </div>
    </div>
  );
}
