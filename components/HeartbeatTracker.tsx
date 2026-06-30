"use client";

// Pings /api/heartbeat every 30s while the tab is visible + the
// browser is online. Drives user_activity_days for the Reports +
// score features. Mounted once at the dashboard layout level.
//
// Behaviour:
//   • visibilitychange listener — pauses while the tab is hidden so
//     a backgrounded tab doesn't accumulate "active" seconds.
//   • online listener — skips ticks while offline (the server would
//     reject anyway).
//   • secondsSinceLast — calculated client-side so a long gap (sleep,
//     network drop) doesn't get fully credited as active time. Server
//     clamps to MAX_INTERVAL_SECONDS as a second safety net.

import { useEffect, useRef } from "react";

const PING_INTERVAL_MS = 30_000;

export function HeartbeatTracker() {
  const lastPingAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;

    async function ping() {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      if (!navigator.onLine) return;
      const now = Date.now();
      const secondsSinceLast = Math.round((now - lastPingAt.current) / 1000);
      lastPingAt.current = now;
      try {
        await fetch("/api/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secondsSinceLast }),
          keepalive: true,
        });
      } catch {
        // Silent — network blips are common, next tick will retry.
      }
    }

    // First ping on mount so we record "first_seen_at" immediately.
    void ping();
    const id = window.setInterval(ping, PING_INTERVAL_MS);

    // When the tab regains focus, reset the timer so the next tick
    // measures "since we came back" rather than "since the tab went
    // to sleep last week".
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        lastPingAt.current = Date.now();
        void ping();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    // Fire one final ping when the tab closes so the last_seen_at is
    // accurate. keepalive lets it survive the unload.
    const onBeforeUnload = () => {
      const now = Date.now();
      const secondsSinceLast = Math.round((now - lastPingAt.current) / 1000);
      try {
        navigator.sendBeacon(
          "/api/heartbeat",
          new Blob([JSON.stringify({ secondsSinceLast })], {
            type: "application/json",
          }),
        );
      } catch {
        /* swallow */
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  return null;
}
