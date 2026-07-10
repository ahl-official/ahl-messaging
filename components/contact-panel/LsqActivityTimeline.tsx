"use client";

// CRM activity timeline — same data LSQ shows on the lead detail page,
// rendered inline in the contact-details panel. Auto-fetches when the
// prospect ID changes, groups activities by date (Today / Yesterday /
// Earlier this week / older), and uses iconography per event type so
// the agent can scan the timeline quickly.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Calendar,
  CheckSquare,
  ClipboardList,
  Edit3,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  RefreshCcw,
  StickyNote,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Activity {
  id: string;
  event_code: number;
  event_name: string;
  note: string | null;
  created_on: string | null;
  created_by: string | null;
}

interface ApiResponse {
  configured?: boolean;
  ok?: boolean;
  activities?: Activity[];
  error?: string;
}

type Phase = "loading" | "ready" | "error" | "empty";
type Bucket = "today" | "yesterday" | "thisweek" | "earlier";

export function LsqActivityTimeline({ prospectId }: { prospectId: string | null }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [activities, setActivities] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!prospectId) {
      setPhase("empty");
      setActivities([]);
      return;
    }
    setPhase("loading");
    setError(null);
    try {
      const res = await fetch(
        `/api/lsq/activities?prospect_id=${encodeURIComponent(prospectId)}&limit=50`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || !json.configured || !json.ok) {
        setPhase("error");
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      const list = json.activities ?? [];
      setActivities(list);
      setPhase(list.length === 0 ? "empty" : "ready");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [prospectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const grouped = groupByDate(activities);

  return (
    <section className="border-b">
      <header className="flex items-center justify-between gap-2 px-4 pt-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold tracking-tight">Activity History</h3>
          {activities.length > 0 ? (
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {activities.length}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={phase === "loading"}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          aria-label="Refresh"
        >
          {phase === "loading" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCcw className="h-3 w-3" />
          )}
        </button>
      </header>

      <div className="px-4 pb-4 pt-2">
        {phase === "loading" && activities.length === 0 ? (
          <Skeleton />
        ) : phase === "error" ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : phase === "empty" ? (
          <p className="rounded-md bg-secondary/40 px-3 py-2.5 text-[11px] text-muted-foreground">
            No activities yet for this lead.
          </p>
        ) : (
          <div className="space-y-3">
            {grouped.map((g) => (
              <div key={g.bucket}>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {bucketLabel(g.bucket)}
                </div>
                <ul className="space-y-1.5">
                  {g.items.map((a) => (
                    <ActivityItem key={a.id} activity={a} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ActivityItem({ activity }: { activity: Activity }) {
  const { Icon, tone } = iconForEvent(activity.event_code, activity.event_name);
  const nameLower = (activity.event_name ?? "").toLowerCase();
  const isCallEvent = nameLower.includes("call") || nameLower.includes("phone");

  // Our outbound webhook writes notes as
  //   "<message text> - (Insta WA <phone>)"
  // so LSQ Smart Views can group on the suffix. The suffix is noise
  // for the agent reading the timeline — strip it so what they see is
  // just the message body (or, for call events, nothing redundant).
  const cleanedNote = useMemo(() => {
    const raw = (activity.note ?? "").trim();
    if (!raw) return "";
    return raw.replace(/\s*-\s*\(.*?\)\s*$/s, "").trim();
  }, [activity.note]);

  // Calls render with just the event name (e.g. "WhatsApp Call ·
  // Missed") and time — the note for these is always the same
  // bracketed label which adds no information. Future: when a
  // recording URL lands on the activity payload, surface that here.
  const showNote = !isCallEvent && cleanedNote.length > 0;

  return (
    <li className="flex items-start gap-2.5 rounded-md bg-secondary/30 px-2.5 py-2">
      <span
        className={cn(
          "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
          tone,
        )}
      >
        <Icon className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12px] font-semibold">{activity.event_name}</span>
          <time className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatTime(activity.created_on)}
          </time>
        </div>
        {showNote ? (
          // No line-clamp — operator asked for the full note to be
          // visible without a click-to-expand interaction. Preserve
          // line breaks so multi-line replies stay readable.
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-snug text-foreground/85">
            {cleanedNote}
          </p>
        ) : null}
        {activity.created_by ? (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
            by {activity.created_by}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// LSQ doesn't ship a stable mapping from ActivityEvent codes to icons —
// we infer from the human-readable name (which is in every tenant) and
// fall back to a generic activity bullet.
function iconForEvent(_code: number, name: string): {
  Icon: typeof Activity;
  tone: string;
} {
  const n = name.toLowerCase();
  if (n.includes("whatsapp")) {
    return {
      Icon: MessageSquare,
      tone: "bg-primary/10 text-primary ring-primary/25",
    };
  }
  if (n.includes("call") || n.includes("phone")) {
    return { Icon: Phone, tone: "bg-blue-50 text-blue-700 ring-blue-200" };
  }
  if (n.includes("email")) {
    return { Icon: Mail, tone: "bg-violet-50 text-violet-700 ring-violet-200" };
  }
  if (n.includes("note")) {
    return { Icon: StickyNote, tone: "bg-amber-50 text-amber-700 ring-amber-200" };
  }
  if (n.includes("task")) {
    return { Icon: CheckSquare, tone: "bg-rose-50 text-rose-700 ring-rose-200" };
  }
  if (n.includes("modif") || n.includes("update")) {
    return { Icon: Edit3, tone: "bg-slate-50 text-slate-700 ring-slate-200" };
  }
  if (n.includes("workflow") || n.includes("automation")) {
    return { Icon: Workflow, tone: "bg-indigo-50 text-indigo-700 ring-indigo-200" };
  }
  if (n.includes("bot") || n.includes("system")) {
    return { Icon: Bot, tone: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200" };
  }
  return { Icon: ClipboardList, tone: "bg-secondary text-muted-foreground ring-border" };
}

interface Group {
  bucket: Bucket;
  items: Activity[];
}

function groupByDate(activities: Activity[]): Group[] {
  const buckets: Record<Bucket, Activity[]> = {
    today: [],
    yesterday: [],
    thisweek: [],
    earlier: [],
  };
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  for (const a of activities) {
    const t = a.created_on ? Date.parse(a.created_on.replace(" ", "T")) : 0;
    if (Number.isNaN(t) || t === 0) {
      buckets.earlier.push(a);
    } else if (t >= todayStart) {
      buckets.today.push(a);
    } else if (t >= yesterdayStart) {
      buckets.yesterday.push(a);
    } else if (t >= weekStart) {
      buckets.thisweek.push(a);
    } else {
      buckets.earlier.push(a);
    }
  }

  const out: Group[] = [];
  if (buckets.today.length)     out.push({ bucket: "today",     items: buckets.today });
  if (buckets.yesterday.length) out.push({ bucket: "yesterday", items: buckets.yesterday });
  if (buckets.thisweek.length)  out.push({ bucket: "thisweek",  items: buckets.thisweek });
  if (buckets.earlier.length)   out.push({ bucket: "earlier",   items: buckets.earlier });
  return out;
}

function bucketLabel(b: Bucket): string {
  switch (b) {
    case "today":     return "Today";
    case "yesterday": return "Yesterday";
    case "thisweek":  return "Earlier this week";
    case "earlier":   return "Older";
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  ) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-2.5 rounded-md bg-secondary/30 px-2.5 py-2">
          <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-secondary" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="h-3 w-24 rounded bg-secondary" />
            <div className="h-2.5 w-full rounded bg-secondary/70" />
            <div className="h-2 w-12 rounded bg-secondary/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900">
      <div className="font-semibold">Couldn&apos;t load activities</div>
      {message ? <div className="mt-0.5 break-words text-amber-800/80">{message}</div> : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-1.5 font-medium underline-offset-4 hover:underline"
      >
        Try again
      </button>
    </div>
  );
}
