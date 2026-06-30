"use client";

// Premium dropdown multi-select with:
//   • Click-to-open popover with search input
//   • Selected items rendered as removable chips inside the trigger
//   • Inline "Add custom" affordance when the search query doesn't
//     match any existing option (so the operator can add a new LSQ
//     stage / source on the fly without leaving the wizard)
//   • Item counts (optional) — the LSQ filter UI passes contact-count
//     overlays so chips read "Photo Awaited · 87"
//   • Keyboard: ESC closes, Enter on the search input adds the typed
//     value as a custom selection
//   • Click outside to close
//
// Used by the campaign-create wizard LSQ filter panel.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MultiSelectItem {
  key: string;
  label: string;
  count?: number;
  /** True when the item came from the LSQ master-data fetch (vs. our
   *  hardcoded defaults). UI shows a subtle dot. */
  external?: boolean;
}

export type Accent = "violet" | "sky" | "emerald";

interface Props {
  label: string;
  hint?: string;
  items: MultiSelectItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Allow operator to type something new and add it as a selection. */
  allowCustom?: boolean;
  loading?: boolean;
  emptyHint?: string;
  accent?: Accent;
  /** Optional: how many items to render at most (rest hidden behind a
   *  "Show all N" button). */
  visibleCap?: number;
  showCounts?: boolean;
}

const ACCENTS: Record<Accent, { ring: string; fill: string; bgSoft: string; text: string; chipBg: string; chipBorder: string }> = {
  violet: {
    ring: "ring-violet-300",
    fill: "bg-violet-600",
    bgSoft: "bg-violet-50/40",
    text: "text-violet-900",
    chipBg: "bg-violet-100 text-violet-800",
    chipBorder: "border-violet-200",
  },
  sky: {
    ring: "ring-sky-300",
    fill: "bg-sky-600",
    bgSoft: "bg-sky-50/40",
    text: "text-sky-900",
    chipBg: "bg-sky-100 text-sky-800",
    chipBorder: "border-sky-200",
  },
  emerald: {
    ring: "ring-emerald-300",
    fill: "bg-emerald-600",
    bgSoft: "bg-emerald-50/40",
    text: "text-emerald-900",
    chipBg: "bg-emerald-100 text-emerald-800",
    chipBorder: "border-emerald-200",
  },
};

export function SearchableMultiSelect({
  label,
  hint,
  items,
  selected,
  onChange,
  allowCustom = true,
  loading = false,
  emptyHint = "No options available.",
  accent = "violet",
  visibleCap,
  showCounts = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const a = ACCENTS[accent];

  // Close on click-outside / ESC.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      // Autofocus the search field on open.
      setTimeout(() => inputRef.current?.focus(), 30);
    } else {
      setQuery("");
      setShowAll(false);
    }
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((i) => i.label.toLowerCase().includes(q))
    : items;
  const exactMatch = filtered.some((i) => i.label.toLowerCase() === q);

  const visible = visibleCap && !showAll && !q ? filtered.slice(0, visibleCap) : filtered;

  function toggle(key: string) {
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }
  function addCustom(value: string) {
    const v = value.trim();
    if (!v) return;
    if (!selected.includes(v)) onChange([...selected, v]);
    setQuery("");
  }
  function clearAll() {
    onChange([]);
  }
  // "Select all" applies to the currently-visible (filtered) set so the
  // operator can scope it via search — e.g. type "photo" then Select all.
  const filteredKeys = filtered.map((i) => i.key);
  const allFilteredSelected =
    filteredKeys.length > 0 && filteredKeys.every((k) => selected.includes(k));
  function toggleSelectAll() {
    if (allFilteredSelected) {
      onChange(selected.filter((k) => !filteredKeys.includes(k)));
    } else {
      const merged = new Set([...selected, ...filteredKeys]);
      onChange(Array.from(merged));
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className={cn("text-[11px] font-semibold uppercase tracking-wide", a.text)}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={clearAll}
              className={cn("text-[10px] font-semibold hover:underline", a.text)}
            >
              Clear ({selected.length})
            </button>
          ) : null}
        </div>
      </div>

      {/* Trigger button — renders selected items inline as small chips */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full min-h-[42px] items-center justify-between gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-left text-sm transition",
          open ? `ring-2 ${a.ring} border-transparent` : "border-border hover:border-foreground/30",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {selected.length === 0 ? (
            <span className="text-muted-foreground">
              {loading ? "Loading…" : `Select ${label.toLowerCase()}…`}
            </span>
          ) : (
            selected.map((key) => {
              const item = items.find((i) => i.key === key);
              return (
                <span
                  key={key}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
                    a.chipBg,
                    a.chipBorder,
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  {item?.label ?? key}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(key);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(key);
                      }
                    }}
                    className="-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/10"
                    aria-label={`Remove ${item?.label ?? key}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </span>
                </span>
              );
            })
          )}
        </div>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition", open && "rotate-180")}
        />
      </button>

      {/* Popover */}
      {open ? (
        <div
          className={cn(
            "absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border bg-card shadow-2xl ring-1 ring-black/5",
            "animate-in fade-in slide-in-from-top-1",
          )}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && allowCustom && q && !exactMatch) {
                  e.preventDefault();
                  addCustom(query);
                }
              }}
              placeholder={`Search ${label.toLowerCase()}… ${allowCustom ? "(or type to add new)" : ""}`}
              className="h-8 flex-1 bg-transparent text-sm outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          {/* Add-custom CTA — shown when query doesn't match anything */}
          {allowCustom && q && !exactMatch ? (
            <button
              type="button"
              onClick={() => addCustom(query)}
              className={cn(
                "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm transition",
                a.bgSoft,
                "hover:bg-secondary/40",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-md text-white",
                  a.fill,
                )}
              >
                <Plus className="h-3 w-3" />
              </span>
              <span className="font-medium">Add &quot;{query}&quot;</span>
              <span className="ml-auto text-[10px] text-muted-foreground">↵</span>
            </button>
          ) : null}

          {/* Select all (scoped to current search). Hidden when there's
              nothing to act on. */}
          {filtered.length > 0 ? (
            <button
              type="button"
              onClick={toggleSelectAll}
              className={cn(
                "flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs font-semibold transition",
                a.text,
                "hover:bg-secondary/40",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
                  allFilteredSelected
                    ? `${a.fill} border-transparent text-white`
                    : "border-border bg-background",
                )}
              >
                {allFilteredSelected ? <Check className="h-3 w-3" /> : null}
              </span>
              <span className="flex-1">
                {allFilteredSelected
                  ? `Deselect ${q ? "filtered" : "all"} (${filteredKeys.length})`
                  : `Select ${q ? "filtered" : "all"} (${filteredKeys.length})`}
              </span>
            </button>
          ) : null}

          {/* Item list */}
          <ul className="max-h-72 overflow-y-auto py-1">
            {loading && items.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-muted-foreground">Loading…</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-muted-foreground">
                {emptyHint}
              </li>
            ) : (
              visible.map((item) => {
                const on = selected.includes(item.key);
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => toggle(item.key)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition",
                        on ? a.bgSoft : "hover:bg-secondary/40",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
                          on ? `${a.fill} border-transparent text-white` : "border-border bg-background",
                        )}
                      >
                        {on ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {showCounts && item.count != null && item.count > 0 ? (
                        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                          {item.count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
            {visibleCap && !showAll && !q && filtered.length > visibleCap ? (
              <li className="border-t bg-secondary/20">
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="flex w-full items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-secondary/40"
                >
                  Show all {filtered.length}
                </button>
              </li>
            ) : null}
          </ul>

          {/* Footer summary */}
          <div className="flex items-center justify-between border-t bg-secondary/20 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>
              {selected.length > 0
                ? `${selected.length} selected`
                : `${filtered.length} ${filtered.length === 1 ? "option" : "options"}`}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="font-semibold hover:text-foreground"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
