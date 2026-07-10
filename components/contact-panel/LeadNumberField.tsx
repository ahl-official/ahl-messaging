"use client";

// Dedicated Lead Number row for the CRM-record card. Clicking it pops
// a tiny action menu with two operator-friendly options:
//   • Copy   → puts the bare number on the clipboard (no `#` prefix
//              so it pastes cleanly into LSQ's search bar)
//   • Visit  → opens the CRM lead detail page in a new tab
// Auto-closes on selection or outside-click. No menu shows when the
// lead isn't loaded yet.

import { useEffect, useRef, useState } from "react";
import { Check, Copy as CopyIcon, ExternalLink } from "lucide-react";

interface Props {
  /** Display number (e.g. "436093"). The `#` prefix is added in the
   *  rendered text but stripped before copy. */
  leadNumber: string | null;
  /** Optional deep link into LSQ — usually `<host>/LeadManagement/
   *  LeadDetails?LeadID=<prospect_id>`. Visit option is hidden when
   *  not provided (e.g. lead lookup failed but the cached number is
   *  still on the contact row). */
  leadUrl: string | null;
  loading?: boolean;
}

export function LeadNumberField({ leadNumber, leadUrl, loading }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc close the menu so it doesn't get pinned.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onCopy = async () => {
    if (!leadNumber) return;
    try {
      await navigator.clipboard.writeText(leadNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard blocked (insecure context). Silent — text is still
      // visible and selectable on the row.
    }
    setOpen(false);
  };

  const onVisit = () => {
    if (leadUrl) {
      window.open(leadUrl, "_blank", "noopener,noreferrer");
    }
    setOpen(false);
  };

  return (
    <div className="group flex items-center justify-between gap-3 rounded-md px-1.5 py-[5px] transition-colors hover:bg-secondary/60">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
        Lead Number
      </span>
      <div ref={wrapRef} className="relative min-w-0">
        {loading && !leadNumber ? (
          <span className="block h-3 w-20 animate-pulse rounded bg-secondary" />
        ) : leadNumber ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            title={copied ? "Copied" : "Click for actions"}
            className="inline-flex max-w-full items-center gap-1 truncate font-mono text-[12px] font-medium text-foreground transition-colors hover:text-primary"
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span className="truncate">{`#${leadNumber}`}</span>
            <span
              className={
                "shrink-0 text-[9px] font-medium transition-opacity " +
                (copied
                  ? "text-primary opacity-100"
                  : "text-muted-foreground opacity-60 group-hover:opacity-100")
              }
            >
              {copied ? "✓" : "▾"}
            </span>
          </button>
        ) : (
          <span className="text-[12.5px] text-muted-foreground/40">—</span>
        )}

        {open && leadNumber ? (
          <div
            role="menu"
            className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-md border border-border bg-popover shadow-lg ring-1 ring-black/5"
          >
            <button
              type="button"
              role="menuitem"
              onClick={onCopy}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-secondary"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : (
                <CopyIcon className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {copied ? "Copied" : "Copy"} lead ID
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {leadNumber}
                </div>
              </div>
            </button>
            {leadUrl ? (
              <button
                type="button"
                role="menuitem"
                onClick={onVisit}
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-[12px] hover:bg-secondary"
              >
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">Visit in LSQ</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    Opens lead in a new tab
                  </div>
                </div>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
