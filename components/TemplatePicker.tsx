"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, LayoutTemplate, RefreshCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ComposerIconButton } from "@/components/composer/ComposerIconButton";

export interface TemplateSummary {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  header_text: string | null;
  header_format: string | null;
  /** Public URL of the header media when format is IMAGE/VIDEO/DOCUMENT.
   *  Cached server-side in `template_assets`. Null for text-only headers
   *  or templates created before we started caching. */
  header_url: string | null;
  body: string;
  footer: string | null;
  /** Buttons attached to the template (Quick Reply / URL / Phone / Copy code). */
  buttons: Array<{
    type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
    text?: string;
    url?: string;
    phone_number?: string;
    example?: string | string[];
  }> | null;
}

interface ApiResponse {
  templates: TemplateSummary[];
  business_account_id?: string;
}

interface Props {
  disabled?: boolean;
  onSelect: (template: TemplateSummary) => void | Promise<void>;
  /** Contact's business_phone_number_id. Scopes the picker to the
   *  portfolio that owns this number so templates from sibling
   *  portfolios don't leak in. Omit when the picker isn't tied to a
   *  specific chat (e.g. workspace-wide preview). */
  phoneNumberId?: string | null;
  /** Render as a right-side full-height overlay drawer (with backdrop) instead
   *  of a button-anchored dropdown — used inside narrow panels like the
   *  bird's-eye wall where a small dropdown gets cramped/clipped. */
  overlay?: boolean;
}

const STATUS_BADGE: Record<string, string> = {
  APPROVED: "bg-primary/15 text-primary",
  PENDING: "bg-amber-100 text-amber-800",
  REJECTED: "bg-red-100 text-red-800",
  PAUSED: "bg-slate-200 text-slate-700",
  IN_APPEAL: "bg-amber-100 text-amber-800",
};

export function TemplatePicker({ disabled, onSelect, phoneNumberId, overlay }: Props) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [wabaId, setWabaId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Anchor rect for the portaled dropdown — lets it escape the composer's
  // overflow / stacking context (needed in the bird's-eye wall).
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const update = () => {
      if (panelRef.current) setAnchor(panelRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  function load() {
    setLoading(true);
    setError(null);
    const url = phoneNumberId
      ? `/api/templates?phone_number_id=${encodeURIComponent(phoneNumberId)}`
      : "/api/templates";
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as ApiResponse & { error?: string };
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((data) => {
        setTemplates(data.templates);
        setWabaId(data.business_account_id ?? null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  // When the operator switches to a chat under a different number, the
  // cached templates from the previous portfolio would otherwise stick.
  // Reset on bpid change so the next open() refetches scoped to the new
  // portfolio.
  useEffect(() => {
    setTemplates(null);
    setError(null);
  }, [phoneNumberId]);

  useEffect(() => {
    if (open && !templates && !loading) load();
  }, [open, templates, loading]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
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

  const filtered =
    templates && query
      ? templates.filter(
          (t) =>
            t.name.toLowerCase().includes(query.toLowerCase()) ||
            t.body.toLowerCase().includes(query.toLowerCase()),
        )
      : templates;

  const createUrl = wabaId
    ? `https://business.facebook.com/wa/manage/message-templates/?waba_id=${wabaId}`
    : "https://business.facebook.com/wa/manage/message-templates/";

  return (
    <div className="relative" ref={panelRef}>
      <ComposerIconButton
        icon={LayoutTemplate}
        label="Templates"
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
                : { position: "fixed", bottom: window.innerHeight - anchor!.top + 8, right: Math.max(8, window.innerWidth - anchor!.right), maxHeight: anchor!.top - 16 }
            }
            className={cn(
              "flex flex-col overflow-hidden border bg-card",
              overlay
                ? "fixed right-0 top-0 z-[60] h-full w-[420px] max-w-[92vw] border-l shadow-2xl animate-in slide-in-from-right"
                : "w-[380px] max-w-[calc(100vw-2rem)] rounded-lg shadow-xl z-[60] animate-in fade-in-0 zoom-in-95",
            )}
          >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="text-sm font-semibold">WhatsApp templates</div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={load}
                disabled={loading}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                aria-label="Reload templates"
                title="Reload from Meta"
              >
                <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="border-b p-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates…"
              className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* List */}
          <div className={cn("overflow-y-auto", overlay ? "flex-1" : "max-h-80")}>
            {loading ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                Loading templates…
              </div>
            ) : error ? (
              <div className="p-4 text-sm text-destructive">
                <div className="font-semibold">Couldn&apos;t load templates</div>
                <div className="mt-1 text-xs opacity-80">{error}</div>
                <button
                  type="button"
                  onClick={load}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <RefreshCcw className="h-3 w-3" />
                  Try again
                </button>
              </div>
            ) : !filtered || filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {query
                  ? "No matches."
                  : templates?.length === 0
                    ? "No templates in this account yet."
                    : "Nothing here."}
              </div>
            ) : (
              <ul className="divide-y">
                {filtered.map((t) => {
                  const usable = t.status === "APPROVED";
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        disabled={!usable}
                        onClick={async () => {
                          if (!usable) return;
                          await onSelect(t);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex w-full flex-col gap-1 px-3 py-2 text-left transition",
                          usable ? "hover:bg-secondary" : "opacity-60 cursor-not-allowed",
                        )}
                        title={
                          usable ? "Send this template" : `Status: ${t.status} — not sendable yet`
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{t.name}</span>
                          <span className="flex items-center gap-1 shrink-0">
                            <span
                              className={cn(
                                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                                STATUS_BADGE[t.status] ?? "bg-secondary text-muted-foreground",
                              )}
                            >
                              {t.status}
                            </span>
                            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                              {t.language}
                            </span>
                          </span>
                        </div>
                        {t.header_url && t.header_format === "IMAGE" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={t.header_url}
                            alt=""
                            className="h-14 w-full rounded-md object-cover"
                            loading="lazy"
                          />
                        ) : null}
                        {t.header_text ? (
                          <div className="text-[11px] font-semibold text-muted-foreground">
                            {t.header_text}
                          </div>
                        ) : null}
                        <p className="line-clamp-2 text-xs text-foreground/80 whitespace-pre-wrap">
                          {t.body}
                        </p>
                        {t.footer ? (
                          <p className="text-[10px] text-muted-foreground italic">{t.footer}</p>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer — link to Meta to create more */}
          <div className="border-t bg-secondary/40 px-3 py-2">
            <a
              href={createUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Create / manage templates in Meta Business Manager
            </a>
          </div>
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  );
}
