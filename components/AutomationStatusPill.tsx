"use client";

// Tiny pill that lives above the composer in ChatWindow. Polls
// /api/contacts/[id]/automation-status every few seconds and renders one
// of three states:
//   - hidden        — automation off / no config / no business number
//   - "Bot is live" — bot will reply to the next inbound for this contact
//   - "Bot paused"  — agent is typing OR replied recently; AI quiet for
//                     N more seconds (countdown shown live)
//
// Use sparingly: contained inside the composer, not a full banner. The
// goal is to give the agent quiet awareness of bot activity without
// dominating the screen.

import { useEffect, useState } from "react";
import { Bot, Loader2, PauseCircle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

interface Status {
  enabled: boolean;
  paused: boolean;
  paused_reason: "typing" | "recent_reply" | null;
  resumes_in_sec: number;
  takeover_minutes: number;
  blocked?: boolean;
  blocked_reason?: string;
}

export function AutomationStatusPill({
  contactId,
  contactStatus,
}: {
  contactId: string | null;
  /** Hides the pill when the conversation is closed/resolved — the agent
   *  has marked it done, so dangling a "bot is live" indicator would just
   *  add noise. The pill returns automatically when a new inbound
   *  reopens the conversation (status flips back to "open"). */
  contactStatus?: "open" | "closed" | null;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  // Local countdown so the seconds tick visibly between server polls.
  const [now, setNow] = useState<number>(() => Date.now());
  const [resumesAt, setResumesAt] = useState<number | null>(null);
  const [unblocking, setUnblocking] = useState(false);

  async function unblock() {
    if (!contactId) return;
    setUnblocking(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/automation-status`, { method: "POST" });
      if (res.ok) setStatus((s) => (s ? { ...s, blocked: false } : s));
    } finally {
      setUnblocking(false);
    }
  }

  // Server poll. Skipped (and any in-flight cleared) when the chat is
  // closed — no point spending a request every 5s on a resolved
  // conversation. We could not put this guard at the top of the
  // component because that would early-return BEFORE the hooks below,
  // breaking the rules-of-hooks ordering.
  const closed = contactStatus === "closed";
  useEffect(() => {
    if (!contactId || closed) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/contacts/${contactId}/automation-status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as Status;
        if (cancelled) return;
        setStatus(json);
        if (json.paused && json.resumes_in_sec > 0) {
          setResumesAt(Date.now() + json.resumes_in_sec * 1000);
        } else {
          setResumesAt(null);
        }
      } catch {
        /* non-critical */
      }
    }
    load();
    const id = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [contactId, closed]);

  // Local 1-second tick — only when paused with a known resume time.
  useEffect(() => {
    if (!resumesAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resumesAt]);

  if (closed || !status || !status.enabled) return null;

  const remainingSec = resumesAt ? Math.max(0, Math.round((resumesAt - now) / 1000)) : 0;

  if (status.blocked) {
    return (
      <div className="flex items-center justify-between gap-3 border-b bg-rose-50 pl-6 pr-4 py-1.5 text-[11px] text-rose-800">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Chat blocked due to app guidelines — bot paused. You can still reply manually.</span>
        </span>
        <button
          type="button"
          onClick={unblock}
          disabled={unblocking}
          className="shrink-0 rounded-md border border-rose-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
        >
          {unblocking ? "Unblocking…" : "Unblock bot"}
        </button>
      </div>
    );
  }

  if (status.paused) {
    const reasonLabel =
      status.paused_reason === "typing"
        ? "You're typing"
        : status.paused_reason === "recent_reply"
          ? "You just replied"
          : "Human active";
    return (
      <div className="flex items-center justify-between gap-3 border-b bg-amber-50/70 pl-6 pr-4 py-1.5 text-[11px] text-amber-900">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
          <PauseCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Bot paused — {reasonLabel}</span>
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-amber-700/80">
          {remainingSec > 0 ? `Resumes in ${formatRemaining(remainingSec)}` : "Resuming…"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b bg-primary/10 pl-6 pr-4 py-1.5 text-[11px] text-primary">
      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#6098FF] opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <Bot className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Bot is live — will reply to the next inbound</span>
      </span>
      <span className="shrink-0 text-[10px] text-primary/80">
        Auto-pauses for {status.takeover_minutes}m when you type
      </span>
    </div>
  );
}

function formatRemaining(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// Loader placeholder kept for callers that want a stable height even before
// the first poll resolves. Currently unused — pill renders nothing until
// data arrives, which is fine for a non-essential indicator.
export function _AutomationStatusPlaceholder() {
  return (
    <div className="flex items-center gap-2 border-b bg-secondary/40 px-4 py-1.5 text-[11px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      Checking automation status…
    </div>
  );
}
