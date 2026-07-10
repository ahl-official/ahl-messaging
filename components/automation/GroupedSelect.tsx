"use client";

// A clean single-select dropdown with grouped, searchable options. Used by
// the Send Message node to pick a WhatsApp number (grouped by portfolio) and
// its template. The dropdown renders in a PORTAL (positioned under the
// trigger) so it never gets clipped by the side panel's overflow.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectGroup {
  label: string;
  items: { value: string; label: string; sub?: string }[];
}

export function GroupedSelect({
  value,
  groups,
  onChange,
  placeholder = "Select…",
  disabled = false,
  searchable = true,
}: {
  value: string;
  groups: SelectGroup[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const selected = groups.flatMap((g) => g.items).find((i) => i.value === value);
  const ql = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !ql || i.label.toLowerCase().includes(ql)) }))
    .filter((g) => g.items.length > 0);

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom + 4, width: r.width });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    setQ("");
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-white px-2.5 text-left text-xs outline-none transition hover:border-primary/30 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-muted-foreground",
          open && "border-primary/40 ring-1 ring-primary/25",
        )}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition", open && "rotate-180")} />
      </button>

      {mounted && open && !disabled && rect
        ? createPortal(
            <>
              <div className="fixed inset-0 z-[70]" onClick={close} />
              <div
                className="fixed z-[71] max-h-72 overflow-auto rounded-lg border bg-white shadow-xl"
                style={{ left: rect.left, top: rect.top, width: rect.width }}
              >
                {searchable ? (
                  <div className="sticky top-0 z-10 border-b bg-white p-1.5">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input
                        autoFocus
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search…"
                        className="w-full rounded-md border bg-secondary/30 py-1.5 pl-7 pr-2 text-xs outline-none focus:border-primary"
                      />
                    </div>
                  </div>
                ) : null}

                {filtered.length === 0 ? (
                  <div className="px-3 py-5 text-center text-xs text-muted-foreground">No matches</div>
                ) : (
                  filtered.map((g) => (
                    <div key={g.label}>
                      <div className="bg-slate-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        {g.label}
                      </div>
                      {g.items.map((i) => (
                        <button
                          key={i.value}
                          type="button"
                          onClick={() => { onChange(i.value); close(); }}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-primary/10",
                            i.value === value && "bg-primary/10 font-semibold text-primary",
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{i.label}</span>
                            {i.sub ? <span className="block truncate text-[10px] text-muted-foreground">{i.sub}</span> : null}
                          </span>
                          {i.value === value ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
