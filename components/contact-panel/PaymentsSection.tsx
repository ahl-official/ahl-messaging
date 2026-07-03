"use client";

// Payments section in the Contact Details panel. Lists every payment
// row for this contact, newest first, with a "Send receipt" button on
// each paid row that hasn't been sent yet.

import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  ExternalLink,
  IndianRupee,
  Loader2,
  Send,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PaymentRow {
  id: string;
  amount_minor: number;
  currency: string;
  description: string | null;
  short_url: string | null;
  status:
    | "created"
    | "sent"
    | "paid"
    | "cancelled"
    | "expired"
    | "failed";
  paid_at: string | null;
  receipt_url: string | null;
  receipt_sent_at: string | null;
  created_by: string | null;
  created_at: string;
}

export function PaymentsSection({ contactId }: { contactId: string }) {
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Collapsed by default — show only the newest payment; the rest sit behind
  // a "Show all" toggle so the panel doesn't get long with many payments.
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/payments?contact_id=${encodeURIComponent(contactId)}`,
        { cache: "no-store" },
      );
      const j = (await res.json()) as { payments?: PaymentRow[]; error?: string };
      if (!res.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setRows(j.payments ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }, [contactId]);

  useEffect(() => {
    void load();
    // Light polling: a payment goes paid via Razorpay webhook, the panel
    // should reflect it within ~10s without a manual refresh.
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function handleSendReceipt(paymentId: string) {
    setSendingId(paymentId);
    try {
      const res = await fetch(
        `/api/payments/${encodeURIComponent(paymentId)}/send-receipt`,
        { method: "POST" },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
      } else {
        await load();
      }
    } finally {
      setSendingId(null);
    }
  }

  async function handleMarkPaid(paymentId: string) {
    if (
      !window.confirm(
        "Client ne payment kar di hai confirm? Status 'Paid' ho jayega aur (auto-receipt ON hai to) receipt PDF chat mein chala jayega.",
      )
    ) {
      return;
    }
    setMarkingId(paymentId);
    try {
      const res = await fetch(
        `/api/payments/${encodeURIComponent(paymentId)}/mark-paid`,
        { method: "POST" },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
      } else {
        await load();
      }
    } finally {
      setMarkingId(null);
    }
  }

  async function handleCopy(url: string, id: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard may be blocked — ignore */
    }
  }

  if (rows === null) {
    return (
      <SectionShell>
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading payments…
        </div>
      </SectionShell>
    );
  }
  if (rows.length === 0) {
    return (
      <SectionShell>
        <div className="py-2 text-[11.5px] text-muted-foreground">
          No payment links sent yet. Use the ₹ icon in the chat composer to
          create one.
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell>
      {err ? (
        <div className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
          {err}
        </div>
      ) : null}
      <ul className="divide-y">
        {(expanded ? rows : rows.slice(0, 1)).map((r) => {
          const rupees = (r.amount_minor / 100).toLocaleString("en-IN");
          const isPaid = r.status === "paid";
          const isClosed =
            r.status === "cancelled" || r.status === "expired" || r.status === "failed";
          return (
            <li key={r.id} className="py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-emerald-100 text-emerald-700">
                      <IndianRupee className="h-3 w-3" />
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      ₹{rupees}
                    </span>
                    <StatusPill status={r.status} />
                  </div>
                  {r.description ? (
                    <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {r.description}
                    </div>
                  ) : null}
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                    {r.created_by ? ` · ${r.created_by}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {r.short_url ? (
                    <a
                      href={r.short_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700 hover:underline"
                    >
                      Open <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                  {r.short_url ? (
                    <button
                      type="button"
                      onClick={() => handleCopy(r.short_url!, r.id)}
                      className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-muted-foreground hover:text-foreground"
                    >
                      {copiedId === r.id ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-600" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" /> Copy link
                        </>
                      )}
                    </button>
                  ) : null}
                </div>
              </div>

              {r.status === "created" || r.status === "sent" ? (
                <button
                  type="button"
                  onClick={() => handleMarkPaid(r.id)}
                  disabled={markingId === r.id}
                  className={cn(
                    "mt-2 inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-0.5 text-[10.5px] font-semibold text-white shadow-sm transition hover:bg-amber-700 disabled:opacity-50",
                  )}
                >
                  {markingId === r.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <BadgeCheck className="h-3 w-3" />
                  )}
                  Mark as paid
                </button>
              ) : null}
              {isPaid && !r.receipt_sent_at ? (
                <button
                  type="button"
                  onClick={() => handleSendReceipt(r.id)}
                  disabled={sendingId === r.id}
                  className={cn(
                    "mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[10.5px] font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50",
                  )}
                >
                  {sendingId === r.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                  Send receipt
                </button>
              ) : null}
              {isPaid && r.receipt_sent_at ? (
                <div className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-emerald-700">
                  <Check className="h-3 w-3" /> Receipt sent{" "}
                  {new Date(r.receipt_sent_at).toLocaleString()}
                </div>
              ) : null}
              {isClosed ? null : null}
            </li>
          );
        })}
      </ul>
      {rows.length > 1 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[11px] font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          {expanded ? (
            <>
              Show less <ChevronUp className="h-3 w-3" />
            </>
          ) : (
            <>
              Show all {rows.length} <ChevronDown className="h-3 w-3" />
            </>
          )}
        </button>
      ) : null}
    </SectionShell>
  );
}

function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card px-3 py-2.5 shadow-sm">
      <header className="mb-1.5 flex items-center gap-1.5">
        <IndianRupee className="h-3.5 w-3.5 text-emerald-600" />
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Payments
        </h3>
      </header>
      {children}
    </section>
  );
}

function StatusPill({ status }: { status: PaymentRow["status"] }) {
  const map: Record<
    PaymentRow["status"],
    { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }
  > = {
    created: {
      label: "Created",
      cls: "bg-slate-100 text-slate-700",
      icon: Clock,
    },
    sent: {
      label: "Sent",
      cls: "bg-sky-100 text-sky-700",
      icon: Send,
    },
    paid: {
      label: "Paid",
      cls: "bg-emerald-100 text-emerald-800",
      icon: Check,
    },
    cancelled: {
      label: "Cancelled",
      cls: "bg-slate-100 text-slate-600",
      icon: XCircle,
    },
    expired: {
      label: "Expired",
      cls: "bg-amber-100 text-amber-800",
      icon: Clock,
    },
    failed: {
      label: "Failed",
      cls: "bg-rose-100 text-rose-700",
      icon: XCircle,
    },
  };
  const p = map[status];
  const Icon = p.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[9.5px] font-bold uppercase tracking-wide",
        p.cls,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {p.label}
    </span>
  );
}
