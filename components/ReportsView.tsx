"use client";

// /reports — per-agent productivity rollup.
//
// Hero KPIs across the whole workspace + a scrollable agent table with
// columns for text replies, template sends, magic-message sends, calls
// handled and talk time. Range filter (7d / 30d / all-time) drives a
// fresh fetch.

import { useEffect, useMemo, useState } from "react";
import { motion, type Variants } from "motion/react";
import {
  BarChart3,
  Inbox,
  Loader2,
  LogIn,
  MessageSquare,
  PhoneCall,
  RefreshCcw,
  Search,
  Sparkles,
  Target,
  Timer,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PremiumHeader } from "@/components/PremiumHeader";

interface AgentReport {
  email: string;
  /** team_members.id — present for real members, null for system senders. */
  member_id: string | null;
  full_name: string | null;
  role: string | null;
  text_replies: number;
  template_sends: number;
  magic_messages: number;
  calls_handled: number;
  talk_time_seconds: number;
  avg_call_seconds: number;
  login_hours: number;
  idle_hours: number;
  score: number;
  tier: "green" | "yellow" | "red";
}

interface DailyBreakdown {
  day: string;
  patient_messages: number;
  outbound: number;
  unique_patients: number;
}

interface ReportsResponse {
  agents: AgentReport[];
  totals: {
    text_replies: number;
    template_sends: number;
    magic_messages: number;
    calls_handled: number;
    talk_time_seconds: number;
    login_hours: number;
    patient_messages: number;
    unique_patients: number;
  };
  daily: DailyBreakdown[];
  range: string;
  since: string | null;
  until: string | null;
}

type Range =
  | "today"
  | "yesterday"
  | "3d"
  | "7d"
  | "30d"
  | "all"
  | "custom";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const AVATAR_GRADIENTS = [
  "from-emerald-500 to-teal-600",
  "from-violet-500 to-purple-600",
  "from-sky-500 to-blue-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-teal-500 to-cyan-600",
];

function gradientFor(seed: string): string {
  const n = seed.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_GRADIENTS[Math.abs(n) % AVATAR_GRADIENTS.length];
}

function initialsOf(name: string | null, email: string): string {
  const src = (name ?? email).replace(/@.*$/, "").replace(/[._]/g, " ").trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Stagger the KPI strip + tables in on first paint.
const pageStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
};
const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.38, ease: "easeOut" } },
};
const kpiSection: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.38, ease: "easeOut", staggerChildren: 0.05 },
  },
};

export function ReportsView({ canSetKra = false }: { canSetKra?: boolean }) {
  const [range, setRange] = useState<Range>("30d");
  const [from, setFrom] = useState<string>(todayISO());
  const [to, setTo] = useState<string>(todayISO());
  const [q, setQ] = useState<string>("");
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When set, the KRA editor dialog is open for these member(s).
  const [kra, setKra] = useState<{
    members: { id: string; name: string }[];
    title: string;
  } | null>(null);

  // Real members (have a team_members.id) the current viewer can set KRA for.
  const settableAgents = (data?.agents ?? []).filter((a) => a.member_id);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/reports/agents", window.location.origin);
      if (range === "today") {
        url.searchParams.set("from", todayISO());
        url.searchParams.set("to", todayISO());
      } else if (range === "yesterday") {
        const y = isoDaysAgo(1);
        url.searchParams.set("from", y);
        url.searchParams.set("to", y);
      } else if (range === "3d") {
        url.searchParams.set("from", isoDaysAgo(2));
        url.searchParams.set("to", todayISO());
      } else if (range === "custom") {
        url.searchParams.set("from", from);
        url.searchParams.set("to", to);
      } else {
        url.searchParams.set("range", range);
      }
      if (q.trim()) url.searchParams.set("q", q.trim());
      const res = await fetch(url.toString(), { cache: "no-store" });
      const json = (await res.json()) as ReportsResponse & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, from, to]);

  // Debounced search refetch.
  useEffect(() => {
    const id = setTimeout(() => void load(), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const totals = data?.totals;
  const sinceLabel = useMemo(() => {
    if (range === "today") return "Today";
    if (range === "yesterday") return "Yesterday";
    if (range === "3d") return "Last 3 days";
    if (range === "all") return "All time";
    if (range === "30d") return "Last 30 days";
    if (range === "7d") return "Last 7 days";
    return `${from} → ${to}`;
  }, [range, from, to]);

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={BarChart3}
        title="Reports"
        subtitle="Per-agent activity — message replies, template sends, magic messages, calls + talk time."
        tone="violet"
        right={
          <div className="flex items-center gap-2">
            <RangePicker value={range} onChange={setRange} />
            <button
              type="button"
              onClick={() => load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-white/15 hover:ring-white/30 disabled:opacity-50"
            >
              <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
        below={
          range === "custom" ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur">
                From
                <input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                  className="rounded bg-transparent text-white outline-none"
                  style={{ colorScheme: "dark" }}
                />
              </label>
              <label className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur">
                To
                <input
                  type="date"
                  value={to}
                  min={from}
                  max={todayISO()}
                  onChange={(e) => setTo(e.target.value)}
                  className="rounded bg-transparent text-white outline-none"
                  style={{ colorScheme: "dark" }}
                />
              </label>
            </div>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-6 lg:p-8">
        <motion.div
          className="mx-auto max-w-7xl space-y-6"
          variants={pageStagger}
          initial="hidden"
          animate="show"
        >
          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3 text-sm text-rose-800">
              {error}
            </div>
          ) : null}

          {/* Hero KPIs */}
          <motion.section
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7"
            variants={kpiSection}
          >
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={Inbox}
                label="Patient messages"
                value={totals?.patient_messages ?? 0}
                sub={sinceLabel + " · inbound"}
                accent="sky"
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={Users}
                label="Unique patients"
                value={totals?.unique_patients ?? 0}
                sub="Distinct senders"
                accent="teal"
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={MessageSquare}
                label="Text replies"
                value={totals?.text_replies ?? 0}
                sub="By agents"
                accent="emerald"
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={Sparkles}
                label="Magic messages"
                value={totals?.magic_messages ?? 0}
                sub={`of ${(totals?.template_sends ?? 0).toLocaleString()} templates`}
                accent="violet"
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={PhoneCall}
                label="Calls handled"
                value={totals?.calls_handled ?? 0}
                sub={sinceLabel}
                accent="amber"
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={Timer}
                label="Talk time"
                value={formatDuration(totals?.talk_time_seconds ?? 0)}
                sub="Total · all agents"
                accent="rose"
                isText
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={LogIn}
                label="Login hours"
                value={(totals?.login_hours ?? 0).toFixed(1) + "h"}
                sub="Sum of working windows"
                accent="emerald"
                isText
              />
            </motion.div>
          </motion.section>

          {/* Per-day breakdown — what came in vs went out each day in
              the selected range. Helps spot pacing issues at a glance. */}
          <motion.div variants={fadeUp}>
            <DailyBreakdownTable rows={data?.daily ?? []} />
          </motion.div>

          {/* Search */}
          <motion.div className="relative max-w-md" variants={fadeUp}>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by agent name or email…"
              className="w-full rounded-full border bg-card py-2 pl-10 pr-3 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
            />
          </motion.div>

          {/* Agent table */}
          <motion.section
            className="overflow-hidden rounded-2xl border bg-card shadow-sm"
            variants={fadeUp}
          >
            <header className="flex items-center justify-between border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-100">
                  <BarChart3 className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">Agent activity</h2>
                  <p className="text-[10px] text-muted-foreground">
                    Ranked by combined sends + calls in this period.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {canSetKra && settableAgents.length > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setKra({
                        members: settableAgents.map((a) => ({
                          id: a.member_id as string,
                          name: a.full_name?.trim() || a.email,
                        })),
                        title: `Set KRA for all ${settableAgents.length} members`,
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-violet-700"
                  >
                    <Target className="h-3.5 w-3.5" />
                    Set team KRA
                  </button>
                ) : null}
                <span className="text-[11px] text-muted-foreground">
                  {(data?.agents ?? []).length} agent
                  {(data?.agents ?? []).length === 1 ? "" : "s"}
                </span>
              </div>
            </header>

            {loading && !data ? (
              <div className="grid h-32 place-items-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : (data?.agents ?? []).length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                No activity in this range yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1000px] text-sm">
                  <thead>
                    <tr className="bg-secondary/40 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      <th className="px-5 py-2.5">Agent</th>
                      <th className="px-3 py-2.5 text-right">Score</th>
                      <th className="px-3 py-2.5 text-right">Text replies</th>
                      <th className="px-3 py-2.5 text-right">Templates</th>
                      <th className="px-3 py-2.5 text-right">Magic msgs</th>
                      <th className="px-3 py-2.5 text-right">Calls</th>
                      <th className="px-3 py-2.5 text-right">Talk time</th>
                      <th className="px-3 py-2.5 text-right">Login</th>
                      <th className="px-3 py-2.5 text-right">Idle</th>
                      {canSetKra ? (
                        <th className="px-3 py-2.5 pr-5 text-right">KRA</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(data?.agents ?? []).map((a) => (
                      <tr
                        key={a.email}
                        className="transition hover:bg-secondary/30"
                      >
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={cn(
                                "inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white shadow-sm ring-2 ring-white",
                                gradientFor(a.email),
                              )}
                            >
                              {initialsOf(a.full_name, a.email)}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-semibold leading-tight">
                                {a.full_name?.trim() || a.email}
                              </div>
                              <div className="truncate text-[10px] text-muted-foreground">
                                {a.email}
                                {a.role ? (
                                  <span className="ml-1 rounded-full bg-secondary px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider text-muted-foreground ring-1 ring-border">
                                    {a.role}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <ScoreCell score={a.score} tier={a.tier} />
                        </td>
                        <Stat value={a.text_replies} />
                        <Stat value={a.template_sends} />
                        <Stat
                          value={a.magic_messages}
                          tone={a.magic_messages > 0 ? "violet" : undefined}
                        />
                        <Stat value={a.calls_handled} />
                        <Stat text={formatDuration(a.talk_time_seconds)} />
                        <Stat
                          text={
                            a.login_hours > 0
                              ? `${a.login_hours.toFixed(1)}h`
                              : "—"
                          }
                        />
                        <Stat
                          text={
                            a.idle_hours > 0
                              ? `${a.idle_hours.toFixed(1)}h`
                              : "—"
                          }
                        />
                        {canSetKra ? (
                          <td className="px-3 py-2.5 pr-5 text-right">
                            {a.member_id ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setKra({
                                    members: [
                                      {
                                        id: a.member_id as string,
                                        name: a.full_name?.trim() || a.email,
                                      },
                                    ],
                                    title: `Set KRA — ${a.full_name?.trim() || a.email}`,
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium transition hover:bg-secondary"
                              >
                                <Target className="h-3 w-3" /> Set
                              </button>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </motion.section>
        </motion.div>
      </div>

      {kra ? (
        <KraDialog
          members={kra.members}
          title={kra.title}
          onClose={() => setKra(null)}
          onSaved={() => load()}
        />
      ) : null}
    </div>
  );
}

const KRA_FIELDS: { key: string; label: string; unit: string }[] = [
  { key: "magic_messages_per_day", label: "Magic messages", unit: "/ day" },
  { key: "calls_per_day", label: "Calls handled", unit: "/ day" },
  { key: "text_replies_per_day", label: "Text replies", unit: "/ day" },
  { key: "template_sends_per_day", label: "Template sends", unit: "/ day" },
  { key: "min_login_hours_per_day", label: "Min login hours", unit: "h" },
  { key: "max_idle_hours_per_day", label: "Max idle hours", unit: "h" },
];

// Lightweight KRA editor used straight from the Reports table — works for a
// single member or, in bulk, the whole team. A blank field is left unchanged
// (existing override kept / role default inherited).
function KraDialog({
  members,
  title,
  onClose,
  onSaved,
}: {
  members: { id: string; name: string }[];
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bulk = members.length > 1;

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const fields: Record<string, number> = {};
      for (const f of KRA_FIELDS) {
        const s = (vals[f.key] ?? "").trim();
        if (s !== "" && Number.isFinite(Number(s))) fields[f.key] = Number(s);
      }
      if (Object.keys(fields).length === 0) {
        setErr("Enter at least one target.");
        setSaving(false);
        return;
      }
      for (const m of members) {
        const res = await fetch("/api/targets/member", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ member_id: m.id, ...fields }),
        });
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Target className="h-4 w-4 text-violet-600" />
            {title}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="mb-3 text-[11px] text-muted-foreground">
            {bulk
              ? `Applies to all ${members.length} members. `
              : ""}
            Leave a field blank to keep it unchanged (inherits the role default
            if never set).
          </p>
          <div className="grid grid-cols-2 gap-3">
            {KRA_FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {f.label}
                </span>
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={vals[f.key] ?? ""}
                    onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                    placeholder="—"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm font-mono shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <span className="text-[10px] text-muted-foreground">{f.unit}</span>
                </div>
              </label>
            ))}
          </div>
          {err ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            Save KRA
          </button>
        </div>
      </div>
    </div>
  );
}

function RangePicker({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  const options: { value: Range; label: string }[] = [
    { value: "today", label: "Today" },
    { value: "yesterday", label: "Yesterday" },
    { value: "3d", label: "3d" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "all", label: "All" },
    { value: "custom", label: "Custom" },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full bg-white/10 p-0.5 ring-1 ring-inset ring-white/20 backdrop-blur">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-full px-3 py-1.5 text-[11px] font-semibold transition",
              active
                ? "bg-white text-emerald-800 shadow"
                : "text-white/80 hover:text-white",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  isText,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  sub?: string;
  accent: "emerald" | "violet" | "amber" | "rose" | "sky" | "teal";
  isText?: boolean;
}) {
  const palette: Record<
    typeof accent,
    {
      iconBg: string;
      iconText: string;
      iconRing: string;
      glow: string;
      label: string;
      sheen: string;
    }
  > = {
    emerald: {
      iconBg: "bg-gradient-to-br from-emerald-500 to-teal-600",
      iconText: "text-white",
      iconRing: "ring-emerald-200/60",
      glow: "from-emerald-400/0 via-emerald-400/30 to-emerald-500/40",
      label: "text-emerald-700",
      sheen: "from-emerald-100/40",
    },
    violet: {
      iconBg: "bg-gradient-to-br from-violet-500 to-purple-600",
      iconText: "text-white",
      iconRing: "ring-violet-200/60",
      glow: "from-violet-400/0 via-violet-400/30 to-violet-500/40",
      label: "text-violet-700",
      sheen: "from-violet-100/40",
    },
    amber: {
      iconBg: "bg-gradient-to-br from-amber-500 to-orange-600",
      iconText: "text-white",
      iconRing: "ring-amber-200/60",
      glow: "from-amber-400/0 via-amber-400/30 to-amber-500/40",
      label: "text-amber-700",
      sheen: "from-amber-100/40",
    },
    rose: {
      iconBg: "bg-gradient-to-br from-rose-500 to-pink-600",
      iconText: "text-white",
      iconRing: "ring-rose-200/60",
      glow: "from-rose-400/0 via-rose-400/30 to-rose-500/40",
      label: "text-rose-700",
      sheen: "from-rose-100/40",
    },
    sky: {
      iconBg: "bg-gradient-to-br from-sky-500 to-blue-600",
      iconText: "text-white",
      iconRing: "ring-sky-200/60",
      glow: "from-sky-400/0 via-sky-400/30 to-sky-500/40",
      label: "text-sky-700",
      sheen: "from-sky-100/40",
    },
    teal: {
      iconBg: "bg-gradient-to-br from-teal-500 to-cyan-600",
      iconText: "text-white",
      iconRing: "ring-teal-200/60",
      glow: "from-teal-400/0 via-teal-400/30 to-teal-500/40",
      label: "text-teal-700",
      sheen: "from-teal-100/40",
    },
  };
  const p = palette[accent];
  return (
    <div className="group relative h-full overflow-hidden rounded-2xl border bg-card shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg">
      {/* corner glow — pure decoration, sits behind everything */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br opacity-70 blur-2xl transition-opacity duration-500 group-hover:opacity-100",
          p.glow,
        )}
      />
      {/* top sheen for that premium card feel */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b to-transparent",
          p.sheen,
        )}
      />
      <div className="relative flex h-full flex-col px-5 py-4">
        {/* Header row: icon (left) + label (right) — flex with min-w-0
            on the label so it shrinks before it can collide with the icon. */}
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm ring-1 ring-inset",
              p.iconBg,
              p.iconText,
              p.iconRing,
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 break-words pt-1 text-[10px] font-bold uppercase leading-[1.2] tracking-[0.14em]",
              p.label,
            )}
          >
            {label}
          </span>
        </div>
        <div className="mt-4 text-[28px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
          {isText ? value : Number(value).toLocaleString()}
        </div>
        {sub ? (
          <div className="mt-1.5 text-[11px] leading-tight text-muted-foreground">
            {sub}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ScoreCell({
  score,
  tier,
}: {
  score: number | null | undefined;
  tier: "green" | "yellow" | "red" | null | undefined;
}) {
  // Defensive narrowing — agent rows occasionally arrive without a
  // tier (new agent with no messages this range) and the old strict
  // signature crashed `/reports?tab=agents` for the whole page.
  const safeTier: "green" | "yellow" | "red" =
    tier === "green" || tier === "yellow" || tier === "red" ? tier : "red";
  const safeScore =
    typeof score === "number" && Number.isFinite(score) ? score : 0;
  const tone =
    safeTier === "green"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : safeTier === "yellow"
        ? "bg-amber-50 text-amber-700 ring-amber-200"
        : "bg-rose-50 text-rose-700 ring-rose-200";
  return (
    <span
      className={cn(
        "inline-flex min-w-[3.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ring-1 ring-inset",
        tone,
      )}
    >
      {safeScore}
    </span>
  );
}

function DailyBreakdownTable({ rows }: { rows: DailyBreakdown[] }) {
  if (rows.length === 0) return null;
  const peak = Math.max(...rows.map((r) => r.patient_messages), 1);
  const fmt = (d: string) => {
    const dt = new Date(`${d}T00:00:00Z`);
    return dt.toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "short",
    });
  };
  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-100">
            <Inbox className="h-3.5 w-3.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Per-day messages</h2>
            <p className="text-[10px] text-muted-foreground">
              Patient messages in / agent messages out, grouped by date.
            </p>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {rows.length} day{rows.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-secondary/40 backdrop-blur">
            <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-2.5">Date</th>
              <th className="px-3 py-2.5 text-right">Patient msgs</th>
              <th className="px-3 py-2.5 text-right">Unique patients</th>
              <th className="px-3 py-2.5 text-right">Outbound</th>
              <th className="px-3 py-2.5 pr-5">Activity</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.day} className="transition hover:bg-secondary/30">
                <td className="px-5 py-2 text-[13px] font-medium tabular-nums">
                  {fmt(r.day)}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-sky-700">
                  {r.patient_messages.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-teal-700">
                  {r.unique_patients.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700">
                  {r.outbound.toLocaleString()}
                </td>
                <td className="px-3 py-2 pr-5">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-sky-100/70">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-sky-400 to-sky-600"
                      style={{
                        width: `${Math.max(2, Math.round((r.patient_messages / peak) * 100))}%`,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({
  value,
  text,
  tone,
}: {
  value?: number;
  text?: string;
  tone?: "violet";
}) {
  const isZero = (text ?? "") === "—" || value === 0;
  return (
    <td
      className={cn(
        "px-3 py-2.5 text-right text-sm tabular-nums",
        isZero
          ? "text-muted-foreground/60"
          : tone === "violet"
            ? "font-semibold text-violet-700"
            : "font-semibold text-foreground",
      )}
    >
      {text ?? value?.toLocaleString() ?? "—"}
    </td>
  );
}
