"use client";

// Settings → Team → Sessions sub-tab. Owner / admin view of EVERY
// member's login activity in one place: how many devices they're
// signed in on, last location, and a per-user "Logout from all
// devices" action. Expanding a row reveals each individual session.

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MapPin,
  Monitor,
  ShieldOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ApiSession {
  id: string;
  ip: string | null;
  location: string | null;
  device: string | null;
  started_at: string;
  last_seen_at: string;
  active: boolean;
  is_current: boolean;
}

interface UserRow {
  member_id: string;
  email: string;
  name: string;
  role: string;
  active_count: number;
  total_count: number;
  last_seen_at: string | null;
  last_location: string | null;
  sessions: ApiSession[];
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.round(hr / 24)} day ago`;
}

export function AllSessionsView() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions?all=1", { cache: "no-store" });
      const j = (await res.json()) as { users?: UserRow[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setUsers(j.users ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function logoutAll(memberId: string, name: string) {
    if (!confirm(`Sign ${name} out from ALL their devices?`)) return;
    setBusy(memberId);
    try {
      await fetch(`/api/sessions?member_id=${encodeURIComponent(memberId)}`, {
        method: "DELETE",
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="rounded-2xl border bg-card shadow-sm">
        <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <Monitor className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Login activity</h2>
              <p className="text-[11px] text-muted-foreground">
                Every member&apos;s active sessions, locations &amp; devices.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs font-semibold hover:bg-secondary"
          >
            Refresh
          </button>
        </header>

        {loading ? (
          <div className="grid h-32 place-items-center text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </span>
          </div>
        ) : error ? (
          <div className="m-4 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">
            {error}
          </div>
        ) : users.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No login activity recorded yet.
          </p>
        ) : (
          <ul className="divide-y">
            {users.map((u) => {
              const open = expanded.has(u.member_id);
              return (
                <li key={u.member_id}>
                  <div className="flex items-center gap-3 px-5 py-3">
                    <button
                      type="button"
                      onClick={() => toggle(u.member_id)}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
                    >
                      {open ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">
                          {u.name}
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0 text-[10px] font-bold",
                            u.active_count > 0
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-slate-200 text-slate-600",
                          )}
                        >
                          {u.active_count} active
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        {u.last_location ? (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {u.last_location}
                          </span>
                        ) : null}
                        <span>·</span>
                        <span>last seen {formatRelative(u.last_seen_at)}</span>
                      </div>
                    </div>
                    {u.active_count > 0 ? (
                      <button
                        type="button"
                        onClick={() => logoutAll(u.member_id, u.name)}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                      >
                        {busy === u.member_id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <ShieldOff className="h-3 w-3" />
                        )}
                        Logout all
                      </button>
                    ) : null}
                  </div>
                  {open ? (
                    <ul className="space-y-1 bg-secondary/30 px-5 pb-3 pl-14">
                      {u.sessions.length === 0 ? (
                        <li className="py-2 text-[11px] text-muted-foreground">
                          No sessions recorded.
                        </li>
                      ) : (
                        u.sessions.map((s) => (
                          <li
                            key={s.id}
                            className="flex items-center gap-2 py-1.5 text-[11px]"
                          >
                            <span
                              className={cn(
                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                s.active ? "bg-emerald-500" : "bg-slate-300",
                              )}
                            />
                            <span className="font-medium">
                              {s.device ?? "Unknown device"}
                            </span>
                            {s.location ? (
                              <span className="text-muted-foreground">
                                · {s.location}
                              </span>
                            ) : null}
                            {s.ip ? (
                              <span className="font-mono text-muted-foreground">
                                · {s.ip}
                              </span>
                            ) : null}
                            <span className="text-muted-foreground">
                              · {formatRelative(s.last_seen_at)}
                            </span>
                          </li>
                        ))
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
