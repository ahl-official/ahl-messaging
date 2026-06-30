"use client";

// A WhatsApp call rendered inline in the chat thread — a compact,
// centered system-event pill (not a left/right message bubble) so the
// agent sees every call right where it happened in the conversation.

import { PhoneIncoming, PhoneMissed, PhoneOutgoing } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChatCall {
  id: string;
  direction: "inbound" | "outbound";
  status: string | null;
  start_at: string;
  duration_seconds: number | null;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function CallBubble({ call }: { call: ChatCall }) {
  const answered = (call.duration_seconds ?? 0) > 0;
  const inbound = call.direction === "inbound";

  const Icon = !answered ? PhoneMissed : inbound ? PhoneIncoming : PhoneOutgoing;
  const label = !answered
    ? inbound
      ? "Missed call"
      : "Call not answered"
    : inbound
      ? "Incoming call"
      : "Outgoing call";
  const tone = answered
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : "bg-rose-50 text-rose-700 ring-rose-200";

  const startDate = call.start_at ? new Date(call.start_at) : null;
  const time =
    startDate && !Number.isNaN(startDate.getTime())
      ? startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

  return (
    <div className="flex justify-center">
      <div
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium ring-1 ring-inset",
          tone,
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{label}</span>
        {answered && call.duration_seconds ? (
          <span className="opacity-70">
            · {formatDuration(call.duration_seconds)}
          </span>
        ) : null}
        {time ? <span className="opacity-60">· {time}</span> : null}
      </div>
    </div>
  );
}
