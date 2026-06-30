"use client";

// Sectioned lead-stage funnel above the inbox — the classic chevron/arrow
// look, but two-level: 6 funnel SECTIONS on top; click a section and its
// sub-stages open as chevrons below. Clicking a sub-stage opens a small
// menu (filter the inbox / open list view), same as the old strip.
//
// Live per-stage counts come from /api/lsq/stage-counts, matched
// case-insensitively against each section's stage labels.

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { List, MessageSquare } from "lucide-react";
import { solidToneByIndex } from "@/lib/chip-tones";
import { cn } from "@/lib/utils";

interface Section {
  title: string;
  stages: string[];
}

const SECTIONS: Section[] = [
  {
    title: "Ingestion & Qualification",
    stages: ["Prospect", "Engaged", "Pending First Contact", "Future Follow Up"],
  },
  {
    title: "Photo & Evaluation",
    stages: [
      "Photo Awaited",
      "Photos Received",
      "Photo Approved",
      "Photo Disapproved",
      "Graft Evaluation Awaited",
      "Graft Evaluation Completed",
    ],
  },
  {
    title: "Sales & Booking (HT)",
    stages: [
      "Consultation Done",
      "Package Shared",
      "Follow Up",
      "Follow up for Booking",
      "Call Back",
      "Booking Done",
    ],
  },
  {
    title: "Surgery & Post-Op (HT)",
    stages: [
      "Surgery Date Awaited",
      "Surgery Date Aligned",
      "Surgery Date Confirmed",
      "HT Done",
      "HT Care & Medicine",
      "HT Care Follow Up",
    ],
  },
  {
    title: "Medicine Sales",
    stages: [
      "Under Age (Medicine Lead)",
      "Order Confirmed by Bot",
      "Medicine Suggested",
      "Order Confirmed",
      "Order Placed",
      "Order Fulfillment",
      "HT Done/Medicine",
      "Call Back for Medicine",
      "Repeated Order",
    ],
  },
  {
    title: "Archived / Lost / Unconverted",
    stages: [
      "Refund Requested",
      "Refunded Done",
      "Do Not Call Again",
      "Not Interested",
      "Dormant",
      "Cold Patient",
      "Not Eligible for HT",
      "DNP",
      "DNP_Medicine",
      "L1 Fall Out",
      "Wrong Number",
      "Abandoned Cart",
      "Rejected Leads",
      "Location Constraint",
      "No Contact Details",
    ],
  },
];

const ARROW = 14;
const clipFirst = `polygon(0 0, calc(100% - ${ARROW}px) 0, 100% 50%, calc(100% - ${ARROW}px) 100%, 0 100%)`;
const clipMid = `polygon(0 0, calc(100% - ${ARROW}px) 0, 100% 50%, calc(100% - ${ARROW}px) 100%, 0 100%, ${ARROW}px 50%)`;
const SHADOW = "drop-shadow(0 1.5px 1.5px rgba(15,23,42,0.22))";
const SHADOW_ACTIVE = "drop-shadow(0 3px 6px rgba(15,23,42,0.4)) brightness(1.07)";
const textShadow = "[text-shadow:0_1px_1.5px_rgba(0,0,0,0.30)]";

function fmtCount(n: number | null): string {
  return n === null ? "" : n.toLocaleString();
}

/** Split a label into stacked lines — one word per line, short words pair up. */
function lines(label: string): string[] {
  const out: string[] = [];
  for (const w of label.split(" ")) {
    const last = out[out.length - 1];
    if (last && w.length <= 3 && last.length <= 3) out[out.length - 1] = `${last} ${w}`;
    else out.push(w);
  }
  return out;
}

export function LeadStageSections({
  selected,
  onSelect,
  onOpenList,
}: {
  selected: string | null;
  onSelect: (stage: string | null) => void;
  onOpenList: (stage: string) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [openIdx, setOpenIdx] = useState<number>(0);
  // Per-stage click menu — filter vs list view. Anchored at click point.
  const [menu, setMenu] = useState<{ stage: string; left: number; top: number } | null>(null);

  const loadCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/lsq/stage-counts", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { counts?: Record<string, number>; total?: number };
      const lower: Record<string, number> = {};
      for (const [k, v] of Object.entries(j.counts ?? {})) lower[k.toLowerCase()] = v;
      setCounts(lower);
      setTotal(j.total ?? 0);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadCounts();
    const t = setInterval(loadCounts, 30_000);
    const onNumbers = () => loadCounts();
    window.addEventListener("business-numbers-changed", onNumbers);
    return () => {
      clearInterval(t);
      window.removeEventListener("business-numbers-changed", onNumbers);
    };
  }, [loadCounts]);

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

  const countFor = useCallback(
    (stage: string): number | null => (counts ? counts[stage.toLowerCase()] ?? 0 : null),
    [counts],
  );

  const sectionTotals = useMemo(
    () =>
      SECTIONS.map((s) =>
        counts ? s.stages.reduce((a, st) => a + (counts[st.toLowerCase()] ?? 0), 0) : null,
      ),
    [counts],
  );

  // Keep the open section in sync with an externally-selected stage.
  useEffect(() => {
    if (!selected) return;
    const idx = SECTIONS.findIndex((s) =>
      s.stages.some((st) => st.toLowerCase() === selected.toLowerCase()),
    );
    if (idx >= 0) setOpenIdx(idx);
  }, [selected]);

  const openSection = openIdx >= 0 ? SECTIONS[openIdx] : null;

  return (
    <div className="relative shrink-0 border-b bg-gradient-to-b from-card to-secondary/40">
      {/* ---- Section funnel ---- */}
      <div className="flex items-center overflow-x-auto px-3 py-1.5 [&::-webkit-scrollbar]:hidden">
        {/* All — clears filter */}
        {(() => {
          const active = selected === null;
          return (
            <button
              type="button"
              onClick={() => onSelect(null)}
              style={{ clipPath: clipFirst, zIndex: SECTIONS.length + 1, filter: active ? SHADOW_ACTIVE : SHADOW }}
              className={cn(
                "relative flex h-[62px] shrink-0 flex-col items-center justify-center pl-4 pr-6 transition hover:-translate-y-[2px]",
                active ? "bg-gradient-to-b from-slate-700 to-slate-900 text-white" : "bg-gradient-to-b from-white to-slate-200 text-slate-600",
              )}
            >
              <span className={cn("text-[17px] font-extrabold leading-none tabular-nums", active && textShadow)}>
                {fmtCount(total)}
              </span>
              <span className={cn("mt-1 text-[10px] font-bold uppercase tracking-[0.08em]", active && textShadow)}>All</span>
            </button>
          );
        })()}

        {SECTIONS.map((s, i) => {
          const tone = solidToneByIndex(i);
          const active = openIdx === i;
          const words = lines(s.title);
          return (
            <button
              key={s.title}
              type="button"
              onClick={() => setOpenIdx((cur) => (cur === i ? -1 : i))}
              title={s.title}
              style={{
                clipPath: clipMid,
                marginLeft: -ARROW,
                zIndex: active ? SECTIONS.length + 2 : SECTIONS.length - i,
                filter: active ? SHADOW_ACTIVE : SHADOW,
              }}
              className={cn(
                "relative flex h-[62px] w-[150px] shrink-0 flex-col items-center justify-center pl-7 pr-6 transition hover:-translate-y-[2px]",
                tone.bg,
                tone.text,
                !active && "opacity-90",
              )}
            >
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/35 to-transparent" />
              <span className={cn("relative text-[17px] font-extrabold leading-none tabular-nums", textShadow)}>
                {fmtCount(sectionTotals[i])}
              </span>
              <span className={cn("relative mt-0.5 flex flex-col items-center text-[9px] font-bold uppercase leading-[1.1] tracking-[0.02em]", textShadow)}>
                {words.map((w, wi) => (
                  <span key={wi}>{w}</span>
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {/* ---- Sub-stage funnel (open section) ---- */}
      {openSection ? (
        <div className="flex items-center overflow-x-auto border-t bg-secondary/30 px-3 py-1.5 [&::-webkit-scrollbar]:hidden">
          {openSection.stages.map((stage, i) => {
            const tone = solidToneByIndex(i);
            const active = selected?.toLowerCase() === stage.toLowerCase();
            const dimmed = selected !== null && !active;
            const c = countFor(stage);
            const words = lines(stage);
            return (
              <button
                key={stage}
                type="button"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ stage, left: Math.min(r.left, window.innerWidth - 188), top: r.bottom + 4 });
                }}
                title={`${stage}${c !== null ? ` · ${c}` : ""}`}
                style={{
                  clipPath: i === 0 ? clipFirst : clipMid,
                  marginLeft: i === 0 ? 0 : -ARROW,
                  zIndex: active ? openSection.stages.length + 2 : openSection.stages.length - i,
                  filter: active ? SHADOW_ACTIVE : SHADOW,
                }}
                className={cn(
                  "relative flex h-[56px] shrink-0 flex-col items-center justify-center pl-7 pr-6 transition-[opacity,transform] hover:-translate-y-[2px]",
                  tone.bg,
                  tone.text,
                  dimmed ? "opacity-35 hover:opacity-80" : "opacity-100",
                )}
              >
                <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/35 to-transparent" />
                <span className={cn("relative text-[16px] font-extrabold leading-none tabular-nums", textShadow)}>
                  {fmtCount(c)}
                </span>
                <span className={cn("relative mt-0.5 flex flex-col items-center text-[9px] font-semibold uppercase leading-[1.1] tracking-[0.02em]", textShadow)}>
                  {words.map((w, wi) => (
                    <span key={wi}>{w}</span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* ---- Per-stage menu ---- */}
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
  );
}
