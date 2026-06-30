"use client";

// Textarea with an expand-to-fullscreen affordance. Clicking the
// expand icon promotes the editor to a centred modal that occupies
// most of the viewport — useful for the long Automation persona
// prompts where the inline 6-row textarea is too cramped to read.
//
// Esc closes the modal. Any onChange edits flow back through the
// same prop, so the caller doesn't need to track two pieces of state.

import { useEffect } from "react";
import { Maximize2, X } from "lucide-react";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Inline-height row count when not fullscreen. */
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  /** className applied to the inline textarea. */
  className?: string;
  /** Title shown in the fullscreen modal header. */
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional helper / counter shown under the inline textarea. */
  footer?: React.ReactNode;
}

export function FullscreenTextarea({
  value,
  onChange,
  rows = 6,
  placeholder,
  maxLength,
  className,
  title = "Edit",
  open,
  onOpenChange,
  footer,
}: Props) {
  // Esc closes the modal even when the textarea is focused. Bound on
  // the document so the focused input can't swallow the key.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    }
    document.addEventListener("keydown", onKey);
    // Lock body scroll while modal is open. Compensate for the
    // scrollbar disappearance with a matching paddingRight so the
    // page doesn't visibly shift / "zoom out" when the modal opens.
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
    };
  }, [open, onOpenChange]);

  return (
    <>
      <div className="relative">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          maxLength={maxLength}
          className={className}
        />
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          aria-label="Expand to fullscreen"
          title="Expand"
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {footer ? <div className="mt-1">{footer}</div> : null}

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => onOpenChange(false)}
        >
          <div
            className="flex h-[88vh] w-[min(960px,92vw)] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in zoom-in-95 fade-in duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-semibold tracking-tight">
                  {title}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              maxLength={maxLength}
              className="flex-1 resize-none border-0 bg-background px-6 py-4 font-mono text-sm leading-relaxed outline-none focus:ring-0"
              autoFocus
            />
            <div className="flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
              <span>Esc to close. Changes save on close.</span>
              <span className="tabular-nums">
                {value.length}
                {maxLength ? ` / ${maxLength}` : ""}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
