"use client";

// Home / dashboard landing. Premium feel:
//   • Dark-emerald hero with the day's greeting + role chip + glass quick-jumps.
//   • Four "KPI" tiles with a coloured accent stripe per tone so the eye
//     immediately sorts "good / needs attention / blocked".
//   • By-WhatsApp-number list with avatar pills + tabular stats.
//   • Top tags rendered as gradient progress chips.
//   • Recent inbound activity with rich avatars + relative time.
//
// Everything is server-fed (`stats: HomeStats`) — this file is purely the
// visual layer so the data layer can evolve independently.

import { useEffect, useState } from "react";
import { motion, type Variants } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Clock,
  Hash,
  Inbox,
  MessageCircle,
  Phone,
  RefreshCcw,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNameOrPhoneMasker } from "@/components/PermissionsContext";
import { ROLE_LABEL, type Role } from "@/lib/team-types";
import type { HomeStats } from "@/lib/home-stats";

interface Props {
  stats: HomeStats;
  memberName: string;
  memberFirstName: string;
  role: Role;
}

function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

// Pin locale so server and client render identically — otherwise server's
// en-US ("Monday, May 4, 2026") and client's en-GB ("Monday, 4 May 2026")
// trigger a hydration mismatch.
const TODAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

// Entrance animations — play once on mount. router.refresh() updates props
// without remounting, so the 60s auto-refresh never re-triggers the stagger.
const pageStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
};
const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};
const kpiSection: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: "easeOut", staggerChildren: 0.07 },
  },
};

export function HomeView({ stats, memberName, memberFirstName, role }: Props) {
  const router = useRouter();
  const maskName = useNameOrPhoneMasker();
  const [refreshing, setRefreshing] = useState(false);
  // Re-rendered every 60s so the greeting + date stay fresh and we pull new
  // server stats. Cheap compared to skipping useMemo.
  const [, forceRender] = useState(0);
  const today = new Date();
  const dateLine = TODAY_FMT.format(today);
  const greeting = greetingFor(today);

  useEffect(() => {
    const id = setInterval(() => {
      forceRender((v) => v + 1);
      router.refresh();
    }, 60_000);
    return () => clearInterval(id);
  }, [router]);

  function manualRefresh() {
    setRefreshing(true);
    router.refresh();
    setTimeout(() => setRefreshing(false), 600);
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      {/* ----- Hero ----- */}
      <section className="relative overflow-hidden ahl-hero-gradient text-white">
        {/* Soft decorative orbs — pure CSS, GPU-cheap. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[#6098FF]/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-teal-300/10 blur-3xl"
        />
        {/* Subtle grid texture for depth. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.4) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />

        <div className="relative px-6 py-8 lg:px-10 lg:py-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-white/80">
                <Sparkles className="h-3 w-3" />
                {dateLine}
              </div>
              <h1 className="mt-2 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight sm:text-[28px]">
                <span>
                  {greeting},{" "}
                  <span className="bg-gradient-to-r from-white to-primary/15 bg-clip-text text-transparent">
                    {memberFirstName}
                  </span>
                </span>
                <span className="inline-flex items-center rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/90 ring-1 ring-inset ring-white/20 backdrop-blur">
                  {ROLE_LABEL[role]}
                </span>
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-white/80">
                Here&apos;s what your team needs to handle today.
              </p>
            </div>
            <button
              type="button"
              onClick={manualRefresh}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-xs font-medium text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-white/15 hover:ring-white/30"
            >
              <RefreshCcw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>

          {/* Quick-jump pills, glass style. */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <QuickJump href="/dashboard" icon={Inbox} label="All conversations" active />
            <QuickJump
              href="/dashboard"
              icon={MessageCircle}
              label="Unread"
              count={stats.unreadConversations}
            />
            <QuickJump
              href="/dashboard"
              icon={UserPlus}
              label="Unassigned"
              count={stats.unassignedOpen}
            />
            {stats.windowsExpiringSoon > 0 ? (
              <QuickJump
                href="/dashboard"
                icon={Clock}
                label="Window closing soon"
                count={stats.windowsExpiringSoon}
                tone="warning"
              />
            ) : null}
            {stats.windowsClosed > 0 ? (
              <QuickJump
                href="/dashboard"
                icon={AlertCircle}
                label="24h window closed"
                count={stats.windowsClosed}
                tone="danger"
              />
            ) : null}
          </div>
        </div>
      </section>

      {/* ----- Body ----- */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-7 lg:px-10">
        <motion.div
          className="mx-auto max-w-7xl space-y-7"
          variants={pageStagger}
          initial="hidden"
          animate="show"
        >
          {/* KPI strip — accent stripe on each card cues priority at a glance. */}
          <motion.section
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
            variants={kpiSection}
          >
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={Inbox}
                label="Open"
                value={stats.openCount}
                sub={`${stats.totalConversations.toLocaleString()} total · ${stats.closedCount.toLocaleString()} closed`}
                accent="emerald"
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={MessageCircle}
                label="Unread chats"
                value={stats.unreadConversations}
                sub={`${stats.unreadMessages.toLocaleString()} unread message${
                  stats.unreadMessages === 1 ? "" : "s"
                }`}
                accent={stats.unreadConversations > 0 ? "amber" : "slate"}
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={UserPlus}
                label="Unassigned (open)"
                value={stats.unassignedOpen}
                sub="Need an owner"
                accent={stats.unassignedOpen > 0 ? "violet" : "slate"}
              />
            </motion.div>
            <motion.div className="h-full" variants={fadeUp}>
              <KpiCard
                icon={Clock}
                label="Window status"
                value={stats.windowsClosed}
                sub={
                  stats.windowsClosed === 0 && stats.windowsExpiringSoon === 0
                    ? "All within 24h"
                    : `${stats.windowsExpiringSoon} closing soon`
                }
                accent={
                  stats.windowsClosed > 0
                    ? "rose"
                    : stats.windowsExpiringSoon > 0
                      ? "amber"
                      : "slate"
                }
              />
            </motion.div>
          </motion.section>

          {/* Two columns — numbers + tags. */}
          <motion.div className="grid gap-5 lg:grid-cols-5" variants={fadeUp}>
            {/* Per-number — wider */}
            <section className="overflow-hidden rounded-2xl border bg-card shadow-sm lg:col-span-3">
              <header className="flex items-center justify-between border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                    <Phone className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <h2 className="text-sm font-semibold">By WhatsApp number</h2>
                    <p className="text-[10px] text-muted-foreground">
                      Open / Unread / Total per portfolio number
                    </p>
                  </div>
                </div>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {stats.perNumber.length} number{stats.perNumber.length === 1 ? "" : "s"}
                </span>
              </header>
              {stats.perNumber.length === 0 ? (
                <Empty>No business numbers connected yet.</Empty>
              ) : (
                <ul className="divide-y">
                  {stats.perNumber.map((n, idx) => (
                    <NumberRow
                      key={n.business_phone_number_id}
                      seed={idx}
                      name={
                        n.verified_name ??
                        n.display_phone_number ??
                        n.business_phone_number_id
                      }
                      sub={n.verified_name ? n.display_phone_number : null}
                      open={n.openCount}
                      unread={n.unreadConversations}
                      total={n.totalCount}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* Top tags */}
            <section className="overflow-hidden rounded-2xl border bg-card shadow-sm lg:col-span-2">
              <header className="flex items-center justify-between border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-100">
                    <Hash className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <h2 className="text-sm font-semibold">Top tags</h2>
                    <p className="text-[10px] text-muted-foreground">
                      Sorted by unread volume
                    </p>
                  </div>
                </div>
              </header>
              {stats.topTags.length === 0 ? (
                <Empty>No tags yet. Add tags from any contact panel.</Empty>
              ) : (
                <ul className="divide-y">
                  {stats.topTags.map((t, idx) => {
                    const max = stats.topTags[0]?.totalCount || 1;
                    const pct = Math.max(8, Math.round((t.totalCount / max) * 100));
                    return (
                      <li key={t.tag} className="px-5 py-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            <span
                              className={cn(
                                "mr-1 text-xs font-semibold",
                                tagAccentText(idx),
                              )}
                            >
                              #
                            </span>
                            {t.tag}
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums">
                            {t.unreadCount > 0 ? (
                              <span className="font-semibold text-amber-700">
                                {t.unreadCount} unread
                              </span>
                            ) : null}
                            {t.unreadCount > 0 ? (
                              <span className="text-muted-foreground"> · </span>
                            ) : null}
                            <span className="text-muted-foreground">
                              {t.totalCount} total
                            </span>
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                          <div
                            className={cn(
                              "h-full rounded-full transition-[width] duration-500",
                              t.unreadCount > 0
                                ? "bg-gradient-to-r from-amber-400 to-amber-600"
                                : tagAccentBar(idx),
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </motion.div>

          {/* Recent inbound activity */}
          <motion.section
            className="overflow-hidden rounded-2xl border bg-card shadow-sm"
            variants={fadeUp}
          >
            <header className="flex items-center justify-between border-b bg-gradient-to-r from-secondary/40 to-transparent px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-100">
                  <MessageCircle className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">Recent inbound activity</h2>
                  <p className="text-[10px] text-muted-foreground">
                    Latest customer messages across every number
                  </p>
                </div>
              </div>
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10"
              >
                Open inbox
                <ArrowRight className="h-3 w-3" />
              </Link>
            </header>
            {stats.recentActivity.length === 0 ? (
              <Empty>Nothing yet. Recent customer messages will appear here.</Empty>
            ) : (
              <ul className="divide-y">
                {stats.recentActivity.map((a, i) => (
                  <li key={`${a.contact_id}-${i}`}>
                    <Link
                      href="/dashboard"
                      className="group flex items-start gap-3 px-5 py-3 transition hover:bg-secondary/40"
                    >
                      <Avatar seed={a.contact_id} text={a.display_name} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {maskName(a.display_name)}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                            {formatTimeShort(a.timestamp)}
                          </span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground group-hover:text-foreground/80">
                          {a.preview ?? <span className="italic">[media]</span>}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </motion.section>

          <motion.div
            className="text-center text-[11px] text-muted-foreground"
            variants={fadeUp}
          >
            Signed in as <span className="font-medium text-foreground">{memberName}</span> ·
            Auto-refreshes every minute
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI card — coloured left stripe + tinted icon chip. Accent picks the tone.
// ---------------------------------------------------------------------------
function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  sub?: string;
  accent: "emerald" | "amber" | "violet" | "rose" | "slate";
}) {
  const palette: Record<typeof accent, { stripe: string; chip: string; iconBg: string; iconText: string; ring: string }> = {
    emerald: {
      stripe: "bg-gradient-to-b from-[#6098FF] to-primary",
      chip: "text-primary",
      iconBg: "bg-primary/10",
      iconText: "text-primary",
      ring: "ring-primary/20",
    },
    amber: {
      stripe: "bg-gradient-to-b from-amber-400 to-amber-600",
      chip: "text-amber-800",
      iconBg: "bg-amber-50",
      iconText: "text-amber-700",
      ring: "ring-amber-100",
    },
    violet: {
      stripe: "bg-gradient-to-b from-violet-400 to-violet-600",
      chip: "text-violet-700",
      iconBg: "bg-violet-50",
      iconText: "text-violet-700",
      ring: "ring-violet-100",
    },
    rose: {
      stripe: "bg-gradient-to-b from-rose-400 to-rose-600",
      chip: "text-rose-700",
      iconBg: "bg-rose-50",
      iconText: "text-rose-700",
      ring: "ring-rose-100",
    },
    slate: {
      stripe: "bg-gradient-to-b from-slate-300 to-slate-400",
      chip: "text-slate-600",
      iconBg: "bg-slate-100",
      iconText: "text-slate-600",
      ring: "ring-slate-200",
    },
  };
  const p = palette[accent];
  return (
    <div className="group relative h-full overflow-hidden rounded-2xl border bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <span aria-hidden className={cn("absolute left-0 top-0 h-full w-1", p.stripe)} />
      <div className="px-5 py-4 pl-6">
        <div className="flex items-center justify-between">
          <span
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-xl ring-1 ring-inset",
              p.iconBg,
              p.iconText,
              p.ring,
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-[0.18em]",
              p.chip,
            )}
          >
            {label}
          </span>
        </div>
        <div className="mt-3 flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
            {value.toLocaleString()}
          </span>
        </div>
        {sub ? (
          <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-jump pill in the hero — glass styling on the gradient header.
// ---------------------------------------------------------------------------
function QuickJump({
  href,
  icon: Icon,
  label,
  count,
  active,
  tone = "default",
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  active?: boolean;
  tone?: "default" | "warning" | "danger";
}) {
  const base =
    "group inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition";
  const variant = active
    ? "bg-white text-primary shadow-lg shadow-primary/25 ring-1 ring-white/40"
    : tone === "warning"
      ? "bg-amber-300/15 text-amber-100 ring-1 ring-inset ring-amber-200/30 hover:bg-amber-300/25"
      : tone === "danger"
        ? "bg-rose-300/15 text-rose-100 ring-1 ring-inset ring-rose-200/30 hover:bg-rose-300/25"
        : "bg-white/10 text-white/90 ring-1 ring-inset ring-white/20 backdrop-blur hover:bg-white/15 hover:ring-white/30";
  return (
    <Link href={href} className={cn(base, variant)}>
      <Icon className="h-3.5 w-3.5" />
      {label}
      {typeof count === "number" && count > 0 ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-0 text-[10px] font-bold tabular-nums",
            active
              ? "bg-primary/15 text-primary"
              : "bg-white/20 text-white",
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// By-number row with coloured avatar + tabular stats.
// ---------------------------------------------------------------------------
function NumberRow({
  seed,
  name,
  sub,
  open,
  unread,
  total,
}: {
  seed: number;
  name: string;
  sub: string | null;
  open: number;
  unread: number;
  total: number;
}) {
  const accent = AVATAR_PALETTE[seed % AVATAR_PALETTE.length];
  return (
    <li className="group flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-secondary/40">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold ring-1 ring-inset",
            accent.bg,
            accent.text,
            accent.ring,
          )}
        >
          {initialsFor(name)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{name}</div>
          {sub ? (
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {sub}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <NumberStat label="Open" value={open} accent="emerald" />
        <Divider />
        <NumberStat
          label="Unread"
          value={unread}
          accent={unread > 0 ? "amber" : "muted"}
        />
        <Divider />
        <NumberStat label="Total" value={total} accent="muted" />
      </div>
    </li>
  );
}

function NumberStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "emerald" | "amber" | "muted";
}) {
  const valueClass =
    accent === "emerald"
      ? "text-primary"
      : accent === "amber"
        ? "text-amber-700"
        : "text-foreground/80";
  return (
    <div className="px-3 text-right">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-sm font-bold tabular-nums", valueClass)}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="h-7 w-px bg-border" />;
}

// Avatar pill in Recent activity. Uses the same hashing palette so a
// contact's avatar colour is stable across renders.
function Avatar({ seed, text }: { seed: string; text: string }) {
  const idx =
    Math.abs(seed.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0)) %
    AVATAR_PALETTE.length;
  const accent = AVATAR_PALETTE[idx];
  return (
    <span
      className={cn(
        "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-1 ring-inset",
        accent.bg,
        accent.text,
        accent.ring,
      )}
    >
      {initialsFor(text)}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------
const AVATAR_PALETTE = [
  { bg: "bg-primary/10", text: "text-primary", ring: "ring-primary/20" },
  { bg: "bg-violet-50",  text: "text-violet-700",  ring: "ring-violet-100" },
  { bg: "bg-sky-50",     text: "text-sky-700",     ring: "ring-sky-100" },
  { bg: "bg-amber-50",   text: "text-amber-800",   ring: "ring-amber-100" },
  { bg: "bg-rose-50",    text: "text-rose-700",    ring: "ring-rose-100" },
  { bg: "bg-teal-50",    text: "text-teal-700",    ring: "ring-teal-100" },
] as const;

const TAG_TEXTS = [
  "text-primary",
  "text-violet-600",
  "text-sky-600",
  "text-amber-600",
  "text-rose-600",
  "text-teal-600",
];

const TAG_BARS = [
  "bg-gradient-to-r from-[#6098FF] to-primary",
  "bg-gradient-to-r from-violet-400 to-violet-600",
  "bg-gradient-to-r from-sky-400 to-sky-600",
  "bg-gradient-to-r from-amber-400 to-amber-600",
  "bg-gradient-to-r from-rose-400 to-rose-600",
  "bg-gradient-to-r from-teal-400 to-teal-600",
];

function tagAccentText(idx: number) {
  return TAG_TEXTS[idx % TAG_TEXTS.length];
}
function tagAccentBar(idx: number) {
  return TAG_BARS[idx % TAG_BARS.length];
}

function initialsFor(name: string): string {
  const cleaned = name.replace(/^\+/, "");
  const parts = cleaned.trim().split(/\s+/);
  if (parts.length >= 2) {
    return ((parts[0][0] ?? "") + (parts[1][0] ?? "")).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

function formatTimeShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}
