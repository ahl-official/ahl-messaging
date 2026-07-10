"use client";

// Full-width CRM lead-stage funnel above the inbox. Each stage is an
// arrow/chevron segment carrying a LIVE contact count; clicking one
// filters the conversation list to chats whose `lsq_stage` matches.
// Clicking the active segment again (or "All") clears the filter.
//
// Counts come from /api/lsq/stage-counts (scoped to the caller's
// numbers) and refresh on a short poll so the funnel stays live.
//
// No scrollbar — the strip scrolls via the left/right arrow buttons or
// by dragging it sideways.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Eye, EyeOff, List, MessageSquare, Search } from "lucide-react";
import { motion } from "motion/react";
import { solidToneByIndex } from "@/lib/chip-tones";
import { cn } from "@/lib/utils";
import { ALL_LEAD_STAGES } from "@/lib/lead-stages";

/** Fallback funnel used while /api/lsq/stages is loading or when LSQ
 *  isn't configured — the full canonical funnel so every stage shows. */
export const FALLBACK_LEAD_STAGES = ALL_LEAD_STAGES;

/** @deprecated Re-export for backwards compatibility. New code should
 *  use the dynamic list via `useLeadStages()` so admins can add/rename
 *  stages in LSQ without a redeploy. */
export const LEAD_STAGES = FALLBACK_LEAD_STAGES;

// Width of the chevron's point / notch, in px. Segments overlap by this
// much so each point slots into the next segment's notch.
const ARROW = 14;

function fmtCount(n: number | null): string {
  if (n === null) return "";
  // Raw count — exact is more useful here than a rounded "1.2k", and
  // even 5-digit numbers fit the chevron.
  return n.toLocaleString();
}

// Words that read better at the START of the next line than dangling at the
// end of one ("HT Care" / "& Medicine", not "HT Care &" / "Medicine").
const STAGE_CONNECTORS = new Set([
  "to", "for", "by", "of", "in", "on", "the", "a", "and", "or", "&",
]);

/** Wrap a stage name into BALANCED lines that fit the chevron — at most 3
 *  lines (a 4th would overflow the 66px height and cramp the text). Short
 *  names stay on one or two lines; long multi-word names get distributed
 *  evenly. Breaks on spaces and after a "/" (so "HT Done/Medicine" can split).
 */
function stageLines(stage: string): string[] {
  // Treat a "/" as a breakable point: "Treatment/Medication" → two words.
  const words = stage.replace(/\//g, "/ ").split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words;

  const MAX = 12; // soft max chars/line — keeps each chevron compact.

  // Best contiguous split into exactly k lines: minimise the longest line,
  // with a small penalty for a line that ENDS in a connector word.
  const bestFor = (k: number): string[] => {
    let best: string[] = [];
    let bestCost = Infinity;
    const rec = (start: number, left: number, acc: string[][]) => {
      if (left === 1) {
        const groups = [...acc, words.slice(start)];
        const joined = groups.map((g) => g.join(" "));
        let cost = Math.max(...joined.map((l) => l.length));
        for (let g = 0; g < groups.length - 1; g++) {
          const w = groups[g][groups[g].length - 1].toLowerCase();
          if (STAGE_CONNECTORS.has(w)) cost += 4;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = joined;
        }
        return;
      }
      for (let end = start + 1; end <= words.length - (left - 1); end++) {
        rec(end, left - 1, [...acc, words.slice(start, end)]);
      }
    };
    rec(0, k, []);
    return best;
  };

  // Use the FEWEST lines whose longest line fits MAX (cap 3). If even 3 lines
  // can't get under MAX (a single long word/token), fall back to the split
  // with the smallest longest-line — and on a tie, the fewest lines.
  let fallback: string[] = [];
  let fallbackMax = Infinity;
  for (let k = 1; k <= Math.min(3, words.length); k++) {
    const lines = bestFor(k);
    const mx = Math.max(...lines.map((l) => l.length));
    if (mx <= MAX) return lines; // first (fewest-line) split that fits
    if (mx < fallbackMax) {
      fallbackMax = mx;
      fallback = lines;
    }
  }
  return fallback;
}

export function LeadStageStrip({
  selected,
  onSelect,
  onOpenList,
}: {
  selected: string | null;
  onSelect: (stage: string | null) => void;
  /** Open the stage's chats in the centred list-view modal. */
  onOpenList: (stage: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  // Collapse the whole strip to give the chat window its height back.
  // Persisted so the operator's choice survives reloads. Init false to keep
  // SSR/first-paint in sync; the stored pref is applied on mount.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("lsq-strip-collapsed") === "1");
    } catch {
      /* private mode / no storage — just stay expanded */
    }
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem("lsq-strip-collapsed", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Per-stage click menu — "chat window" vs "list view". Anchored to
  // the clicked segment via fixed coords (the scroll container clips,
  // so the menu can't live inside it).
  const [menu, setMenu] = useState<
    { stage: string; left: number; top: number } | null
  >(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // Stage quick-search — a small icon at the strip's end opens a popover to
  // filter all stages by name (handy with 60+ stages) and jump to one.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchBtnRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchPos, setSearchPos] = useState<{ top: number; left: number } | null>(null);

  // Live per-stage counts. null until the first fetch lands.
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // Dynamic stage list from /api/lsq/stages — falls back to the
  // hardcoded list while loading or if LSQ isn't reachable. Order is
  // LSQ's funnel ordering (Active Stages → DisplayOrder).
  const [stages, setStages] = useState<readonly string[]>(FALLBACK_LEAD_STAGES);
  // Per-agent hidden stages (right-click → "Hide from my view"). Synced
  // to team_members.hidden_stages so the preference follows the agent
  // across devices.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Right-click context menu — anchored at the click point, shows
  // "Hide this stage" or "Unhide" depending on the stage's current
  // state. Closes on outside-click / scroll / esc.
  const [ctxMenu, setCtxMenu] = useState<
    { stage: string; left: number; top: number; isHidden: boolean } | null
  >(null);
  // Inline panel showing the full hidden list + "Unhide all" + per-stage
  // restore. Opens from the "Show hidden (N)" button at the strip end.
  const [hiddenPanelOpen, setHiddenPanelOpen] = useState(false);
  const hiddenBtnRef = useRef<HTMLButtonElement | null>(null);
  // Computed position for the portal-rendered panel (strip's scroll
  // container has overflow-x-auto which clips an absolute child).
  const [hiddenPanelPos, setHiddenPanelPos] = useState<
    { top: number; right: number } | null
  >(null);
  useEffect(() => {
    if (!hiddenPanelOpen) return;
    function update() {
      const el = hiddenBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setHiddenPanelPos({
        top: r.bottom + 4,
        right: Math.max(8, window.innerWidth - r.right),
      });
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [hiddenPanelOpen]);

  useEffect(() => {
    let cancelled = false;
    async function loadStages() {
      try {
        const res = await fetch("/api/lsq/stages", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { stages?: string[] };
        if (cancelled) return;
        if (Array.isArray(j.stages) && j.stages.length > 0) {
          setStages(j.stages);
        }
      } catch {
        /* stay on fallback list */
      }
    }
    void loadStages();
    // Re-fetch on tab focus so an admin who just added a stage in LSQ
    // sees it the next time they come back without a full reload.
    const onFocus = () => void loadStages();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Load the caller's hidden-stages preference once on mount. Failures
  // are silent — strip just shows everything (the safe default).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me/hidden-stages", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { hidden?: string[] };
        if (!cancelled && Array.isArray(j.hidden)) {
          setHidden(new Set(j.hidden));
        }
      } catch {
        /* default = nothing hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist hidden set to the backend. Optimistic — local state is the
  // source of truth for instant feedback; PUT failure just logs a
  // warning, the next reload will sync from server.
  const persistHidden = useCallback(async (next: Set<string>) => {
    try {
      await fetch("/api/me/hidden-stages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: Array.from(next) }),
      });
    } catch (e) {
      console.warn("[stage-strip] hide-state save failed", e);
    }
  }, []);

  const hideStage = useCallback(
    (stage: string) => {
      // Optimistic: drop the active filter if the operator just hid the
      // currently-selected stage so the list doesn't end up filtered to
      // an invisible chevron.
      if (selected === stage) onSelect(null);
      setHidden((prev) => {
        const next = new Set(prev);
        next.add(stage);
        void persistHidden(next);
        return next;
      });
    },
    [persistHidden, selected, onSelect],
  );

  const unhideStage = useCallback(
    (stage: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(stage);
        void persistHidden(next);
        return next;
      });
    },
    [persistHidden],
  );

  const unhideAll = useCallback(() => {
    setHidden(() => {
      void persistHidden(new Set());
      return new Set();
    });
    setHiddenPanelOpen(false);
  }, [persistHidden]);

  // Right-click handler — opens the context menu at the click point.
  // We pass it on every chevron's `onContextMenu`.
  const openContextMenu = useCallback(
    (e: React.MouseEvent, stage: string) => {
      e.preventDefault();
      const isHidden = hidden.has(stage);
      setCtxMenu({
        stage,
        left: Math.min(e.clientX, window.innerWidth - 200),
        top: e.clientY + 4,
        isHidden,
      });
    },
    [hidden],
  );

  // Close context menu on outside-click / scroll / esc.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // Filtered stages — what the strip actually renders. Hidden ones are
  // never shown; the count survives in `hidden.size` for the "Show
  // hidden" button.
  const visibleStages = stages.filter((s) => !hidden.has(s));

  // Position the search popover under its trigger + focus the input.
  useEffect(() => {
    if (!searchOpen) return;
    function update() {
      const el = searchBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // The Find button now lives on the far right — right-align the 256px
      // popover to its edge so it opens leftward instead of off-screen.
      setSearchPos({ top: r.bottom + 4, left: Math.max(8, r.right - 256) });
    }
    update();
    requestAnimationFrame(() => searchInputRef.current?.focus());
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [searchOpen]);

  // Jump to a stage picked from search: unhide it if needed, apply the
  // filter, close the popover, and scroll the strip so its chevron shows.
  const goToStage = useCallback(
    (stage: string) => {
      if (hidden.has(stage)) unhideStage(stage);
      onSelect(stage);
      setSearchOpen(false);
      setSearchQuery("");
      requestAnimationFrame(() => {
        try {
          scrollRef.current
            ?.querySelector(`[data-stage="${stage}"]`)
            ?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        } catch {
          /* odd characters in the name — selection still applied */
        }
      });
    },
    [hidden, unhideStage, onSelect],
  );

  // Search across ALL stages (hidden included, so you can jump to one).
  const searchResults = stages.filter((s) =>
    s.toLowerCase().includes(searchQuery.trim().toLowerCase()),
  );

  const loadCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/lsq/stage-counts", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as {
        counts?: Record<string, number>;
        total?: number;
      };
      const next = j.counts ?? {};
      // Skip the state-set when nothing changed — keeps the 30s poll
      // from re-rendering the 20 chevron segments on every tick.
      setCounts((prev) => {
        if (!prev) return next;
        const a = Object.keys(prev);
        const b = Object.keys(next);
        if (a.length !== b.length) return next;
        for (const k of a) if (prev[k] !== next[k]) return next;
        return prev;
      });
      setTotal((prev) => (prev === (j.total ?? 0) ? prev : (j.total ?? 0)));
    } catch {
      /* non-fatal — funnel just shows no counts */
    }
  }, []);

  useEffect(() => {
    loadCounts();
    // Keep the funnel live as stages change (webhook / backfill / agents).
    const t = setInterval(loadCounts, 30_000);
    // Re-fetch the moment the operator toggles a number on/off, so the
    // strip is scoped to exactly the numbers the inbox is showing.
    const onNumbers = () => loadCounts();
    window.addEventListener("business-numbers-changed", onNumbers);
    return () => {
      clearInterval(t);
      window.removeEventListener("business-numbers-changed", onNumbers);
    };
  }, [loadCounts]);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    // Also re-measure on scroll — the strip scrolls horizontally via
    // drag, wheel, and the arrow buttons. Without this, `canLeft` /
    // `canRight` stay frozen at their mount values and the left arrow
    // disappears mid-scroll even though more content is still off-screen.
    const el = scrollRef.current;
    el?.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      el?.removeEventListener("scroll", measure);
    };
  }, [measure, counts, stages]);

  // Drag the strip sideways with the pointer (in addition to the arrows).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let dragging = false;
    let startX = 0;
    let startLeft = 0;
    let moved = false;
    function onDown(e: PointerEvent) {
      if (!el || (e.target as HTMLElement).closest("button")) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startLeft = el.scrollLeft;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    }
    function onMove(e: PointerEvent) {
      if (!dragging || !el) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      el.scrollLeft = startLeft - dx;
    }
    function onUp(e: PointerEvent) {
      if (!el) return;
      dragging = false;
      el.releasePointerCapture(e.pointerId);
      el.style.cursor = "";
      if (moved) {
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
          el.removeEventListener("click", swallow, true);
        };
        el.addEventListener("click", swallow, true);
      }
    }
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const nudge = (dir: -1 | 1) =>
    scrollRef.current?.scrollBy({ left: dir * 280, behavior: "smooth" });

  // Hover-to-scroll — just point at an arrow and the strip glides on
  // its own via a smooth rAF loop; no clicking needed. Stops on leave
  // or when the end is reached.
  const autoRef = useRef<number | null>(null);
  const stopAuto = useCallback(() => {
    if (autoRef.current != null) cancelAnimationFrame(autoRef.current);
    autoRef.current = null;
  }, []);
  const startAuto = useCallback(
    (dir: -1 | 1) => {
      stopAuto();
      const step = () => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollLeft += dir * 7;
        const atEnd =
          dir > 0
            ? el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
            : el.scrollLeft <= 0;
        if (atEnd) {
          autoRef.current = null;
          return;
        }
        autoRef.current = requestAnimationFrame(step);
      };
      autoRef.current = requestAnimationFrame(step);
    },
    [stopAuto],
  );
  useEffect(() => stopAuto, [stopAuto]);

  // Chevron clip-paths: the first segment has a flat left edge, the rest
  // have an inward notch so the previous segment's point slots in.
  const clipFirst = `polygon(0 0, calc(100% - ${ARROW}px) 0, 100% 50%, calc(100% - ${ARROW}px) 100%, 0 100%)`;
  const clipMid = `polygon(0 0, calc(100% - ${ARROW}px) 0, 100% 50%, calc(100% - ${ARROW}px) 100%, 0 100%, ${ARROW}px 50%)`;

  // Soft, clip-path-aware depth shadow. `drop-shadow` (a filter)
  // follows the actual chevron outline — box-shadow would not.
  const SHADOW = "drop-shadow(0 1.5px 1.5px rgba(15,23,42,0.22))";
  const SHADOW_ACTIVE =
    "drop-shadow(0 3px 6px rgba(15,23,42,0.4)) brightness(1.07)";
  const textShadow = "[text-shadow:0_1px_1.5px_rgba(0,0,0,0.30)]";

  // Collapsed — a slim bar with just the reveal toggle, so the chat window
  // gets the strip's full height back. Click to bring the strip back.
  if (collapsed) {
    return (
      <div className="flex h-6 shrink-0 items-center justify-center border-b bg-gradient-to-b from-card to-secondary/40">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-1.5 px-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground transition hover:text-primary"
          title="Show stage bar"
          aria-label="Show stage bar"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          Stages
        </button>
      </div>
    );
  }

  return (
    <div className="relative isolate flex h-[72px] shrink-0 items-stretch border-b bg-gradient-to-b from-card to-secondary/40">
      {/* Strip area — block wrapper so the overflow-x scroll container fills it
          and scrolls; the arrows position absolute against this. (A flex
          wrapper without min-w-0 let the scroll content expand and push the
          arrows / search off-screen — the bug behind "arrows gone".) */}
      <div className="relative h-full min-w-0 flex-1">
      {canLeft ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-[78] w-9 bg-gradient-to-r from-card to-transparent"
          />
          <button
            type="button"
            onClick={() => nudge(-1)}
            onMouseEnter={() => startAuto(-1)}
            onMouseLeave={stopAuto}
            className="absolute left-1.5 top-1/2 z-[80] inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md transition hover:scale-110 hover:bg-primary/10 hover:text-primary"
            aria-label="Scroll stages left"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={measure}
        className="flex cursor-grab select-none items-center overflow-x-auto px-3 py-0.5 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none" }}
      >
        {/* "All" — clears the filter. */}
        {(() => {
          const active = selected === null;
          return (
            <button
              type="button"
              onClick={() => onSelect(null)}
              style={{
                clipPath: clipFirst,
                zIndex: stages.length + 1,
                filter: active ? SHADOW_ACTIVE : SHADOW,
              }}
              className={cn(
                "relative flex h-[66px] shrink-0 flex-col items-center justify-center pl-4 pr-6 transition duration-150 hover:-translate-y-[3px]",
                active
                  ? "bg-gradient-to-b from-slate-700 to-slate-900 text-white"
                  : "bg-gradient-to-b from-white to-slate-200 text-slate-600 hover:text-slate-900",
              )}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/35 to-transparent"
              />
              <span
                className={cn(
                  "relative text-[19px] font-extrabold leading-none tabular-nums",
                  active && textShadow,
                )}
              >
                {fmtCount(total)}
              </span>
              <span
                className={cn(
                  "relative mt-1 text-[10px] font-bold uppercase tracking-[0.08em] leading-none",
                  active && textShadow,
                )}
              >
                All
              </span>
              <span
                className={cn(
                  "relative mt-1 rounded-full px-1.5 py-[1.5px] text-[11px] font-bold leading-none",
                  active ? "bg-white/15 text-white/90" : "bg-slate-900/10 text-slate-500",
                )}
              >
                100%
              </span>
            </button>
          );
        })()}

        {visibleStages.map((stage, i) => {
          const solid = solidToneByIndex(i);
          const active = selected === stage;
          // A stage is selected and it's not this one — recede so the
          // picked stage is the clear focus of the funnel.
          const dimmed = selected !== null && !active;
          const count = counts ? counts[stage] ?? 0 : null;
          // Share of the total pipeline this stage holds.
          const pct =
            count !== null && total && total > 0
              ? Math.round((count / total) * 100)
              : null;
          const words = stageLines(stage);
          return (
            <button
              key={stage}
              type="button"
              data-stage={stage}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({
                  stage,
                  left: Math.min(r.left, window.innerWidth - 188),
                  top: r.bottom + 4,
                });
              }}
              onContextMenu={(e) => openContextMenu(e, stage)}
              title={`${stage}${count !== null ? ` · ${count}` : ""} — right-click to hide`}
              style={{
                clipPath: clipMid,
                marginLeft: -ARROW,
                zIndex: active
                  ? visibleStages.length + 2
                  : visibleStages.length - i,
                filter: active ? SHADOW_ACTIVE : SHADOW,
              }}
              className={cn(
                "relative flex h-[66px] shrink-0 flex-col items-center justify-center pl-7 pr-6 transition-[opacity,transform] duration-150 hover:-translate-y-[3px]",
                solid.bg,
                solid.text,
                dimmed ? "opacity-35 hover:opacity-80" : "opacity-100",
              )}
            >
              {/* glossy moulded top highlight */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/35 to-transparent"
              />
              {/* Count + percentage share of the pipeline. */}
              <span className="relative flex items-baseline gap-1">
                <span
                  className={cn(
                    "text-[19px] font-extrabold leading-none tabular-nums",
                    textShadow,
                  )}
                >
                  {fmtCount(count)}
                </span>
                {pct !== null ? (
                  <span className="rounded-full bg-white/25 px-1.5 py-[1.5px] text-[11px] font-bold leading-none [text-shadow:none]">
                    {pct}%
                  </span>
                ) : null}
              </span>
              {/* Stage name — one word per line so the chevron stays
                  compact and the strip can breathe. */}
              <span
                className={cn(
                  "relative mt-1 flex flex-col items-center gap-0 text-[10px] font-semibold uppercase leading-[1.12] tracking-[0.03em]",
                  textShadow,
                )}
              >
                {words.map((w, wi) => (
                  <span key={wi}>{w}</span>
                ))}
              </span>
            </button>
          );
        })}

        {/* "Show hidden (N)" — trail button at the end of the strip,
            only renders when the agent has hidden at least one stage.
            Opens an inline panel listing every hidden stage with an
            individual restore button plus a single "Unhide all". */}
        {hidden.size > 0 ? (
          <button
            ref={hiddenBtnRef}
            type="button"
            onClick={() => setHiddenPanelOpen((v) => !v)}
            className="ml-1 inline-flex h-9 shrink-0 items-center gap-1.5 self-center rounded-full border border-dashed border-slate-300 bg-card px-3 text-[11px] font-bold uppercase tracking-wider text-slate-600 shadow-sm transition hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
            title="Show hidden stages"
          >
            <EyeOff className="h-3.5 w-3.5" />
            Hidden · {hidden.size}
          </button>
        ) : null}
      </div>

      {/* Hidden-stages panel — portal-rendered so the strip's overflow-
          x-auto container can't clip it. Anchored top-right to the
          "Hidden · N" trigger button via its bounding rect. */}
      {hiddenPanelOpen && hiddenPanelPos && typeof document !== "undefined"
        ? createPortal(
            <>
              <button
                type="button"
                aria-hidden
                onClick={() => setHiddenPanelOpen(false)}
                className="fixed inset-0 z-[70] cursor-default"
              />
              <div
                style={{ top: hiddenPanelPos.top, right: hiddenPanelPos.right }}
                className="fixed z-[71] w-64 overflow-hidden rounded-xl border bg-popover shadow-xl ring-1 ring-border"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Hidden stages
                  </div>
                  <button
                    type="button"
                    onClick={unhideAll}
                    className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-primary transition hover:bg-primary/10"
                  >
                    Unhide all
                  </button>
                </div>
                <ul className="max-h-72 overflow-y-auto">
                  {Array.from(hidden).map((s) => (
                    <li
                      key={s}
                      className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-secondary/60"
                    >
                      <span className="truncate">{s}</span>
                      <button
                        type="button"
                        onClick={() => unhideStage(s)}
                        className="inline-flex h-6 items-center gap-1 rounded-md border bg-card px-2 text-[10px] font-semibold text-foreground transition hover:bg-primary/10 hover:text-primary"
                        title="Show this stage again"
                      >
                        Unhide
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* Stage search popover — portal so the strip's overflow can't clip it. */}
      {searchOpen && searchPos && typeof document !== "undefined"
        ? createPortal(
            <>
              <button
                type="button"
                aria-hidden
                onClick={() => setSearchOpen(false)}
                className="fixed inset-0 z-[70] cursor-default"
              />
              <div
                style={{ top: searchPos.top, left: searchPos.left }}
                className="fixed z-[71] w-64 overflow-hidden rounded-xl border bg-popover shadow-xl ring-1 ring-border"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="relative border-b">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setSearchOpen(false);
                      if (e.key === "Enter" && searchResults[0]) goToStage(searchResults[0]);
                    }}
                    placeholder="Search stages…"
                    className="h-9 w-full bg-transparent pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <ul className="max-h-72 overflow-y-auto py-1">
                  {searchResults.length === 0 ? (
                    <li className="px-3 py-2 text-center text-xs text-muted-foreground">
                      No stage matches.
                    </li>
                  ) : (
                    searchResults.map((s) => {
                      const c = counts ? counts[s] ?? 0 : null;
                      return (
                        <li key={s}>
                          <button
                            type="button"
                            onClick={() => goToStage(s)}
                            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary/70"
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{s}</span>
                              {hidden.has(s) ? (
                                <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" />
                              ) : null}
                            </span>
                            {c !== null ? (
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                {c}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* Right-click context menu — anchored at the click point. Single
          action: "Hide this stage" (or "Unhide" if already hidden,
          although we don't render hidden chevrons so this is mostly a
          safety net). */}
      {ctxMenu ? (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{ left: ctxMenu.left, top: ctxMenu.top }}
          className="fixed z-[60] w-48 overflow-hidden rounded-lg border bg-popover shadow-lg ring-1 ring-border"
        >
          <div className="truncate border-b px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {ctxMenu.stage}
          </div>
          <button
            type="button"
            onClick={() => {
              if (ctxMenu.isHidden) unhideStage(ctxMenu.stage);
              else hideStage(ctxMenu.stage);
              setCtxMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition hover:bg-secondary"
          >
            <EyeOff className="h-3.5 w-3.5 text-rose-600" />
            {ctxMenu.isHidden ? "Unhide this stage" : "Hide this stage"}
          </button>
          {hidden.size > 0 ? (
            <button
              type="button"
              onClick={() => {
                unhideAll();
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-xs font-medium text-primary transition hover:bg-primary/10"
            >
              <Eye className="h-3.5 w-3.5" />
              Unhide all ({hidden.size})
            </button>
          ) : null}
        </div>
      ) : null}

      {canRight ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-[78] w-9 bg-gradient-to-l from-card to-transparent"
          />
          <button
            type="button"
            onClick={() => nudge(1)}
            onMouseEnter={() => startAuto(1)}
            onMouseLeave={stopAuto}
            className="absolute right-1.5 top-1/2 z-[80] inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md transition hover:scale-110 hover:bg-primary/10 hover:text-primary"
            aria-label="Scroll stages right"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </>
      ) : null}

      {/* Per-stage action menu — chat-window filter vs list-view modal. */}
      {menu ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: -5 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.13, ease: "easeOut" }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ left: menu.left, top: menu.top, transformOrigin: "top left" }}
          className="fixed z-[60] w-44 rounded-xl border bg-card p-1 shadow-xl ring-1 ring-black/5"
        >
          <div className="truncate px-2 pb-1 pt-1 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
            {menu.stage}
          </div>
          <button
            type="button"
            onClick={() => {
              onSelect(menu.stage);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium transition hover:bg-secondary"
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-sky-100 text-sky-600">
              <MessageSquare className="h-3.5 w-3.5" />
            </span>
            Chat window
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenList(menu.stage);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium transition hover:bg-secondary"
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-violet-100 text-violet-600">
              <List className="h-3.5 w-3.5" />
            </span>
            List view
          </button>
        </motion.div>
      ) : null}
      </div>

      {/* Right control slot — both actions stacked in one narrow column:
          hide-strip arrow on top, stage-search on the bottom. */}
      <div className="relative z-[80] flex h-full w-8 shrink-0 flex-col items-stretch border-l bg-card">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex flex-1 items-center justify-center text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
          title="Hide stage bar"
          aria-label="Hide stage bar"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          ref={searchBtnRef}
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className={cn(
            "flex flex-1 items-center justify-center border-t text-muted-foreground transition hover:bg-primary/10 hover:text-primary",
            searchOpen && "bg-primary/10 text-primary",
          )}
          title="Search stages"
          aria-label="Search stages"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
