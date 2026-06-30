"use client";

// /reports → Analytics tab.
// Workspace-wide reporting dashboard with automatic filters at the top
// (date range + business number). Everything else (KPIs, charts,
// tables) re-fetches whenever a filter flips.
//
// Charts are hand-rolled SVG — no chart-library dep. They're modest
// (line chart, bar chart, heatmap, leaderboard table) but plenty
// readable on the data sizes a clinic dashboard sees.

import { useEffect, useMemo, useState } from "react";
import { motion, type Variants } from "motion/react";
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  Clock,
  Inbox,
  Loader2,
  RefreshCw,
  Sparkles,
  Tag,
  Timer,
  UserPlus,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---- shared types (mirror the API response) ---- //

interface Overview {
  range: { since_hours: number; since_iso: string; until_iso: string };
  scope: { bpid_filter: string | null; allowed_bpids: string[] | "all" };
  kpis: {
    inbound: number;
    outbound: number;
    magic_messages: number;
    new_contacts: number;
    unread_now: number;
    open_chats: number;
    avg_response_minutes: number | null;
  };
  daily: Array<{ date: string; inbound: number; outbound: number }>;
  per_number: Array<{
    phone_number_id: string;
    label: string;
    inbound: number;
    outbound: number;
    contacts: number;
  }>;
  agent_leaderboard: Array<{
    agent: string;
    email: string | null;
    outbound: number;
  }>;
  top_tags: Array<{ tag: string; count: number }>;
  peak_hours: Array<{ hour: number; count: number }>;
  response_time: Array<{
    bpid: string;
    label: string;
    median_minutes: number;
    samples: number;
  }>;
}

interface NumberOption {
  phone_number_id: string;
  label: string;
}

const RANGES = [
  { key: "24", label: "Today", hours: 24 },
  { key: "48", label: "Yesterday", hours: 48 },
  { key: "72", label: "3d", hours: 72 },
  { key: "168", label: "7d", hours: 24 * 7 },
  { key: "720", label: "30d", hours: 24 * 30 },
  { key: "2160", label: "90d", hours: 24 * 90 },
] as const;

const NUM = (n: number) => n.toLocaleString("en-IN");

// Reveal charts + cards in sequence once the report data lands.
const revealStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
};
const revealItem: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.38, ease: "easeOut" } },
};

export function AnalyticsDashboard() {
  const [rangeKey, setRangeKey] = useState<string>("168"); // default 7d
  const [bpid, setBpid] = useState<string>(""); // empty = all visible
  const [numberOptions, setNumberOptions] = useState<NumberOption[]>([]);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Number options — pulled from the workspace endpoint so the filter
  // matches what's actually selectable. Restricted by the same perms
  // the inbox respects (server-side filter).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/business-numbers", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          numbers?: Array<{
            phone_number_id: string;
            display_phone_number: string | null;
            verified_name: string | null;
            nickname: string | null;
          }>;
        };
        if (cancelled) return;
        const opts = (j.numbers ?? []).map((n) => ({
          phone_number_id: n.phone_number_id,
          label:
            n.nickname?.trim() ||
            n.verified_name?.trim() ||
            n.display_phone_number ||
            n.phone_number_id,
        }));
        setNumberOptions(opts);
      } catch {
        /* keep dropdown empty on error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch overview whenever filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const hours = RANGES.find((r) => r.key === rangeKey)?.hours ?? 168;
    const qs = new URLSearchParams({ since_hours: String(hours) });
    if (bpid) qs.set("bpid", bpid);
    void (async () => {
      try {
        const res = await fetch(`/api/reports/overview?${qs.toString()}`, {
          cache: "no-store",
        });
        const text = await res.text();
        let parsed: Overview | { error?: string } | null = null;
        try {
          parsed = JSON.parse(text) as Overview | { error?: string };
        } catch {
          throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
        }
        if (!res.ok) {
          throw new Error(
            (parsed as { error?: string }).error ?? `HTTP ${res.status}`,
          );
        }
        if (!cancelled) setData(parsed as Overview);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rangeKey, bpid]);

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <FilterBar
        rangeKey={rangeKey}
        setRangeKey={setRangeKey}
        bpid={bpid}
        setBpid={setBpid}
        numberOptions={numberOptions}
        loading={loading}
        onRefresh={() => {
          // Re-trigger the effect by nudging state. Simplest: re-set
          // rangeKey to the same value via callback form.
          setRangeKey((k) => k);
        }}
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6 lg:px-10">
        <div className="mx-auto max-w-7xl space-y-6">
          {error ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </div>
          ) : null}

          {!data && loading ? (
            <div className="grid h-40 place-items-center text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Crunching numbers…
              </span>
            </div>
          ) : null}

          {data ? (
            <motion.div
              className="space-y-6"
              variants={revealStagger}
              initial="hidden"
              animate="show"
            >
              <motion.div variants={revealItem}>
                <KpiStrip kpis={data.kpis} />
              </motion.div>

              <motion.div
                className="grid gap-6 lg:grid-cols-3"
                variants={revealItem}
              >
                <DailyVolumeChart daily={data.daily} />
                <PeakHoursCard hours={data.peak_hours} />
              </motion.div>

              <motion.div
                className="grid gap-6 lg:grid-cols-2"
                variants={revealItem}
              >
                <PerNumberCard rows={data.per_number} />
                <AgentLeaderboardCard rows={data.agent_leaderboard} />
              </motion.div>

              <motion.div
                className="grid gap-6 lg:grid-cols-2"
                variants={revealItem}
              >
                <ResponseTimeCard rows={data.response_time} />
                <TopTagsCard rows={data.top_tags} />
              </motion.div>
            </motion.div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// =================================================================== //
// Filter bar                                                          //
// =================================================================== //

function FilterBar({
  rangeKey,
  setRangeKey,
  bpid,
  setBpid,
  numberOptions,
  loading,
  onRefresh,
}: {
  rangeKey: string;
  setRangeKey: (v: string) => void;
  bpid: string;
  setBpid: (v: string) => void;
  numberOptions: NumberOption[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="border-b bg-card">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3 lg:px-10">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            Range
          </div>
          <div className="inline-flex overflow-hidden rounded-full border bg-secondary/40 p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRangeKey(r.key)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-semibold transition",
                  rangeKey === r.key
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-muted-foreground hover:bg-secondary",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Number
          </div>
          <select
            value={bpid}
            onChange={(e) => setBpid(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs font-medium outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          >
            <option value="">All numbers</option>
            {numberOptions.map((n) => (
              <option key={n.phone_number_id} value={n.phone_number_id}>
                {n.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>
    </div>
  );
}

// =================================================================== //
// KPI strip                                                           //
// =================================================================== //

function KpiStrip({ kpis }: { kpis: Overview["kpis"] }) {
  const cards = [
    {
      label: "Inbound",
      value: NUM(kpis.inbound),
      icon: ArrowDownLeft,
      accent: "emerald" as const,
    },
    {
      label: "Outbound",
      value: NUM(kpis.outbound),
      icon: ArrowUpRight,
      accent: "sky" as const,
    },
    {
      label: "Magic messages",
      value: NUM(kpis.magic_messages),
      icon: Sparkles,
      accent: "violet" as const,
    },
    {
      label: "New contacts",
      value: NUM(kpis.new_contacts),
      icon: UserPlus,
      accent: "violet" as const,
    },
    {
      label: "Unread now",
      value: NUM(kpis.unread_now),
      icon: Inbox,
      accent: "amber" as const,
    },
    {
      label: "Open chats",
      value: NUM(kpis.open_chats),
      icon: Users,
      accent: "teal" as const,
    },
    {
      label: "Avg response",
      value:
        kpis.avg_response_minutes === null
          ? "—"
          : `${kpis.avg_response_minutes} min`,
      icon: Timer,
      accent: "rose" as const,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
      {cards.map((c) => (
        <KpiCard key={c.label} {...c} />
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: "emerald" | "sky" | "violet" | "amber" | "teal" | "rose";
}) {
  const palette: Record<typeof accent, string> = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    sky: "bg-sky-50 text-sky-700 ring-sky-200",
    violet: "bg-violet-50 text-violet-700 ring-violet-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    teal: "bg-teal-50 text-teal-700 ring-teal-200",
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
  };
  return (
    <div className="rounded-2xl border bg-card p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset",
            palette[accent],
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight tabular-nums">
        {value}
      </div>
    </div>
  );
}

// =================================================================== //
// Daily volume line chart (SVG, no library)                           //
// =================================================================== //

function DailyVolumeChart({ daily }: { daily: Overview["daily"] }) {
  const W = 560;
  const H = 220;
  const PAD = { l: 36, r: 12, t: 16, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const maxVal = useMemo(
    () =>
      Math.max(
        1,
        ...daily.flatMap((d) => [d.inbound, d.outbound]),
      ),
    [daily],
  );
  const n = daily.length;
  function x(idx: number): number {
    if (n <= 1) return PAD.l + innerW / 2;
    return PAD.l + (idx / (n - 1)) * innerW;
  }
  function y(v: number): number {
    return PAD.t + innerH - (v / maxVal) * innerH;
  }

  function pathFor(key: "inbound" | "outbound"): string {
    return daily
      .map((d, idx) => `${idx === 0 ? "M" : "L"} ${x(idx)} ${y(d[key])}`)
      .join(" ");
  }

  // Pick ~4 evenly-spaced x-axis labels so we don't overlap on long
  // ranges (90d). Always include first + last.
  const ticks = useMemo(() => {
    if (n === 0) return [];
    if (n <= 6) return daily.map((_, i) => i);
    const step = Math.ceil(n / 5);
    const set = new Set<number>();
    for (let i = 0; i < n; i += step) set.add(i);
    set.add(n - 1);
    return Array.from(set).sort((a, b) => a - b);
  }, [n, daily]);

  return (
    <section className="lg:col-span-2 rounded-2xl border bg-card p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Messages per day</h3>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <Legend color="bg-emerald-500" label="Inbound" />
          <Legend color="bg-sky-500" label="Outbound" />
        </div>
      </header>
      {n === 0 ? (
        <EmptyState />
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-56 w-full"
          preserveAspectRatio="none"
        >
          {/* Grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <line
              key={p}
              x1={PAD.l}
              x2={W - PAD.r}
              y1={PAD.t + innerH * p}
              y2={PAD.t + innerH * p}
              stroke="hsl(var(--border))"
              strokeDasharray="3 3"
            />
          ))}
          {/* Y axis labels */}
          {[0, 0.5, 1].map((p) => (
            <text
              key={p}
              x={PAD.l - 6}
              y={PAD.t + innerH * (1 - p) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {Math.round(maxVal * p)}
            </text>
          ))}
          {/* Outbound */}
          <path
            d={pathFor("outbound")}
            fill="none"
            stroke="hsl(217 91% 60%)"
            strokeWidth="2"
          />
          {/* Inbound */}
          <path
            d={pathFor("inbound")}
            fill="none"
            stroke="hsl(160 84% 39%)"
            strokeWidth="2"
          />
          {/* X axis ticks */}
          {ticks.map((idx) => (
            <text
              key={idx}
              x={x(idx)}
              y={H - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {daily[idx].date.slice(5)}
            </text>
          ))}
        </svg>
      )}
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block h-2 w-3 rounded-sm", color)} />
      {label}
    </span>
  );
}

// =================================================================== //
// Peak hours card                                                     //
// =================================================================== //

function PeakHoursCard({ hours }: { hours: Overview["peak_hours"] }) {
  const max = Math.max(1, ...hours.map((h) => h.count));
  const peak = hours.reduce((a, b) => (b.count > a.count ? b : a), hours[0]);
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Inbound peak hours (UTC)</h3>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
          <Clock className="h-3 w-3" />
          peak {peak ? `${peak.hour}:00` : "—"}
        </span>
      </header>
      <div className="grid grid-cols-12 gap-0.5">
        {hours.map((h) => {
          const heightPct = max > 0 ? (h.count / max) * 100 : 0;
          return (
            <div
              key={h.hour}
              className="flex flex-col items-center"
              title={`${h.hour}:00 — ${NUM(h.count)} inbound`}
            >
              <div className="flex h-24 w-full items-end">
                <div
                  className={cn(
                    "w-full rounded-sm bg-gradient-to-t",
                    h === peak
                      ? "from-emerald-600 to-emerald-300"
                      : "from-emerald-500/70 to-emerald-300/70",
                  )}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
              <span
                className={cn(
                  "mt-0.5 text-[8px] font-medium text-muted-foreground",
                  h.hour % 3 !== 0 && "opacity-0",
                )}
              >
                {h.hour}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// =================================================================== //
// Per-number breakdown                                                //
// =================================================================== //

function PerNumberCard({ rows }: { rows: Overview["per_number"] }) {
  const max = Math.max(1, ...rows.map((r) => r.inbound + r.outbound));
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Per-number volume</h3>
        <span className="text-[11px] text-muted-foreground">
          {rows.length} number{rows.length === 1 ? "" : "s"}
        </span>
      </header>
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const total = r.inbound + r.outbound;
            const widthPct = max > 0 ? (total / max) * 100 : 0;
            return (
              <li key={r.phone_number_id}>
                <div className="mb-0.5 flex items-center justify-between text-xs">
                  <span className="truncate font-medium">{r.label}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {NUM(total)}
                  </span>
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-sky-500"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
                  <span>in {NUM(r.inbound)}</span>
                  <span>out {NUM(r.outbound)}</span>
                  <span>{NUM(r.contacts)} contacts</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// =================================================================== //
// Agent leaderboard                                                   //
// =================================================================== //

function AgentLeaderboardCard({ rows }: { rows: Overview["agent_leaderboard"] }) {
  const max = Math.max(1, ...rows.map((r) => r.outbound));
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Agent leaderboard</h3>
        <span className="text-[11px] text-muted-foreground">
          Outbound messages
        </span>
      </header>
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <ol className="space-y-2">
          {rows.map((r, idx) => {
            const widthPct = max > 0 ? (r.outbound / max) * 100 : 0;
            return (
              <li key={`${r.agent}-${idx}`}>
                <div className="mb-0.5 flex items-center justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] font-bold",
                        idx === 0
                          ? "bg-amber-100 text-amber-800"
                          : idx === 1
                            ? "bg-zinc-200 text-zinc-700"
                            : idx === 2
                              ? "bg-orange-100 text-orange-700"
                              : "bg-secondary text-muted-foreground",
                      )}
                    >
                      {idx + 1}
                    </span>
                    <span className="font-medium">{r.agent}</span>
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {NUM(r.outbound)}
                  </span>
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-violet-500 to-fuchsia-500"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// =================================================================== //
// Response time per number                                            //
// =================================================================== //

function ResponseTimeCard({ rows }: { rows: Overview["response_time"] }) {
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Response time per number</h3>
        <span className="text-[11px] text-muted-foreground">
          Median min — lower is better
        </span>
      </header>
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left font-semibold">Number</th>
              <th className="text-right font-semibold">Median</th>
              <th className="text-right font-semibold">Samples</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // Colour the median by speed: green ≤5 min, amber ≤30,
              // rose beyond. Operators glance at this column most.
              const tone =
                r.median_minutes <= 5
                  ? "text-emerald-700"
                  : r.median_minutes <= 30
                    ? "text-amber-700"
                    : "text-rose-700";
              return (
                <tr key={r.bpid} className="border-t">
                  <td className="py-1.5 truncate font-medium">{r.label}</td>
                  <td
                    className={cn(
                      "py-1.5 text-right font-mono tabular-nums",
                      tone,
                    )}
                  >
                    {r.median_minutes.toFixed(1)} min
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground">
                    {NUM(r.samples)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// =================================================================== //
// Top tags                                                            //
// =================================================================== //

function TopTagsCard({ rows }: { rows: Overview["top_tags"] }) {
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Top tags</h3>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Tag className="h-3 w-3" />
          contacts
        </span>
      </header>
      {rows.length === 0 ? (
        <EmptyState hint="Operators haven't tagged contacts yet." />
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {rows.map((t) => (
            <li
              key={t.tag}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-foreground"
            >
              <span>{t.tag}</span>
              <span className="rounded-full bg-emerald-100 px-1.5 font-mono text-[10px] text-emerald-800">
                {NUM(t.count)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// =================================================================== //
// Misc                                                                //
// =================================================================== //

function EmptyState({ hint }: { hint?: string } = {}) {
  return (
    <div className="rounded-md border border-dashed bg-secondary/30 px-3 py-6 text-center text-xs text-muted-foreground">
      {hint ?? "No data in the selected range."}
    </div>
  );
}

// Linter complains about unused Link import otherwise — keep it tied to
// a small "view in inbox" affordance for future iteration.
void Link;
