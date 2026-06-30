"use client";

// Tasks panel — owner / superadmin / admin assign work to any agent;
// every agent sees their own queue + can comment + flip status. Three
// tabs:
//   1. My tasks  (always visible)
//   2. All tasks (admin+ only) — workspace-wide list + filters
//   3. Reports   (admin+ only) — per-agent open / done / overdue table
//
// Linkage is optional — a task can pin to a specific contact (jumps to
// /dashboard?c=<id>) or a WhatsApp business number. Reporting is light
// for v1: counts + per-agent table. KRA / heavy charts can land later
// once we know which numbers operators want.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  Flag,
  Loader2,
  MessageSquare,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isAtLeast, type Role } from "@/lib/team-types";
import { CreateTaskModal } from "@/components/CreateTaskModal";
import { emitTasksChanged } from "@/lib/use-my-tasks";
import { EmptyState as PremiumEmptyState } from "@/components/ui/EmptyState";
import { PremiumHeader } from "@/components/PremiumHeader";

type Status = "open" | "in_progress" | "blocked" | "done" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";

const STATUSES: Status[] = ["open", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
const STATUS_TONE: Record<
  Status,
  { bg: string; text: string; ring: string; dot: string }
> = {
  open: {
    bg: "bg-sky-50",
    text: "text-sky-700",
    ring: "ring-sky-200",
    dot: "bg-sky-500",
  },
  in_progress: {
    bg: "bg-violet-50",
    text: "text-violet-700",
    ring: "ring-violet-200",
    dot: "bg-violet-500",
  },
  blocked: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    ring: "ring-rose-200",
    dot: "bg-rose-500",
  },
  done: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    ring: "ring-emerald-200",
    dot: "bg-emerald-500",
  },
  cancelled: {
    bg: "bg-secondary",
    text: "text-muted-foreground",
    ring: "ring-border",
    dot: "bg-muted-foreground/60",
  },
};

const PRIORITY_TONE: Record<
  Priority,
  { bg: string; text: string; ring: string; label: string }
> = {
  low: {
    bg: "bg-secondary",
    text: "text-muted-foreground",
    ring: "ring-border",
    label: "Low",
  },
  normal: {
    bg: "bg-sky-50",
    text: "text-sky-700",
    ring: "ring-sky-200",
    label: "Normal",
  },
  high: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    ring: "ring-amber-200",
    label: "High",
  },
  urgent: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    ring: "ring-rose-200",
    label: "Urgent",
  },
};

interface MemberLite {
  id: string;
  full_name: string | null;
  email: string;
}
interface ContactLite {
  id: string;
  name: string | null;
  wa_id: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: Status;
  priority: Priority;
  assigned_to: string | null;
  created_by: string | null;
  contact_id: string | null;
  business_phone_number_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  assignee: MemberLite | null;
  creator: MemberLite | null;
  contact: ContactLite | null;
}

interface Stats {
  mine: { open: number; overdue: number };
  workspace: {
    total: number;
    open: number;
    in_progress: number;
    blocked: number;
    done: number;
    cancelled: number;
    overdue: number;
    per_agent: Array<{
      member_id: string;
      full_name: string | null;
      email: string;
      open: number;
      done: number;
      overdue: number;
    }>;
  } | null;
}

interface BusinessNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  nickname: string | null;
  verified_name: string | null;
}

type Tab = "mine" | "all" | "reports";

export function TasksView({
  currentMemberId,
  currentRole,
}: {
  currentMemberId: string;
  currentRole: Role;
}) {
  const canAssign = isAtLeast(currentRole, "admin");
  const [tab, setTab] = useState<Tab>("mine");
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("scope", tab === "all" ? "all" : "mine");
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (priorityFilter !== "all") params.set("priority", priorityFilter);
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/tasks?${params.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { tasks?: TaskRow[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTasks(json.tasks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [tab, statusFilter, priorityFilter, q]);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/stats", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as Stats;
      setStats(json);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);
  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const refresh = useCallback(() => {
    void loadTasks();
    void loadStats();
  }, [loadTasks, loadStats]);

  const workspaceOpen = stats?.workspace
    ? stats.workspace.open + stats.workspace.in_progress + stats.workspace.blocked
    : 0;

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-secondary/40 via-secondary/20 to-background">
      <PremiumHeader
        icon={CheckCircle2}
        title="Tasks"
        subtitle="Assign work to agents, track progress, and report on pending vs done per team member."
        tone="emerald"
        right={
          <div className="flex items-stretch gap-2">
            <TasksStatsStrip
              myOpen={stats?.mine.open ?? 0}
              myOverdue={stats?.mine.overdue ?? 0}
              workspaceOpen={workspaceOpen}
              workspaceDone={stats?.workspace?.done ?? 0}
            />
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={refresh}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-[11px] font-semibold text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-white/20"
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">Refresh</span>
              </button>
              {canAssign ? (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="group inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-[12px] font-bold text-emerald-700 shadow-md transition hover:shadow-lg hover:brightness-105"
                >
                  <Plus className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
                  New task
                </button>
              ) : null}
            </div>
          </div>
        }
        below={
          <TasksTabs tab={tab} onChange={setTab} canAssign={canAssign} />
        }
      />

      {/* Filters strip */}
      {tab !== "reports" ? (
        <div className="border-b bg-card/60 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-6 py-3">
            <FilterSelect<Status | "all">
              value={statusFilter}
              onChange={setStatusFilter}
              icon={<CircleDot className="h-3.5 w-3.5" />}
              label="Status"
              options={[
                { value: "all", label: "All statuses" },
                ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
              ]}
            />
            <FilterSelect<Priority | "all">
              value={priorityFilter}
              onChange={setPriorityFilter}
              icon={<Flag className="h-3.5 w-3.5" />}
              label="Priority"
              options={[
                { value: "all", label: "All priorities" },
                ...PRIORITIES.map((p) => ({
                  value: p,
                  label: PRIORITY_TONE[p].label,
                })),
              ]}
            />
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search title / description…"
                className="h-9 w-64 rounded-lg border border-input bg-background pl-8 pr-3 text-xs font-medium outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl p-6">
          {error ? (
            <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {tab === "reports" ? (
            <ReportsTab stats={stats} />
          ) : tasks === null ? (
            <SkeletonList />
          ) : tasks.length === 0 ? (
            <EmptyState canAssign={canAssign} onCreate={() => setCreating(true)} />
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <TaskRowCard
                  key={t.id}
                  task={t}
                  currentMemberId={currentMemberId}
                  canEdit={canAssign || t.assigned_to === currentMemberId}
                  onOpen={() => setOpenTaskId(t.id)}
                  onChanged={refresh}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {creating ? (
        <CreateTaskModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
            emitTasksChanged();
          }}
        />
      ) : null}

      {openTaskId ? (
        <TaskDetailModal
          taskId={openTaskId}
          currentMemberId={currentMemberId}
          canEditAll={canAssign}
          onClose={() => setOpenTaskId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------

// Hero pill-style tabs — matches AutomationView for visual consistency.
function TasksTabs({
  tab,
  onChange,
  canAssign,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  canAssign: boolean;
}) {
  const items: Array<{
    id: Tab;
    label: string;
    sub: string;
    icon: typeof User;
    gated?: boolean;
  }> = [
    { id: "mine",    label: "My tasks",  sub: "Assigned to me",   icon: User },
    { id: "all",     label: "All tasks", sub: "Workspace queue",  icon: Users,    gated: true },
    { id: "reports", label: "Reports",   sub: "Per-agent stats",  icon: Sparkles, gated: true },
  ];
  return (
    <nav className="flex flex-wrap items-center gap-2">
      {items
        .filter((it) => !it.gated || canAssign)
        .map((it) => {
          const active = tab === it.id;
          const Icon = it.icon;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onChange(it.id)}
              className={cn(
                "group inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition",
                active
                  ? "bg-white text-emerald-800 shadow-lg shadow-emerald-900/25 ring-1 ring-white/40"
                  : "bg-white/10 text-white/85 ring-1 ring-inset ring-white/20 backdrop-blur hover:bg-white/15 hover:text-white",
              )}
            >
              <Icon className={cn("h-4 w-4", active ? "text-emerald-700" : "text-white/80")} />
              <span className="flex flex-col items-start leading-tight">
                <span>{it.label}</span>
                <span
                  className={cn(
                    "text-[10px] font-normal",
                    active ? "text-emerald-700/70" : "text-white/60",
                  )}
                >
                  {it.sub}
                </span>
              </span>
            </button>
          );
        })}
    </nav>
  );
}

// Compact hero stats — same translucent-card pattern as AutomationView's
// StatsStrip so every page reads from one design family.
function TasksStatsStrip({
  myOpen,
  myOverdue,
  workspaceOpen,
  workspaceDone,
}: {
  myOpen: number;
  myOverdue: number;
  workspaceOpen: number;
  workspaceDone: number;
}) {
  const items: Array<{
    icon: typeof User;
    label: string;
    value: string;
    alert?: boolean;
  }> = [
    { icon: User,         label: "Mine",    value: String(myOpen) },
    {
      icon: AlertTriangle,
      label: "Overdue",
      value: String(myOverdue),
      alert: myOverdue > 0,
    },
    { icon: Users,        label: "Open",    value: String(workspaceOpen) },
    { icon: CheckCircle2, label: "Done",    value: String(workspaceDone) },
  ];
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <div
            key={i}
            className={cn(
              "flex min-w-[88px] items-center gap-2.5 rounded-xl px-3 py-2 ring-1 ring-inset backdrop-blur-sm",
              it.alert
                ? "bg-rose-500/20 ring-rose-300/40"
                : "bg-white/10 ring-white/15",
            )}
          >
            <span
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                it.alert
                  ? "bg-rose-500/30 text-white ring-rose-300/40"
                  : "bg-white/15 text-white/85 ring-white/10",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="leading-tight">
              <div className="text-[16px] font-extrabold tabular-nums text-white">
                {it.value}
              </div>
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-white/65">
                {it.label}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FilterSelect<T extends string>({
  value,
  onChange,
  options,
  icon,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 text-[11px] font-semibold text-muted-foreground shadow-sm transition focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-200/40">
      <span className="text-emerald-600">{icon}</span>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="bg-transparent text-foreground outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-20 animate-pulse rounded-2xl border bg-card"
        />
      ))}
    </div>
  );
}

function EmptyState({
  canAssign,
  onCreate,
}: {
  canAssign: boolean;
  onCreate: () => void;
}) {
  return (
    <PremiumEmptyState
      icon={CheckCircle2}
      title="No tasks yet"
      description={
        canAssign
          ? "Pehla task assign karo — agent ko TopBar aur LeftNav mein red pulse turant dikhega."
          : "Your queue is empty — anything assigned to you will show up here with a red alert."
      }
      action={
        canAssign
          ? { label: "Create the first task", onClick: onCreate, icon: Plus }
          : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------
// Row card
// ---------------------------------------------------------------------

function TaskRowCard({
  task,
  currentMemberId,
  canEdit,
  onOpen,
  onChanged,
}: {
  task: TaskRow;
  currentMemberId: string;
  canEdit: boolean;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const overdue =
    !!task.due_at &&
    Date.parse(task.due_at) < Date.now() &&
    task.status !== "done" &&
    task.status !== "cancelled";

  const dueLabel = task.due_at ? formatDue(task.due_at) : null;
  const tone = STATUS_TONE[task.status];
  const ptone = PRIORITY_TONE[task.priority];

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card p-3 shadow-sm transition hover:border-emerald-300/60 hover:shadow",
        overdue && "border-rose-200/70 bg-rose-50/30",
      )}
    >
      <div className="flex items-start gap-3">
        {canEdit ? (
          <StatusToggle task={task} onChanged={onChanged} />
        ) : (
          <span
            className={cn(
              "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
              tone.bg,
              tone.ring,
            )}
          >
            <span className={cn("h-2 w-2 rounded-full", tone.dot)} />
          </span>
        )}

        <button
          type="button"
          onClick={onOpen}
          className="flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "text-sm font-semibold",
                task.status === "done" && "text-muted-foreground line-through",
              )}
            >
              {task.title}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset",
                ptone.bg,
                ptone.text,
                ptone.ring,
              )}
            >
              {ptone.label}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset",
                tone.bg,
                tone.text,
                tone.ring,
              )}
            >
              {STATUS_LABEL[task.status]}
            </span>
          </div>
          {task.description ? (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
              {task.description}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {task.assignee ? (
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                {memberLabel(task.assignee)}
              </span>
            ) : null}
            {task.contact ? (
              <Link
                href={`/dashboard?c=${encodeURIComponent(task.contact.id)}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0 text-[10px] font-semibold text-sky-700 ring-1 ring-inset ring-sky-200 hover:bg-sky-100"
              >
                <MessageSquare className="h-3 w-3" />
                {task.contact.name?.trim() ||
                  task.contact.wa_id ||
                  "Contact"}
              </Link>
            ) : null}
            {dueLabel ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[10px] font-semibold ring-1 ring-inset",
                  overdue
                    ? "bg-rose-50 text-rose-700 ring-rose-200"
                    : "bg-secondary text-foreground ring-border",
                )}
              >
                {overdue ? (
                  <AlertTriangle className="h-3 w-3" />
                ) : (
                  <Calendar className="h-3 w-3" />
                )}
                {dueLabel}
              </span>
            ) : null}
            {task.creator && task.creator.id !== currentMemberId ? (
              <span className="text-[10px]">
                by {memberLabel(task.creator)}
              </span>
            ) : null}
          </div>
        </button>
      </div>
    </article>
  );
}

function StatusToggle({
  task,
  onChanged,
}: {
  task: TaskRow;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setStatus(next: Status) {
    if (busy || next === task.status) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onChanged();
      emitTasksChanged();
    } catch {
      /* silent */
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const tone = STATUS_TONE[task.status];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={cn(
          "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset transition hover:scale-110",
          tone.bg,
          tone.ring,
        )}
        title={`Status: ${STATUS_LABEL[task.status]}`}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin text-foreground" />
        ) : task.status === "done" ? (
          <Check className="h-3 w-3 text-emerald-700" />
        ) : (
          <span className={cn("h-2 w-2 rounded-full", tone.dot)} />
        )}
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div className="absolute left-0 z-40 mt-1 w-40 overflow-hidden rounded-lg border bg-popover shadow-lg ring-1 ring-border">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-secondary",
                  s === task.status && "bg-secondary/60 font-semibold",
                )}
              >
                <span className="inline-flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      STATUS_TONE[s].dot,
                    )}
                  />
                  {STATUS_LABEL[s]}
                </span>
                {s === task.status ? <Check className="h-3 w-3" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Detail modal — title, description, status, comments thread
// ---------------------------------------------------------------------

function TaskDetailModal({
  taskId,
  currentMemberId,
  canEditAll,
  onClose,
  onChanged,
}: {
  taskId: string;
  currentMemberId: string;
  canEditAll: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [comments, setComments] = useState<
    Array<{
      id: string;
      body: string;
      kind: "comment" | "status_change" | "assignee_change" | "due_change";
      created_at: string;
      member: MemberLite | null;
    }>
  >([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
      const j = (await res.json()) as {
        task?: TaskRow;
        comments?: typeof comments;
      };
      if (j.task) setTask(j.task);
      if (j.comments) setComments(j.comments);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [comments.length]);

  async function postComment() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) throw new Error("post failed");
      setDraft("");
      await load();
    } catch {
      /* silent */
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: Status) {
    if (!task) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error("update failed");
      await load();
      onChanged();
      emitTasksChanged();
    } catch {
      /* silent */
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask() {
    if (!task) return;
    if (!confirm("Delete this task? This can't be undone.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      onChanged();
      emitTasksChanged();
      onClose();
    } catch {
      /* silent */
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-border">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <CheckCircle2 className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">Task</h3>
              <p className="text-[11px] text-muted-foreground">
                Status updates and comments are logged.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canEditAll ? (
              <button
                type="button"
                onClick={deleteTask}
                disabled={busy}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20"
                title="Delete task"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {loading || !task ? (
          <div className="flex flex-1 items-center justify-center px-5 py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <div className="space-y-3 border-b px-5 py-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold">{task.title}</span>
                  <PriorityChip priority={task.priority} />
                  <StatusChip status={task.status} />
                </div>
                {task.description ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {task.description}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {task.assignee ? (
                  <span className="inline-flex items-center gap-1">
                    <User className="h-3 w-3" />
                    Assigned to <strong>{memberLabel(task.assignee)}</strong>
                  </span>
                ) : null}
                {task.creator ? (
                  <span>by {memberLabel(task.creator)}</span>
                ) : null}
                {task.due_at ? (
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Due {formatDue(task.due_at)}
                  </span>
                ) : null}
                {task.contact ? (
                  <Link
                    href={`/dashboard?c=${encodeURIComponent(task.contact.id)}`}
                    className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0 text-[10px] font-semibold text-sky-700 ring-1 ring-inset ring-sky-200 hover:bg-sky-100"
                  >
                    <MessageSquare className="h-3 w-3" />
                    {task.contact.name?.trim() ||
                      task.contact.wa_id ||
                      "Contact"}
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                ) : null}
              </div>

              {/* Status switcher buttons — assignee or admin+ */}
              {canEditAll || task.assigned_to === currentMemberId ? (
                <div className="flex flex-wrap items-center gap-1">
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatus(s)}
                      disabled={busy || s === task.status}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset transition",
                        s === task.status
                          ? "cursor-default bg-emerald-600 text-white ring-emerald-600"
                          : "bg-white text-foreground ring-border hover:bg-secondary",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          STATUS_TONE[s].dot,
                        )}
                      />
                      {STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {/* Comments thread */}
            <div
              ref={scrollerRef}
              className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-3"
            >
              {comments.length === 0 ? (
                <p className="text-center text-[11px] text-muted-foreground">
                  No activity yet — leave the first comment.
                </p>
              ) : (
                comments.map((c) =>
                  c.kind === "comment" ? (
                    <div
                      key={c.id}
                      className={cn(
                        "max-w-[80%] rounded-2xl px-3 py-1.5 text-xs shadow-sm",
                        c.member?.id === currentMemberId
                          ? "ml-auto rounded-br-sm bg-emerald-600 text-white"
                          : "rounded-bl-sm bg-secondary text-foreground",
                      )}
                    >
                      {c.member?.id !== currentMemberId && c.member ? (
                        <div className="text-[10px] font-semibold opacity-80">
                          {memberLabel(c.member)}
                        </div>
                      ) : null}
                      <div className="whitespace-pre-wrap">{c.body}</div>
                      <div className="mt-0.5 text-right text-[9px] opacity-70">
                        {formatAgo(c.created_at)}
                      </div>
                    </div>
                  ) : (
                    <div
                      key={c.id}
                      className="text-center text-[10px] text-muted-foreground"
                    >
                      <span className="inline-flex items-center gap-1 rounded-full bg-secondary/60 px-2 py-0.5 ring-1 ring-inset ring-border">
                        <Clock className="h-2.5 w-2.5" />
                        {c.member ? memberLabel(c.member) + " · " : ""}
                        {c.body}
                        <span className="opacity-70">
                          · {formatAgo(c.created_at)}
                        </span>
                      </span>
                    </div>
                  ),
                )
              )}
            </div>

            {/* Composer */}
            <div className="border-t bg-secondary/30 px-5 py-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder="Add a comment…"
                  className="min-w-0 flex-1 resize-none rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                />
                <button
                  type="button"
                  onClick={postComment}
                  disabled={busy || !draft.trim()}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                  Send
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------
// Reports tab
// ---------------------------------------------------------------------

function ReportsTab({ stats }: { stats: Stats | null }) {
  if (!stats?.workspace) {
    return (
      <div className="rounded-2xl border border-dashed bg-card p-12 text-center text-xs text-muted-foreground">
        Workspace reports load once admin+ access is confirmed.
      </div>
    );
  }
  const w = stats.workspace;
  return (
    <div className="space-y-6">
      {/* Aggregate cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <ReportCard label="Total" value={w.total} tone="slate" />
        <ReportCard label="Open" value={w.open} tone="sky" />
        <ReportCard label="In progress" value={w.in_progress} tone="violet" />
        <ReportCard label="Blocked" value={w.blocked} tone="rose" />
        <ReportCard label="Done" value={w.done} tone="emerald" />
        <ReportCard
          label="Overdue"
          value={w.overdue}
          tone={w.overdue > 0 ? "rose" : "slate"}
        />
      </div>

      {/* Per-agent table */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-secondary/30 px-4 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Per agent
          </h3>
        </div>
        {w.per_agent.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            No assigned tasks yet.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-secondary/20 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">Agent</th>
                <th className="px-4 py-2 text-right">Open</th>
                <th className="px-4 py-2 text-right">Done</th>
                <th className="px-4 py-2 text-right">Overdue</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {w.per_agent.map((a) => (
                <tr key={a.member_id} className="hover:bg-secondary/30">
                  <td className="px-4 py-2 font-medium">
                    {a.full_name?.trim() || a.email}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {a.open}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-emerald-700">
                    {a.done}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2 text-right tabular-nums",
                      a.overdue > 0 && "font-semibold text-rose-600",
                    )}
                  >
                    {a.overdue}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ReportCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "slate" | "sky" | "violet" | "rose" | "emerald";
}) {
  const tones: Record<typeof tone, string> = {
    slate: "from-slate-50 to-slate-100 text-slate-800 ring-slate-200",
    sky: "from-sky-50 to-sky-100 text-sky-800 ring-sky-200",
    violet: "from-violet-50 to-violet-100 text-violet-800 ring-violet-200",
    rose: "from-rose-50 to-rose-100 text-rose-800 ring-rose-200",
    emerald: "from-emerald-50 to-emerald-100 text-emerald-800 ring-emerald-200",
  };
  return (
    <div
      className={cn(
        "rounded-xl bg-gradient-to-br px-3 py-2 ring-1 ring-inset",
        tones[tone],
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
        {label}
      </div>
      <div className="mt-0.5 text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function PriorityChip({ priority }: { priority: Priority }) {
  const tone = PRIORITY_TONE[priority];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset",
        tone.bg,
        tone.text,
        tone.ring,
      )}
    >
      {tone.label}
    </span>
  );
}

function StatusChip({ status }: { status: Status }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset",
        tone.bg,
        tone.text,
        tone.ring,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function memberLabel(m: MemberLite | { full_name: string | null; email: string }) {
  const n = m.full_name?.trim();
  if (n) return n;
  return m.email.split("@")[0] ?? m.email;
}

function numberLabel(n: BusinessNumber) {
  return (
    n.nickname?.trim() ||
    n.verified_name?.trim() ||
    n.display_phone_number ||
    n.phone_number_id
  );
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}
