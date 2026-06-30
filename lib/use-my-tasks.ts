"use client";

// Shared hook that polls /api/tasks/stats for the current user's open
// task count + overdue count. Used by:
//   - TopBar TasksChip       (number + red overdue dot)
//   - LeftNav Tasks nav item (red pulsing dot until 0 open)
//
// One hook so all consumers share the same fetch cadence and stay in
// sync — no duplicate intervals when both TopBar and LeftNav are
// mounted.
//
// 60s poll + re-fetch on tab focus + listens to a custom event
// "tasks-changed" so writes elsewhere (create / status change) can
// trigger an immediate refresh without waiting for the next tick.

import { useEffect, useState } from "react";

interface MyTaskCounts {
  open: number;
  overdue: number;
}

const EMPTY: MyTaskCounts = { open: 0, overdue: 0 };

export function useMyOpenTasks(): MyTaskCounts {
  const [counts, setCounts] = useState<MyTaskCounts>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/tasks/stats", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { mine?: MyTaskCounts };
        if (!cancelled && j.mine) setCounts(j.mine);
      } catch {
        /* keep last good value */
      }
    }
    void load();
    const intv = window.setInterval(load, 60_000);
    const onFocus = () => void load();
    const onChanged = () => void load();
    window.addEventListener("focus", onFocus);
    window.addEventListener("tasks-changed", onChanged);
    return () => {
      cancelled = true;
      window.clearInterval(intv);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("tasks-changed", onChanged);
    };
  }, []);

  return counts;
}

/** Fire after creating / updating a task so the shared poller refreshes
 *  immediately instead of waiting for the next 60-second tick. */
export function emitTasksChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("tasks-changed"));
}
