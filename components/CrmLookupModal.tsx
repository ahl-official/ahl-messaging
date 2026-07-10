"use client";

// Cross-CRM lead lookup modal. Opened from the inbox search when the
// query is a phone / lead number — probes both CRM accounts and
// shows where the lead exists, with full details per CRM.

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { toneForStage } from "@/lib/chip-tones";
import { cn } from "@/lib/utils";

interface Lead {
  prospect_id: string;
  lead_number: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  age: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  created_on: string | null;
  owner_name: string | null;
  source: string | null;
  status: string | null;
  lead_url: string | null;
}

interface CrmResult {
  label: string;
  configured: boolean;
  found: boolean;
  lead: Lead | null;
  error?: string | null;
}

interface LookupResponse {
  resolved: boolean;
  query: string;
  resolvedFrom?: "phone" | "lead_number";
  wa_id?: string;
  primary?: CrmResult;
  secondary?: CrmResult;
  error?: string;
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function CrmLookupModal({
  query,
  onClose,
}: {
  query: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<LookupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which business number a NEWLY-created contact lands on. Without this the
  // contacts API silently defaults to WHATSAPP_PHONE_NUMBER_ID, dumping every
  // CRM-lookup lead onto one number. List template-capable numbers (Meta +
  // Interakt; Evolution can't open a closed-window chat anyway).
  const [numbers, setNumbers] = useState<{ phone_number_id: string; label: string }[]>([]);
  const [selectedNumber, setSelectedNumber] = useState("");
  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: Array<{ phone_number_id: string; provider?: string; is_active?: boolean; verified_name?: string; nickname?: string; display_phone_number?: string }> }) => {
        // Only the operator's toggled-ON (active) numbers, no Evolution.
        const usable = (j.numbers ?? []).filter((n) => n.provider !== "evolution" && n.is_active);
        setNumbers(
          usable.map((n) => ({
            phone_number_id: n.phone_number_id,
            label: n.nickname || n.verified_name || n.display_phone_number || n.phone_number_id,
          })),
        );
        // Default to the first active (currently-working) number.
        setSelectedNumber((cur) => cur || usable[0]?.phone_number_id || "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/lsq/lookup?q=${encodeURIComponent(query)}`, {
      cache: "no-store",
    })
      .then((r) => r.json() as Promise<LookupResponse>)
      .then((j) => {
        if (cancelled) return;
        if (j.error) setError(j.error);
        else setData(j);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Lookup failed — try again.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-hidden rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-violet-500" />
            <h3 className="truncate text-sm font-semibold">
              CRM lookup ·{" "}
              <span className="font-mono text-foreground/80">{query}</span>
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[calc(85vh-3rem)] overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching both CRMs…
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : data && !data.resolved ? (
            <div className="rounded-md border border-dashed bg-secondary/40 px-3 py-6 text-center text-[13px] text-muted-foreground">
              Couldn&apos;t turn{" "}
              <span className="font-mono text-foreground/80">{query}</span>{" "}
              into a number to look up. Search a full phone number, or a
              lead number that exists in a synced contact.
            </div>
          ) : data ? (
            <div className="space-y-3">
              {numbers.length > 0 ? (
                <label className="flex items-center gap-2 rounded-md border bg-secondary/30 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                  <span className="shrink-0">Open chat on number</span>
                  <select
                    value={selectedNumber}
                    onChange={(e) => setSelectedNumber(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                  >
                    {numbers.map((n) => (
                      <option key={n.phone_number_id} value={n.phone_number_id}>
                        {n.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <CrmBlock result={data.primary} onOpenChat={onClose} sendFromNumber={selectedNumber} />
              <CrmBlock result={data.secondary} onOpenChat={onClose} sendFromNumber={selectedNumber} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CrmBlock({
  result,
  onOpenChat,
  sendFromNumber,
}: {
  result: CrmResult | undefined;
  onOpenChat: () => void;
  /** Which business number a newly-created contact lands on (from the
   *  modal's picker). Without this the contacts API silently defaults to
   *  the Test number. */
  sendFromNumber?: string;
}) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  if (!result) return null;
  const { label, configured, found, lead } = result;
  const tone = lead?.status ? toneForStage(lead.status) : null;

  async function handleOpenChat() {
    if (!lead?.phone || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const digits = lead.phone.replace(/\D/g, "");
      // The same client can be stored with or without the country-code
      // prefix depending on which side wrote the row (Meta webhook always
      // stamps "91…", manual entries sometimes drop it). Build a set of
      // plausible forms and accept any wa_id ending in our last-10 digits.
      const last10 = digits.slice(-10);

      // Step 1 — look for any EXISTING contact on this phone across all
      // business numbers the operator can see. Multiple rows are normal
      // (one per bpid, per migration 0016) — prefer the one that actually
      // has chat messages so we never land the operator on an empty
      // ghost row when a real conversation exists on a different number.
      let id: string | null = null;
      try {
        const sr = await fetch(
          `/api/contacts/search?q=${encodeURIComponent(last10)}`,
          { cache: "no-store" },
        );
        if (sr.ok) {
          const sj = (await sr.json()) as {
            contacts?: Array<{
              id: string;
              wa_id: string;
              last_message_at: string | null;
              message_count?: number;
              business_phone_number_id?: string | null;
            }>;
          };
          const matches = (sj.contacts ?? []).filter((c) => {
            const w = c.wa_id ?? "";
            return w === digits || w === last10 || w.endsWith(last10);
          });
          if (matches.length > 0) {
            // The same client can have a contact row per business number
            // (Meta + Interakt etc.). Prefer the one on a number the
            // operator currently has toggled ON, so CRM-lookup opens the
            // chat for the number they're actually working in.
            let activeBpids = new Set<string>();
            try {
              const nr = await fetch("/api/business-numbers", { cache: "no-store" });
              if (nr.ok) {
                const nj = (await nr.json()) as {
                  numbers?: Array<{ phone_number_id: string; is_active: boolean }>;
                };
                activeBpids = new Set(
                  (nj.numbers ?? []).filter((n) => n.is_active).map((n) => n.phone_number_id),
                );
              }
            } catch {
              /* no active filter — fall back to message-count ranking */
            }
            // Priority: active-number row → most messages → most recent.
            matches.sort((a, b) => {
              const aActive = a.business_phone_number_id && activeBpids.has(a.business_phone_number_id) ? 1 : 0;
              const bActive = b.business_phone_number_id && activeBpids.has(b.business_phone_number_id) ? 1 : 0;
              if (aActive !== bActive) return bActive - aActive;
              const am = a.message_count ?? 0;
              const bm = b.message_count ?? 0;
              if (am !== bm) return bm - am;
              const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
              const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
              return bt - at;
            });
            id = matches[0].id;
          }
        }
      } catch {
        /* fall through to create */
      }

      // Step 2 — no match anywhere → create one on the default business
      // number. The contacts API upserts on (wa_id, bpid) so a re-click
      // here is still safe.
      if (!id) {
        const res = await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: lead.full_name?.trim() || `Lead #${lead.lead_number}`,
            phone: lead.phone,
            business_phone_number_id: sendFromNumber || undefined,
          }),
        });
        const j = (await res.json()) as { contact?: { id?: string }; error?: string };
        id = j.contact?.id ?? null;
        if (!res.ok || !id) {
          setOpenError(j.error ?? `HTTP ${res.status}`);
          return;
        }
      }

      // Hand the modal back to the parent, then navigate the URL so the
      // surface's URL-hydrator picks up the contact on mount. Inside the CRM
      // iframe the dashboard can't load (X-Frame-Options: DENY) — stay on
      // /embed/inbox, which honours the same ?c= param.
      onOpenChat();
      const url = new URL(window.location.href);
      url.pathname = window.location.pathname.startsWith("/embed")
        ? "/embed/inbox"
        : "/dashboard";
      url.searchParams.set("c", id);
      window.location.assign(url.toString());
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : "Open failed");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b bg-secondary/40 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {found ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
          ) : (
            <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[12px] font-semibold">{label}</span>
        </div>
        {lead?.lead_url ? (
          <a
            href={lead.lead_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Open in CRM"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>

      <div className="px-3.5 py-3">
        {!configured ? (
          <p className="text-[12px] text-muted-foreground">
            This CRM isn&apos;t connected.
          </p>
        ) : !found || !lead ? (
          <p className="text-[12px] text-muted-foreground">
            No lead found in this CRM for this number.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {lead.status && tone ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                    tone.bg,
                    tone.text,
                    tone.ring,
                  )}
                >
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", tone.dot)}
                  />
                  {lead.status}
                </span>
              ) : null}
              <span className="font-mono text-[11px] text-muted-foreground">
                #{lead.lead_number}
              </span>
            </div>
            <div className="space-y-0.5">
              <LookupRow label="Name" value={lead.full_name} />
              <LookupRow label="Email" value={lead.email} />
              <LookupRow
                label="Age"
                value={lead.age != null ? `${lead.age} yrs` : null}
              />
              <LookupRow
                label="City / State"
                value={
                  [lead.city, lead.state].filter((p) => p && p.trim()).join(", ") ||
                  null
                }
              />
              <LookupRow label="Country" value={lead.country} />
              <LookupRow label="Owner" value={lead.owner_name} />
              <LookupRow label="Source" value={lead.source} />
              <LookupRow label="Created" value={fmtDate(lead.created_on)} />
            </div>

            {/* Open-chat — creates/finds the contact for lead.phone and
                navigates the inbox to it. Disabled when the lead has no
                phone (LSQ row stored without one). */}
            <button
              type="button"
              onClick={handleOpenChat}
              disabled={!lead.phone || opening}
              className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
              title={lead.phone ? "Open chat with this lead" : "Lead has no phone on file"}
            >
              {opening ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MessageSquarePlus className="h-3.5 w-3.5" />
              )}
              {opening ? "Opening…" : lead.phone ? "Open chat" : "No phone on lead"}
            </button>
            {openError ? (
              <div className="text-[10px] text-rose-700">{openError}</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function LookupRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded px-1 py-1 hover:bg-secondary/50">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-[12px]",
          value ? "text-foreground" : "italic text-muted-foreground/60",
        )}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}
