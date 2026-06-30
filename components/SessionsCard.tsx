"use client";

// Lists the active + recent sessions for one user, with a
// "Logout other devices" action. Two modes:
//   - scope="self"            → caller's own sessions, GET /api/sessions
//   - scope="member" + id     → that member's sessions (admin+),
//                                GET /api/sessions?member_id=<id>
//
// Each row shows device (Chrome · macOS), location (city, country),
// last-seen relative time, and an active dot when within 5 min.

import { useCallback, useEffect, useState } from "react";
import { Loader2, LogOut, MapPin, Monitor, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface ApiSession {
  id: string;
  ip: string | null;
  user_agent: string | null;
  location: string | null;
  device: string | null;
  started_at: string;
  last_seen_at: string;
  active: boolean;
  is_current: boolean;
}

interface Props {
  scope: "self" | "member";
  memberId?: string;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

export function SessionsCard({ scope, memberId }: Props) {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url =
        scope === "member" && memberId
          ? `/api/sessions?member_id=${encodeURIComponent(memberId)}`
          : "/api/sessions";
      const res = await fetch(url, { cache: "no-store" });
      const j = (await res.json()) as { sessions?: ApiSession[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setSessions(j.sessions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [scope, memberId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeOne(id: string) {
    if (!confirm("Sign out this device?")) return;
    setBusyAction(id);
    try {
      await fetch(`/api/sessions?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await load();
    } finally {
      setBusyAction(null);
    }
  }

  async function revokeAllOther() {
    if (
      !confirm(
        "Sign out from every other device? Your current tab stays logged in.",
      )
    ) {
      return;
    }
    setBusyAction("__bulk__");
    try {
      const url =
        scope === "member" && memberId
          ? `/api/sessions?member_id=${encodeURIComponent(memberId)}`
          : "/api/sessions";
      await fetch(url, { method: "DELETE" });
      await load();
    } finally {
      setBusyAction(null);
    }
  }

  const activeCount = sessions.filter((s) => s.active).length;
  const hasOtherActive = sessions.some((s) => s.active && !s.is_current);

  return (
    <section className="rounded-2xl border bg-card p-5 shadow-sm">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
            <Monitor className="h-4 w-4 text-emerald-600" />
            {scope === "self" ? "Your active sessions" : "Active sessions"}
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
              {activeCount}
            </span>
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Where {scope === "self" ? "you" : "this member"} are signed in.
            Active = active within the last 5 minutes.
          </p>
        </div>
        {hasOtherActive ? (
          <button
            type="button"
            onClick={revokeAllOther}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            {busyAction === "__bulk__" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldOff className="h-3.5 w-3.5" />
            )}
            {scope === "self" ? "Logout other devices" : "Logout from all"}
          </button>
        ) : null}
      </header>

      {loading ? (
        <div className="grid h-20 place-items-center text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </span>
        </div>
      ) : error ? (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">
          {error}
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sessions recorded.</p>
      ) : (
        <ul className="divide-y">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-start gap-3 py-2.5">
              <span
                className={cn(
                  "mt-0.5 inline-flex h-2 w-2 shrink-0 rounded-full",
                  s.active
                    ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]"
                    : "bg-slate-300",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>{s.device ?? "Unknown device"}</span>
                  {s.is_current ? (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                      This device
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  {s.location ? (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {s.location}
                    </span>
                  ) : null}
                  {s.ip ? (
                    <span className="font-mono">{s.ip}</span>
                  ) : null}
                  <span>·</span>
                  <span>last active {formatRelative(s.last_seen_at)}</span>
                </div>
              </div>
              {!s.is_current && s.active ? (
                <button
                  type="button"
                  onClick={() => revokeOne(s.id)}
                  disabled={busyAction !== null}
                  className="inline-flex h-7 items-center gap-1 rounded-md text-[11px] font-semibold text-rose-700 hover:bg-rose-50 px-2 disabled:opacity-50"
                  title="Sign out this device"
                >
                  {busyAction === s.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <LogOut className="h-3 w-3" />
                  )}
                  Sign out
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
