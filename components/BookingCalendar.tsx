"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** A real month-grid calendar. Only dates present in `availableDates`
 *  (YYYY-MM-DD) are selectable; everything else renders dimmed. Month/year
 *  navigation is bounded to the available range. */
export function BookingCalendar({
  availableDates,
  onPick,
  busyDate,
  load,
  details,
}: {
  availableDates: string[];
  onPick: (date: string) => void;
  busyDate?: string | null;
  /** Agent-only: per-date appointment count (app bookings + calendar events).
   *  When set, each day shows how many are already booked. Omit on the
   *  client-facing page so internal load stays private. */
  load?: Record<string, number>;
  /** Agent-only: per-date event titles (what's written on the calendar that
   *  day). Shown as a preview + hover list. */
  details?: Record<string, string[]>;
}) {
  const available = useMemo(() => new Set(availableDates), [availableDates]);
  const first = availableDates[0];
  const last = availableDates[availableDates.length - 1];

  const initial = useMemo(() => {
    const base = first ? new Date(`${first}T00:00:00`) : new Date();
    return { y: base.getFullYear(), m: base.getMonth() };
  }, [first]);
  const [view, setView] = useState(initial);

  const minD = first ? new Date(`${first}T00:00:00`) : new Date();
  const maxD = last ? new Date(`${last}T00:00:00`) : new Date();
  const atMin = view.y === minD.getFullYear() && view.m === minD.getMonth();
  const atMax = view.y === maxD.getFullYear() && view.m === maxD.getMonth();

  function shift(delta: number) {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }

  const cells = useMemo(() => {
    const firstWeekday = new Date(view.y, view.m, 1).getDay();
    const days = new Date(view.y, view.m + 1, 0).getDate();
    const arr: Array<{ day: number; date: string } | null> = [];
    for (let i = 0; i < firstWeekday; i++) arr.push(null);
    for (let d = 1; d <= days; d++) arr.push({ day: d, date: ymd(view.y, view.m, d) });
    return arr;
  }, [view]);

  return (
    <div className="select-none">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => shift(-1)}
          disabled={atMin}
          aria-label="Previous month"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-sm font-semibold text-gray-900">
          {MONTHS[view.m]} {view.y}
        </div>
        <button
          type="button"
          onClick={() => shift(1)}
          disabled={atMax}
          aria-label="Next month"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-gray-400">
        {WEEKDAYS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, i) => {
          if (!c) return <div key={`blank-${i}`} />;
          const ok = available.has(c.date);
          const busy = busyDate === c.date;
          const titles = details?.[c.date] ?? [];
          const count = load?.[c.date] ?? titles.length;
          return (
            <div key={c.date} className="group relative">
              <button
                type="button"
                disabled={!ok || !!busyDate}
                onClick={() => ok && onPick(c.date)}
                title={
                  titles.length > 0
                    ? `${count} booked:\n${titles.join("\n")}`
                    : undefined
                }
                className={
                  "flex h-16 w-full flex-col gap-0.5 overflow-hidden rounded-lg p-1 text-left transition " +
                  (ok
                    ? "ring-1 ring-primary/25 hover:bg-primary/10 disabled:opacity-60"
                    : "text-gray-300")
                }
              >
                <span
                  className={
                    "text-[11px] font-semibold leading-none " +
                    (ok ? "text-gray-900" : "text-gray-300")
                  }
                >
                  {busy ? "…" : c.day}
                </span>
                {!busy && titles.length > 0 ? (
                  <span className="truncate rounded bg-amber-100 px-1 py-0.5 text-[8px] font-medium leading-tight text-amber-800">
                    {titles[0]}
                  </span>
                ) : null}
                {!busy && titles.length > 1 ? (
                  <span className="px-1 text-[8px] font-semibold text-amber-600">
                    +{titles.length - 1} more
                  </span>
                ) : null}
              </button>
              {/* Hover popover — the full list of what's booked that day. */}
              {titles.length > 0 ? (
                <div className="pointer-events-none absolute left-1/2 top-full z-30 hidden w-48 -translate-x-1/2 rounded-lg bg-gray-900 p-2 text-left text-[10px] text-white shadow-xl group-hover:block">
                  <div className="mb-1 font-bold">{count} booked</div>
                  <ul className="space-y-0.5">
                    {titles.slice(0, 10).map((t, k) => (
                      <li key={k} className="truncate">
                        • {t}
                      </li>
                    ))}
                    {titles.length > 10 ? (
                      <li className="opacity-70">…+{titles.length - 10} more</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
