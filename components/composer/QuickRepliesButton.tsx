"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { List, Plus, X } from "lucide-react";
import { ComposerIconButton } from "@/components/composer/ComposerIconButton";
import { cn } from "@/lib/utils";
import type { QuickReply } from "@/components/QuickRepliesManager";

interface Props {
  disabled?: boolean;
  /** Inserts the chosen quick-reply body at the current cursor position. */
  onPick: (body: string) => void;
  /** Sends a RICH quick reply (media / button) directly as a WhatsApp
   *  message — these can't be inserted into the textarea. */
  onSendRich?: (q: QuickReply) => void;
  /** Active chat's business number — scopes the list to snippets
   *  targeting this number (plus workspace-global ones). */
  phoneNumberId?: string | null;
  /** Render as a right-side full-height overlay drawer instead of a small
   *  button-anchored dropdown (escapes overflow/stacking in narrow panels). */
  overlay?: boolean;
}

export function isRichQuickReply(q: QuickReply): boolean {
  return !!(q.media_url?.trim() || (q.buttons && q.buttons.length > 0) || (q.button_text?.trim() && q.button_url?.trim()));
}

interface ApiResponse {
  quick_replies?: QuickReply[];
  error?: string;
}

export function QuickRepliesButton({ disabled, onPick, onSendRich, phoneNumberId = null, overlay }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<QuickReply[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const update = () => {
      if (wrapperRef.current) setAnchor(wrapperRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // Drop the cached list when the active number changes so the next
  // open refetches against the new number.
  useEffect(() => {
    setItems(null);
  }, [phoneNumberId]);

  useEffect(() => {
    if (!open || items !== null) return;
    const url = phoneNumberId
      ? `/api/quick-replies?phone_number_id=${encodeURIComponent(phoneNumberId)}`
      : "/api/quick-replies";
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as ApiResponse;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => setItems(j.quick_replies ?? []))
      .catch((e: Error) => setError(e.message));
  }, [open, items, phoneNumberId]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
      setOpen(false);
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

  function pick(q: QuickReply) {
    if (isRichQuickReply(q) && onSendRich) {
      onSendRich(q); // media / button → send directly, don't insert text
    } else {
      onPick(q.body);
    }
    setOpen(false);
  }

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <ComposerIconButton
        icon={List}
        label="Quick replies"
        active={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (overlay || anchor) ? createPortal(
        <>
          {overlay ? <div className="fixed inset-0 z-[59] bg-black/40" onClick={() => setOpen(false)} /> : null}
          <div
            ref={dropdownRef}
            style={
              overlay
                ? undefined
                : { position: "fixed", bottom: window.innerHeight - anchor!.top + 8, right: Math.max(8, window.innerWidth - anchor!.right) }
            }
            className={cn(
              "flex flex-col overflow-hidden border bg-card",
              overlay
                ? "fixed right-0 top-0 z-[60] h-full w-[420px] max-w-[92vw] border-l shadow-2xl animate-in slide-in-from-right"
                : "w-80 rounded-lg shadow-xl z-[60]",
            )}
          >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="text-xs font-semibold">Quick Replies</div>
            <span className="flex items-center gap-2">
              <Link
                href="/quick-replies"
                className="inline-flex items-center gap-1 rounded-md text-[10px] font-medium text-primary hover:underline"
                onClick={() => setOpen(false)}
                title="Manage quick replies"
              >
                <Plus className="h-3 w-3" />
                Manage
              </Link>
              {overlay ? (
                <button type="button" onClick={() => setOpen(false)} className="rounded p-0.5 text-muted-foreground hover:bg-secondary">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </span>
          </div>
          <div className={cn("overflow-auto", overlay ? "flex-1" : "max-h-72")}>
            {error ? (
              <div className="px-3 py-3 text-xs text-destructive">{error}</div>
            ) : items === null ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                No quick replies yet.
                <div className="mt-1">
                  <Link
                    href="/templates"
                    onClick={() => setOpen(false)}
                    className="text-primary hover:underline"
                  >
                    Create one →
                  </Link>
                </div>
              </div>
            ) : (
              <ul className="py-1">
                {items.map((q) => (
                  <li key={q.id}>
                    <button
                      type="button"
                      onClick={() => pick(q)}
                      className="flex w-full flex-col gap-0.5 px-3 py-2 text-left transition hover:bg-secondary"
                    >
                      <span className="flex items-center gap-1.5">
                        <code className="self-start rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-100">
                          /{q.shortcut}
                        </code>
                        {isRichQuickReply(q) ? (
                          <span className="rounded bg-violet-50 px-1 py-0.5 text-[9px] font-semibold text-violet-700 ring-1 ring-violet-200">
                            {q.media_url ? (q.media_kind === "video" ? "▶ video" : "🖼 image") : ""}{q.button_url ? " · button" : ""}
                          </span>
                        ) : null}
                      </span>
                      {q.media_url ? (
                        q.media_kind === "video" ? (
                          <video src={q.media_url} className="h-16 w-full rounded-md object-cover" muted />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={q.media_url} alt="" loading="lazy" className="h-16 w-full rounded-md object-cover" />
                        )
                      ) : null}
                      <span className="line-clamp-2 text-xs text-foreground/80">
                        {q.body}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
            Tip: type <code className="rounded bg-secondary px-1 font-mono">/shortcut</code> in the message box to insert.
          </div>
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  );
}
