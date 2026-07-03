"use client";

// Fetches the CRM activity timeline for a given prospect, with built-in
// polling so the chat thread stays live while a contact is open. Pauses
// the poll when the tab is backgrounded (Page Visibility API) and fires
// an immediate refresh when the user comes back, so inactive tabs
// don't waste API calls but the visible chat is always fresh.

import { useCallback, useEffect, useRef, useState } from "react";

export interface LsqActivity {
  id: string;
  event_code: number;
  event_name: string;
  note: string | null;
  created_on: string | null;
  created_by: string | null;
  data: Array<{ key: string; value: string }>;
}

export type LsqActivitiesPhase = "loading" | "ready" | "error" | "empty";

interface State {
  phase: LsqActivitiesPhase;
  activities: LsqActivity[];
  error: string | null;
}

interface ApiResponse {
  configured?: boolean;
  ok?: boolean;
  activities?: LsqActivity[];
  error?: string;
}

interface UseLsqActivitiesOptions {
  /** Poll cadence in ms. Default 30s. Set to 0 to disable polling
   *  (useful for tests or one-shot loads). */
  pollMs?: number;
}

export function useLsqActivities(
  prospectId: string | null,
  options: UseLsqActivitiesOptions = {},
) {
  const pollMs = options.pollMs ?? 30_000;
  const [state, setState] = useState<State>({
    phase: "empty",
    activities: [],
    error: null,
  });

  // Tracks the AbortController of the in-flight fetch so we can cancel
  // it when prospectId flips back to null (e.g. operator turns off the
  // LSQ-in-chat toggle while a fetch is mid-flight). Without this, a
  // stale fetch could resolve AFTER we cleared state and re-populate
  // activities even though the toggle is now OFF.
  const inFlight = useRef<AbortController | null>(null);

  // `force` skips the server's 30s in-memory cache. Used by explicit
  // user-initiated refresh AND by the first fetch after prospect_id
  // changes, since a switch to a different lead must show that lead's
  // current state — not whatever was cached for the previous tab view.
  // Background polls pass force=false so they hit the shared cache and
  // don't pile up on LSQ when many tabs are open at once.
  const fetchOnce = useCallback(
    async (force: boolean) => {
      // Cancel any in-flight fetch before starting a new one (or
      // bailing because prospectId went null). Prevents the stale-
      // resolve race that re-populated activities after toggle OFF.
      inFlight.current?.abort();

      if (!prospectId) {
        inFlight.current = null;
        setState({ phase: "empty", activities: [], error: null });
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;

      // Clear immediately so a stale list from the previous prospect
      // never bleeds through during the fetch — the user explicitly
      // wants live sync with LSQ; stale-while-revalidating defeats that.
      setState({ phase: "loading", activities: [], error: null });
      try {
        const res = await fetch(
          `/api/lsq/activities?prospect_id=${encodeURIComponent(prospectId)}&limit=100${force ? "&force=1" : ""}`,
          { cache: "no-store", signal: controller.signal },
        );
        const json = (await res.json()) as ApiResponse;
        // Bail if a newer fetch (or an abort from prospectId→null)
        // superseded us between the network call and now.
        if (controller.signal.aborted) return;
        if (!res.ok || !json.configured || !json.ok) {
          setState({
            phase: "error",
            activities: [],
            error: json.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        const list = json.activities ?? [];
        setState({
          phase: list.length === 0 ? "empty" : "ready",
          activities: list,
          error: null,
        });
      } catch (e) {
        // AbortError is expected when we cancel — silently ignore.
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (controller.signal.aborted) return;
        setState({
          phase: "error",
          activities: [],
          error: e instanceof Error ? e.message : "Failed to load",
        });
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
      }
    },
    [prospectId],
  );

  const refresh = useCallback(() => fetchOnce(true), [fetchOnce]);
  const poll = useCallback(() => fetchOnce(false), [fetchOnce]);
  const initialFetch = useCallback(() => fetchOnce(true), [fetchOnce]);

  // First load + polling. The first fetch on every prospect_id change
  // bypasses the server cache (force=true) so a switch to a different
  // lead always lands on its current state — not whatever the previous
  // tab cached. Subsequent background polls hit the shared 30s cache.
  // Pauses while the tab is backgrounded; on foreground fires an
  // immediate poll and resumes the cycle. We jitter the first interval
  // by ±20% so 100 tabs that opened around the same time don't sync up
  // and stampede the API.
  useEffect(() => {
    initialFetch();
    if (!prospectId || pollMs <= 0) return;

    const jittered = pollMs * (0.9 + Math.random() * 0.2);
    let timer: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (timer) return;
      timer = setInterval(poll, jittered);
    };
    const stopPoll = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    function onVisibility() {
      if (document.hidden) {
        stopPoll();
      } else {
        poll();
        startPoll();
      }
    }

    if (!document.hidden) startPoll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopPoll();
      document.removeEventListener("visibilitychange", onVisibility);
      // Hard-cancel any fetch from this effect's prospectId so the
      // next effect's setState can't be overwritten by a late
      // resolve from this one.
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [prospectId, pollMs, poll, initialFetch]);

  return { ...state, refresh };
}
