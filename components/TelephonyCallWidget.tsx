"use client";

// Floating call widget for the Telephony connector (PSTN click-to-call).
// Mounted once in the dashboard layout. The chat Call menu dispatches a
// `qht-telephony-call` window event on a successful dial; this shows a small
// call card with a live elapsed timer until dismissed.
//
// NOTE: the actual call rings on the agent's phone, so we don't get a true
// "answered" moment in the browser. The timer is elapsed-since-dial; the exact
// talk duration is logged to the chat later by the operator's Call Log webhook.

import { useEffect, useRef, useState } from "react";
import { Phone, X } from "lucide-react";

interface CallInfo {
  name: string;
  phone: string;
  provider?: string;
}

export function TelephonyCallWidget() {
  const [call, setCall] = useState<CallInfo | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [phase, setPhase] = useState<"dialing" | "in_call">("dialing");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function onCall(e: Event) {
      const d = (e as CustomEvent<CallInfo>).detail;
      if (!d) return;
      setCall(d);
      setSeconds(0);
      setPhase("dialing");
    }
    window.addEventListener("qht-telephony-call", onCall as EventListener);
    return () => window.removeEventListener("qht-telephony-call", onCall as EventListener);
  }, []);

  useEffect(() => {
    if (!call) return;
    // No operator events yet → after a short ring, switch to the running timer.
    const ring = setTimeout(() => setPhase("in_call"), 3500);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      clearTimeout(ring);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [call]);

  if (!call) return null;

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const initial = (call.name?.trim()?.[0] ?? "#").toUpperCase();

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-72 overflow-hidden rounded-2xl border bg-card shadow-2xl">
      <div className="flex items-center justify-between bg-gradient-to-br from-emerald-600 to-emerald-700 px-4 py-2.5 text-white">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
          <Phone className="h-3.5 w-3.5" /> Telephony call
        </span>
        <button type="button" onClick={() => setCall(null)} title="Close (call phone pe jari rahegi)" className="rounded p-0.5 text-white/80 transition hover:bg-white/20 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-3 px-4 py-4">
        <div className="relative">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-lg font-bold text-emerald-700">{initial}</div>
          {phase === "dialing" ? (
            <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-emerald-400/60" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{call.name || "Unknown"}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{call.phone}</div>
          <div className="mt-0.5 text-[11px]">
            {phase === "dialing" ? (
              <span className="font-medium text-amber-600">Dialing… apne phone pe uthao</span>
            ) : (
              <span className="font-semibold tabular-nums text-emerald-700">In call · {mmss}</span>
            )}
          </div>
        </div>
      </div>

      <div className="border-t bg-secondary/20 px-4 py-2 text-[10px] leading-snug text-muted-foreground">
        Call aapke phone pe ring ho rahi hai. Exact duration call khatam hone par chat me log hogi.
      </div>
    </div>
  );
}

/** Helper for callers — dispatch the widget. */
export function startTelephonyCallWidget(info: CallInfo) {
  window.dispatchEvent(new CustomEvent("qht-telephony-call", { detail: info }));
}
