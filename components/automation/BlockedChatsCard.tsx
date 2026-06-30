"use client";

// Card for the Automation → AI Intent tab: lists chats the bot has
// auto-blocked for repeated off-topic / personal messages, with a one-click
// Unblock. Stays hidden when nothing is blocked so it adds no noise.

import { useCallback, useEffect, useState } from "react";
import { ShieldAlert, RefreshCcw } from "lucide-react";
import { cn } from "@/lib/utils";

interface BlockedChat {
  id: string;
  wa_id: string;
  name: string | null;
  profile_name: string | null;
  business_phone_number_id: string | null;
  bot_blocked_at: string | null;
  offtopic_strikes: number | null;
}

function fmt(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(d);
}

export function BlockedChatsCard() {
  const [chats, setChats] = useState<BlockedChat[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/automation/blocked-chats", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { chats?: BlockedChat[] };
      setChats(json.chats ?? []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function unblock(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/contacts/${id}/automation-status`, { method: "POST" });
      if (res.ok) setChats((prev) => (prev ?? []).filter((c) => c.id !== id));
    } finally {
      setBusy(null);
    }
  }

  // Hidden entirely when nothing's blocked (after the first load).
  if (chats !== null && chats.length === 0) return null;

  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/40">
      <div className="flex items-center gap-2 border-b border-rose-100 px-4 py-2.5">
        <ShieldAlert className="h-4 w-4 text-rose-600" />
        <h3 className="text-sm font-bold text-rose-900">
          Blocked chats {chats ? `(${chats.length})` : ""}
        </h3>
        <span className="text-[11px] text-rose-700/70">Bot muted — off-topic / app guidelines. Reply manually or unblock.</span>
        <button
          type="button"
          onClick={load}
          className="ml-auto rounded-md p-1 text-rose-700 hover:bg-rose-100"
          title="Refresh"
        >
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
      <div className="divide-y divide-rose-100">
        {chats === null ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">Loading…</div>
        ) : (
          chats.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">
                  {c.name || c.profile_name || c.wa_id}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  +{c.wa_id} · {c.offtopic_strikes ?? 0} strikes · blocked {fmt(c.bot_blocked_at)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => unblock(c.id)}
                disabled={busy === c.id}
                className="shrink-0 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                {busy === c.id ? "Unblocking…" : "Unblock"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
