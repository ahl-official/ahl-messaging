"use client";

// Composer ₹ icon → salon chooser (American Hairline / Alchemane) → payment dialog
// with two modes (Link / UPI). The dialog drops the message into the
// chat input only when the server-side QR send fails — when the QR
// bubble lands successfully, we just close and let polling refresh.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Hospital,
  IndianRupee,
  Link2,
  Loader2,
  QrCode,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ComposerIconButton } from "@/components/composer/ComposerIconButton";

type Clinic = "americanhairline" | "alchemane";
type Mode = "link" | "upi";

interface Props {
  contactId: string | null;
  disabled?: boolean;
  /** Drops the generated message into the chat input so the operator
   *  can preview / tweak / send. ChatWindow passes its setValue. */
  onPrefill: (text: string) => void;
}

export function PaymentLinkButton({ contactId, disabled, onPrefill }: Props) {
  const [open, setOpen] = useState(false);
  const [clinic, setClinic] = useState<Clinic | null>(null);

  function handleClose() {
    setOpen(false);
    setClinic(null);
  }

  return (
    <>
      <ComposerIconButton
        icon={IndianRupee}
        label="Send payment link"
        disabled={disabled || !contactId}
        onClick={() => setOpen(true)}
        className="text-primary hover:bg-primary/10 hover:text-primary"
      />
      {open && contactId && !clinic ? (
        <ClinicChooserDialog
          onPick={(c) => setClinic(c)}
          onClose={handleClose}
        />
      ) : null}
      {open && contactId && clinic === "americanhairline" ? (
        <PaymentLinkDialog
          contactId={contactId}
          clinic={clinic}
          onClose={handleClose}
          onPrefill={onPrefill}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------
// Salon chooser — first step. Alchemane is disabled until the operator
// integrates its own gateway account.
// ---------------------------------------------------------------------
function ClinicChooserDialog({
  onPick,
  onClose,
}: {
  onPick: (c: Clinic) => void;
  onClose: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-[440px] overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95">
        <div className="relative flex items-center justify-between border-b bg-gradient-to-r from-primary/10 via-white to-[#6098FF]/10 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-[#6098FF] to-[#6098FF] text-white shadow-sm ring-1 ring-inset ring-white/40">
              <Hospital className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-[15px] font-bold leading-tight text-foreground">
                Choose clinic
              </h3>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Payment kis brand se collect karna hai?
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 p-5">
          <button
            type="button"
            onClick={() => onPick("americanhairline")}
            className="group flex flex-col items-start gap-2 rounded-xl border border-primary/25 bg-primary/10 p-4 text-left transition hover:border-primary/40 hover:bg-primary/10"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white">
              <Hospital className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-bold text-primary">American Hairline</div>
              <div className="text-[10.5px] text-primary">
                Integrated · Link / UPI
              </div>
            </div>
          </button>

          <div
            aria-disabled
            className="flex cursor-not-allowed flex-col items-start gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-left opacity-70"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-300 text-white">
              <Hospital className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-bold text-slate-700">Alchemane</div>
              <div className="mt-0.5 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0 text-[9.5px] font-bold uppercase tracking-wide text-amber-800">
                Coming soon
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------
// Payment dialog — amount + description + Link/UPI toggle. UPI mode
// adds VPA + payee name. On submit, the server generates a QR (link or
// UPI deeplink) and sends it to the chat.
// ---------------------------------------------------------------------
function PaymentLinkDialog({
  contactId,
  clinic,
  onClose,
  onPrefill,
}: {
  contactId: string;
  clinic: Clinic;
  onClose: () => void;
  onPrefill: (text: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("link");
  const [amount, setAmount] = useState<string>("");
  const [description, setDescription] = useState<string>("Consultation fee");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const rupees = Number(amount.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setErr("Amount ₹ mein daalo, 0 se zyada.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/payments/create-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          amount: rupees,
          description: description.trim() || null,
          mode,
          clinic,
        }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        message_text?: string | null;
        qr_sent?: boolean;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      if (j.qr_sent) {
        onClose();
        return;
      }
      if (j.message_text) {
        onPrefill(j.message_text);
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const PRESETS = [500, 1000, 5000, 10000, 25000, 50000];

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        onSubmit={handleGenerate}
        className="relative w-full max-w-[460px] overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95"
      >
        <div className="relative flex items-center justify-between border-b bg-gradient-to-r from-primary/10 via-white to-[#6098FF]/10 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-[#6098FF] to-[#6098FF] text-white shadow-sm ring-1 ring-inset ring-white/40">
              <IndianRupee className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-[15px] font-bold leading-tight text-foreground">
                American Hairline · Send payment
              </h3>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Link bhejo ya direct UPI QR — client ke hisaab se choose karo.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary/40 p-1">
            <button
              type="button"
              onClick={() => setMode("link")}
              disabled={busy}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition",
                mode === "link"
                  ? "bg-card text-primary shadow-sm ring-1 ring-primary/25"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Link2 className="h-3.5 w-3.5" />
              Payment Link
            </button>
            <button
              type="button"
              onClick={() => setMode("upi")}
              disabled={busy}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition",
                mode === "upi"
                  ? "bg-card text-primary shadow-sm ring-1 ring-primary/25"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <QrCode className="h-3.5 w-3.5" />
              UPI QR
            </button>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-foreground">
              Amount (₹)
            </label>
            <div className="flex h-11 items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/40">
              <span className="text-base font-bold text-muted-foreground">₹</span>
              <input
                ref={amountRef}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0"
                inputMode="decimal"
                className="min-w-0 flex-1 bg-transparent text-sm font-mono outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(String(p))}
                  className={cn(
                    "rounded-full border border-input bg-background px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground transition hover:bg-primary/10 hover:text-primary",
                    Number(amount) === p &&
                      "border-primary/30 bg-primary/10 text-primary",
                  )}
                >
                  ₹{p.toLocaleString("en-IN")}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-foreground">
              Description{" "}
              <span className="text-[10px] font-medium text-muted-foreground">
                (optional)
              </span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Consultation fee, Surgery booking, etc."
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-primary/25/80 bg-primary/10 px-3 py-2 text-[11.5px] leading-relaxed text-primary">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <div>
              {mode === "link"
                ? "Link generate hote hi QR + caption chat mein chala jayega. Client scan/click karke pay karega — webhook se auto receipt ban jayega."
                : "PayU se UPI QR generate hoga — scan karte hi GPay/Paytm/PhonePe khulega. Payment milte hi status auto Paid ho jayega aur receipt khud bhej dega."}
            </div>
          </div>

          {err ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11.5px] font-medium text-rose-700">
              {err}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !amount}
            className="group relative inline-flex items-center gap-1.5 overflow-hidden rounded-lg bg-gradient-to-r from-[#6098FF] to-[#6098FF] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:shadow-lg disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : mode === "upi" ? (
              <QrCode className="h-3.5 w-3.5" />
            ) : (
              <IndianRupee className="h-3.5 w-3.5" />
            )}
            {busy
              ? "Generating…"
              : mode === "upi"
                ? "Generate UPI QR"
                : "Generate link"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
